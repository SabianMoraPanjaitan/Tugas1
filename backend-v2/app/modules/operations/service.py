"""Instalasi Bedah rules: save an operation (schedule + report), list them, mark one sent.

Public id: the code, e.g. "OP-261127-4F2A". `to_public` returns the old backend's shape:
{id, created, updated, created_by, status, encounter_id, procedure_id, data: {patient, schedule, report}}.
A sent operation is read-only (a new report must be made instead), as before.
"""
import secrets
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.modules.auth.models import User
from app.modules.operations.models import Operation
from app.modules.patients.models import Patient
from app.modules.patients.service import order_patient


class AlreadySent(Exception):
    pass


def _iso(value):
    return value.isoformat(timespec="seconds") if value else None


def to_public(op: Operation, patient: Patient, created_by: str | None) -> dict:
    return {"id": op.code, "created": _iso(op.created_at), "updated": _iso(op.updated_at), "created_by": created_by,
            "status": op.status, "encounter_id": op.satusehat_encounter_id, "procedure_id": op.satusehat_procedure_id,
            "data": {"patient": order_patient(patient), "schedule": op.schedule or {}, "report": op.report or {}}}


def _rows(db: Session):
    return (select(Operation, Patient, User.username)
            .join(Patient, Patient.id == Operation.patient_id)
            .join(User, User.id == Operation.created_by)
            .execution_options(populate_existing=True))


def list_operations(db: Session, limit: int = 500, offset: int = 0) -> list[dict]:
    stmt = _rows(db).order_by(Operation.updated_at.desc(), Operation.id.desc()).limit(limit).offset(offset)
    return [to_public(*row) for row in db.execute(stmt)]


def get_public(db: Session, code: str) -> dict | None:
    row = db.execute(_rows(db).where(Operation.code == code)).first()
    return to_public(*row) if row else None


def get_locked(db: Session, code: str) -> Operation | None:
    return db.scalar(select(Operation).where(Operation.code == code).with_for_update()) if code else None


def _new_code() -> str:
    return "OP-" + datetime.now().strftime("%y%m%d") + "-" + secrets.token_hex(2).upper()


def save_operation(db: Session, code: str | None, *, patient: Patient, schedule: dict, report: dict,
                   user: User) -> Operation:
    """Update an unsent operation (known code), otherwise create a new one."""
    op = get_locked(db, code or "")
    if op is not None:
        if op.status == "sent":
            raise AlreadySent(code)
        op.patient_id, op.schedule, op.report = patient.id, schedule, report
        op.updated_at = datetime.now(timezone.utc)
        db.flush()
        return op
    for _ in range(5):
        op = Operation(code=_new_code(), patient_id=patient.id, schedule=schedule, report=report, created_by=user.id)
        try:
            with db.begin_nested():
                db.add(op)
                db.flush()
            return op
        except IntegrityError:
            continue                    # code already taken today: draw another
    raise RuntimeError("could not allocate an operation code")


def mark_sent(db: Session, op: Operation, encounter_id: str, procedure_id: str) -> None:
    op.status, op.satusehat_encounter_id, op.satusehat_procedure_id = "sent", encounter_id or None, procedure_id or None
    op.updated_at = datetime.now(timezone.utc)
    db.flush()
