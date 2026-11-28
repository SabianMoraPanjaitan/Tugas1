"""/api/satusehat/*: the SATUSEHAT (Kemenkes FHIR) bridge, same URLs and answers as the old backend.

send-study is the viewer's **Finalize**. With `archive_id` (MyPACS always sends it):
  1. the study row is locked, so two radiologists pressing Finalize at once cannot send it twice;
  2. patient, exam and modality come from the archive (the database), not from the browser;
  3. the radiology chain goes to SATUSEHAT (live, or mock without credentials);
  4. only if SATUSEHAT accepted it: the report becomes final (a new version), the study 'final',
     the request 'reported', all in one commit. A failed send changes nothing but the audit log.
The lock is held while SATUSEHAT answers (a few seconds; the client's timeouts are 20-30 s per call).
That only blocks other writes to this one study, which is the point.

The endpoints are plain `def`; the async SATUSEHAT client is run with anyio.from_thread.run, so the
database work stays off the event loop.
"""
from anyio import from_thread
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.modules.archive.models import Study
from app.modules.audit.service import record
from app.modules.auth.deps import require_roles
from app.modules.auth.models import User
from app.modules.auth.roles import ADMIN, ARCHIVE_READ, REPORTERS
from app.modules.orders import service as orders
from app.modules.orders.models import Order
from app.modules.patients.models import Patient
from app.modules.patients.service import SEX_TO_GENDER, get_by_nik
from app.modules.reports import service as reports
from app.modules.satusehat.client import client as sehat

router = APIRouter(prefix="/api/satusehat", tags=["satusehat"])


class SendStudyBody(BaseModel):
    archive_id: str | None = None
    name: str | None = ""
    nik: str | None = ""
    modality: str | None = ""
    description: str | None = ""
    icd10: str | None = ""
    diagnosis: str | None = ""
    finding: str | None = ""
    instalasi: str | None = ""


def _failed_step(result: dict) -> str | None:
    """The first step SATUSEHAT did not accept (for the audit log)."""
    for log in result.get("logs", []):
        try:
            if int(log.get("status") or 0) >= 300:
                return log.get("step")
        except (TypeError, ValueError):
            return log.get("step")
    return None


@router.post("/send-study")
def send_study(body: SendStudyBody, request: Request, user: User = Depends(require_roles(*REPORTERS)),
               db: Session = Depends(get_db)):
    """Build Encounter -> ServiceRequest -> ImagingStudy -> Observation -> DiagnosticReport and POST them.
    Returns {ok, mode, logs, imaging_study_id, diagnostic_report_id} (the step log feeds the API console)."""
    reading = {key: str(getattr(body, key) or "").strip() for key in reports.LIMITS}
    for key, most in reports.LIMITS.items():
        if len(reading[key]) > most:
            raise HTTPException(status_code=400, detail=f"{key} terlalu panjang (maks. {most} huruf)")

    study = None
    payload = {**body.model_dump(exclude={"archive_id"}), **reading}
    payload = {k: (v or "") for k, v in payload.items()}
    if body.archive_id:
        try:
            study = db.get(Study, int(body.archive_id), with_for_update=True)
        except ValueError:
            study = None
        if study is None:
            raise HTTPException(status_code=404, detail="Studi tidak ditemukan")
        if study.status in ("final", "amended"):
            # sending again would create a second set of records in SATUSEHAT
            raise HTTPException(status_code=409, detail="Studi ini sudah dibaca dan dikirim ke SATUSEHAT")
        patient = db.get(Patient, study.patient_id)
        order = db.get(Order, study.order_id) if study.order_id else None
        payload.update(name=patient.name, nik=patient.nik or "", ihs=patient.ihs_number or "",
                       gender=SEX_TO_GENDER.get(patient.sex or "", ""),
                       modality=(order.modality if order else (study.modalities or [""])[0]) or payload["modality"],
                       description=study.description or payload["description"])
    else:
        registered = get_by_nik(db, payload["nik"])
        if registered is not None and registered.ihs_number:
            payload["ihs"] = registered.ihs_number           # the patient's own SATUSEHAT record

    result = from_thread.run(sehat.send_study, payload)

    patient_id = study.patient_id if study is not None else None
    if result.get("ok") and study is not None:
        reports.finalize(db, study, user, reading, diagnostic_report_id=result.get("diagnostic_report_id", ""))
        study.satusehat_imaging_study_id = result.get("imaging_study_id") or None
        if study.order_id:
            orders.set_reported(db, study.order_id)
    record(db, "send_study" if result.get("ok") else "send_study_failed", request=request, user=user,
           entity_type="study" if study is not None else None, entity_id=study.id if study is not None else None,
           patient_id=patient_id, detail={"mode": result.get("mode"),
                                          "imaging_study_id": result.get("imaging_study_id", ""),
                                          "diagnostic_report_id": result.get("diagnostic_report_id", ""),
                                          "failed_step": _failed_step(result)})
    db.commit()
    return result


@router.get("/patient")
def search_patient(nik: str, user: User = Depends(require_roles(*ARCHIVE_READ))):
    return from_thread.run(sehat.search_patient, nik.strip())


@router.post("/token")
def token(user: User = Depends(require_roles(*ADMIN))):
    return from_thread.run(sehat.get_token)


@router.post("/imaging-study")
def imaging_study(payload: dict, user: User = Depends(require_roles(*ADMIN))):
    """Admin-only raw passthrough, kept for the old API console."""
    return from_thread.run(sehat.create, "ImagingStudy", payload)


@router.post("/diagnostic-report")
def diagnostic_report(payload: dict, user: User = Depends(require_roles(*ADMIN))):
    """Admin-only raw passthrough, kept for the old API console."""
    return from_thread.run(sehat.create, "DiagnosticReport", payload)
