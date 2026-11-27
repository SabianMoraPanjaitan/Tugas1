"""Radiology request rules.

Public id: the accession number (e.g. "RQ-261127-4F2A"). It is what the pages show and put in URLs,
and the same value goes into the DICOM AccessionNumber of the images, linking request and study.

`to_public` returns the old backend's shape ({id, created, updated, created_by, status, study_id,
data: {patient, exam, indication, priority, note, requester, unit?, returned?}, study}) so the pages work unchanged.
"""
import secrets
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from app.modules.archive.models import Study
from app.modules.auth.models import User
from app.modules.orders.models import Order
from app.modules.patients.models import Patient
from app.modules.patients.service import order_patient
from app.modules.reports.models import Report

# The pages send / expect the old Indonesian priority labels; the database stores ROUTINE / STAT.
PRIORITY_IN = {"Biasa": "ROUTINE", "CITO": "STAT", "ROUTINE": "ROUTINE", "STAT": "STAT"}
PRIORITY_OUT = {"ROUTINE": "Biasa", "STAT": "CITO"}


class NotRequested(Exception):
    """The request is no longer waiting for images (already imaged, reported or returned)."""


def _iso(value: datetime | None) -> str | None:
    return value.isoformat(timespec="seconds") if value else None


def _study_summary(study: Study | None, report: Report | None, reporter: str | None) -> dict | None:
    """The study block the pages show on a request (old keys). Filled once the archive module stores studies."""
    if study is None:
        return None
    sent = study.status in ("final", "amended")
    reading = report if (report is not None and sent) else None
    return {"id": str(study.id), "file": None, "created": _iso(study.created_at),
            "modality": (study.modalities or [None])[0], "sent": sent,
            "icd10": reading.icd10 if reading else "", "diagnosis": reading.impression if reading else "",
            "finding": reading.findings if reading else "", "reported_by": reporter if reading else None}


def _query():
    requester, returner, reporter = aliased(User), aliased(User), aliased(User)
    return (select(Order, Patient, requester, returner, Study, Report, reporter.username)
            .join(Patient, Patient.id == Order.patient_id)
            .join(requester, requester.id == Order.requested_by)
            .outerjoin(returner, returner.id == Order.returned_by)
            .outerjoin(Study, Study.order_id == Order.id)
            .outerjoin(Report, Report.study_id == Study.id)
            .outerjoin(reporter, reporter.id == Report.author_id)
            # re-read rows even if this session already holds them (status may have just changed via UPDATE)
            .execution_options(populate_existing=True))


def _public(row) -> dict:
    order, patient, requester, returner, study, report, reporter = row
    data = {
        "patient": order_patient(patient),
        "exam": {"modality": order.modality, "description": order.exam_description},
        "indication": {"icd10": order.indication_icd10 or "", "text": order.indication_text or ""},
        "priority": PRIORITY_OUT.get(order.priority, order.priority),
        "note": order.note or "",
        "requester": requester.full_name,
    }
    if order.requesting_unit:
        data["unit"] = order.requesting_unit
    if order.status == "returned":
        data["returned"] = {"reason": order.returned_reason, "at": _iso(order.returned_at),
                            "by": (returner.full_name or returner.username) if returner else ""}
    return {"id": order.accession_number, "created": _iso(order.created_at), "updated": _iso(order.updated_at),
            "created_by": requester.username, "status": order.status,
            "study_id": str(study.id) if study else None, "data": data,
            "study": _study_summary(study, report, reporter)}


def list_orders(db: Session, status: str | None = None, nik: str | None = None,
                limit: int = 500, offset: int = 0) -> list[dict]:
    stmt = _query()
    if status:
        stmt = stmt.where(Order.status == status)
    if nik:
        stmt = stmt.where(Patient.nik == nik)
    stmt = stmt.order_by(Order.created_at.desc(), Order.id.desc()).limit(limit).offset(offset)
    return [_public(row) for row in db.execute(stmt)]


def get_order(db: Session, accession: str) -> dict | None:
    row = db.execute(_query().where(Order.accession_number == accession)).first()
    return _public(row) if row else None


def get_order_row(db: Session, accession: str) -> Order | None:
    return db.scalar(select(Order).where(Order.accession_number == accession))


def _new_accession() -> str:
    # 14 characters; DICOM allows 16. 65,536 possible codes per day, so a clash is rare and retried below.
    return "RQ-" + datetime.now().strftime("%y%m%d") + "-" + secrets.token_hex(2).upper()


def create_order(db: Session, *, patient: Patient, modality: str, description: str, priority: str,
                 indication_icd10: str, indication_text: str, note: str, unit: str, user: User) -> Order:
    for _ in range(5):
        order = Order(accession_number=_new_accession(), patient_id=patient.id, modality=modality,
                      exam_description=description, priority=priority, indication_icd10=indication_icd10 or None,
                      indication_text=indication_text or None, note=note or None, requesting_unit=unit or None,
                      requested_by=user.id)
        try:
            with db.begin_nested():
                db.add(order)
                db.flush()
            return order
        except IntegrityError:
            continue          # accession number already taken: draw another
    raise RuntimeError("could not allocate an accession number")


def _set_status(db: Session, accession: str, values: dict) -> None:
    """Change a request that is still 'requested'. The WHERE makes it atomic: if two people act at once,
    only the first wins and the second gets NotRequested."""
    result = db.execute(update(Order)
                        .where(Order.accession_number == accession, Order.status == "requested")
                        .values(updated_at=datetime.now(timezone.utc), **values))
    if result.rowcount != 1:
        raise NotRequested(accession)


def set_returned(db: Session, accession: str, reason: str, user: User) -> None:
    _set_status(db, accession, {"status": "returned", "returned_reason": reason, "returned_by": user.id,
                                "returned_at": datetime.now(timezone.utc)})


def set_imaged(db: Session, accession: str) -> None:
    """Called by the archive module when the first images for this request arrive."""
    _set_status(db, accession, {"status": "imaged"})


def set_reported(db: Session, order_id: int) -> None:
    """Called by the reports module when the reading is finalised."""
    db.execute(update(Order).where(Order.id == order_id)
               .values(status="reported", updated_at=datetime.now(timezone.utc)))

