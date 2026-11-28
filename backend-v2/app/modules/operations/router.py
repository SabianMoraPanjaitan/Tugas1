"""/api/operations and /api/satusehat/send-procedure (Instalasi Bedah). Same URLs, bodies, answers and
error texts as the old backend; send-procedure lives here because it is part of the operation workflow."""
import json
from typing import Any

from anyio import from_thread
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.modules.audit.service import record
from app.modules.auth.deps import require_roles
from app.modules.auth.models import User
from app.modules.auth.roles import BEDAH
from app.modules.operations import service
from app.modules.patients.models import Patient
from app.modules.patients.service import get_by_nik, order_patient
from app.modules.satusehat.client import client as sehat

router = APIRouter(tags=["operations"])

MAX_FORM_CHARS = 50_000        # schedule + report as JSON; the forms are a few hundred characters


class OperationBody(BaseModel):
    id: str | None = None
    patient: dict[str, Any] | None = None
    schedule: dict[str, Any] | None = None
    report: dict[str, Any] | None = None


class SendProcedureBody(BaseModel):
    operation_id: str | None = ""


@router.get("/api/operations")
def list_operations(request: Request, limit: int = Query(500, ge=1, le=1000), offset: int = Query(0, ge=0),
                    user: User = Depends(require_roles(*BEDAH)), db: Session = Depends(get_db)):
    rows = service.list_operations(db, limit, offset)
    record(db, "list_operations", request=request, user=user, detail={"count": len(rows)})
    return rows


@router.post("/api/operations")
def save_operation(body: OperationBody, request: Request, user: User = Depends(require_roles(*BEDAH)),
                   db: Session = Depends(get_db)):
    """Create or update an operation. body: {id?, patient: {nik, ...}, schedule, report}.
    The patient must be registered; their identity is taken from the registry."""
    schedule, report = body.schedule or {}, body.report or {}
    if len(json.dumps(schedule)) + len(json.dumps(report)) > MAX_FORM_CHARS:
        raise HTTPException(status_code=400, detail="Isi jadwal / laporan operasi terlalu panjang")
    patient = get_by_nik(db, str((body.patient or {}).get("nik") or "").strip())
    if patient is None:
        raise HTTPException(status_code=400, detail="Pasien belum terdaftar. Daftarkan pasien terlebih dulu")
    try:
        op = service.save_operation(db, body.id, patient=patient, schedule=schedule, report=report, user=user)
    except service.AlreadySent:
        raise HTTPException(status_code=409, detail="Operasi sudah dikirim ke SATUSEHAT; buat laporan baru")
    record(db, "save_operation", request=request, user=user, entity_type="operation", entity_id=op.code,
           patient_id=patient.id)
    db.commit()
    return service.get_public(db, op.code)


@router.post("/api/satusehat/send-procedure")
def send_procedure(body: SendProcedureBody, request: Request, user: User = Depends(require_roles(*BEDAH)),
                   db: Session = Depends(get_db)):
    """Send a saved operation as Encounter + Procedure. body: {operation_id}.
    The row is locked while SATUSEHAT answers, so it cannot be sent twice."""
    op = service.get_locked(db, (body.operation_id or "").strip())
    if op is None:
        raise HTTPException(status_code=404, detail="Operasi belum disimpan")
    if op.status == "sent":
        raise HTTPException(status_code=409, detail="Operasi sudah dikirim ke SATUSEHAT")
    patient = db.get(Patient, op.patient_id)
    payload = {"patient": order_patient(patient), "schedule": op.schedule or {}, "report": op.report or {}}

    result = from_thread.run(sehat.send_procedure, payload)

    if result.get("ok"):
        service.mark_sent(db, op, result.get("encounter_id", ""), result.get("procedure_id", ""))
    record(db, "send_procedure" if result.get("ok") else "send_procedure_failed", request=request, user=user,
           entity_type="operation", entity_id=op.code, patient_id=patient.id,
           detail={"mode": result.get("mode"), "encounter_id": result.get("encounter_id", ""),
                   "procedure_id": result.get("procedure_id", "")})
    db.commit()
    result["operation"] = service.get_public(db, op.code)
    return result
