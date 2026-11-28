"""/api/orders: same URLs, bodies, answers and error texts as the old backend."""
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.modules.audit.service import record
from app.modules.auth.deps import require_roles
from app.modules.auth.models import User
from app.modules.auth.roles import ARCHIVE_READ, ARCHIVE_WRITE, ORDERERS
from app.modules.orders import service
from app.modules.orders.models import ORDER_STATUSES
from app.modules.patients.service import get_by_nik

router = APIRouter(prefix="/api/orders", tags=["orders"])

EXAM_MODALITIES = ("DX", "CT", "MR", "US")      # what a ward can request (the database also knows CR, PT, ...)


class PatientRef(BaseModel):
    nik: str = ""


class Exam(BaseModel):
    modality: str = ""
    description: str = ""


class Indication(BaseModel):
    icd10: str = ""
    text: str = ""


class OrderBody(BaseModel):
    patient: PatientRef = PatientRef()
    exam: Exam = Exam()
    indication: Indication = Indication()
    priority: str = "Biasa"
    note: str = ""
    unit: str = ""


class ReturnBody(BaseModel):
    reason: str = ""


@router.get("")
def list_orders(request: Request, status: str = "", nik: str = "", limit: int = Query(500, ge=1, le=1000),
                offset: int = Query(0, ge=0), user: User = Depends(require_roles(*ARCHIVE_READ)),
                db: Session = Depends(get_db)):
    """Requests, newest first, each with its study (and the reading, once sent) attached."""
    if status and status not in ORDER_STATUSES:
        raise HTTPException(status_code=400, detail="Status harus salah satu dari " + ", ".join(ORDER_STATUSES))
    rows = service.list_orders(db, status or None, nik.strip() or None, limit, offset)
    record(db, "list_orders", request=request, user=user, detail={"status": status, "nik": bool(nik), "count": len(rows)})
    return rows


@router.post("")
def create_order(body: OrderBody, request: Request, user: User = Depends(require_roles(*ORDERERS)),
                 db: Session = Depends(get_db)):
    """A doctor requests an exam for a registered patient. The patient's identity comes from the registry.
    unit = the ward the request comes from (free text, e.g. "Bedah", "IGD")."""
    nik, description = body.patient.nik.strip(), body.exam.description.strip()
    unit = body.unit.strip()
    if not nik or not description:
        raise HTTPException(status_code=400, detail="NIK pasien dan jenis pemeriksaan wajib diisi")
    if len(unit) > 60:
        raise HTTPException(status_code=400, detail="Nama unit terlalu panjang (maks. 60 huruf)")
    for value, most, label in ((description, 200, "Jenis pemeriksaan"), (body.note, 2000, "Catatan"),
                               (body.indication.text, 2000, "Indikasi"), (body.indication.icd10, 32, "ICD-10")):
        if len(value) > most:
            raise HTTPException(status_code=400, detail=f"{label} terlalu panjang (maks. {most} huruf)")
    patient = get_by_nik(db, nik)
    if patient is None:
        raise HTTPException(status_code=400, detail="Pasien belum terdaftar. Daftarkan pasien terlebih dulu")
    if body.exam.modality not in EXAM_MODALITIES:
        raise HTTPException(status_code=400, detail="Modality harus salah satu dari " + ", ".join(EXAM_MODALITIES))
    priority = service.PRIORITY_IN.get(body.priority or "Biasa")
    if priority is None:
        raise HTTPException(status_code=400, detail="Prioritas harus Biasa atau CITO")
    order = service.create_order(db, patient=patient, modality=body.exam.modality, description=description,
                                 priority=priority, indication_icd10=body.indication.icd10.strip(),
                                 indication_text=body.indication.text.strip(), note=body.note.strip(),
                                 unit=unit, user=user)
    record(db, "create_order", request=request, user=user, entity_type="order", entity_id=order.accession_number,
           patient_id=patient.id, detail={"modality": order.modality, "priority": order.priority})
    db.commit()
    return service.get_order(db, order.accession_number)


@router.post("/{order_id}/return")
def return_order(order_id: str, body: ReturnBody, request: Request,
                 user: User = Depends(require_roles(*ARCHIVE_WRITE)), db: Session = Depends(get_db)):
    """Radiology sends a request back to the ward (e.g. the wrong exam), with a reason.
    Only while it still waits for images; it then stays in the list as 'returned'."""
    reason = body.reason.strip()
    if not reason:
        raise HTTPException(status_code=400, detail="Alasan pengembalian wajib diisi")
    if len(reason) > 500:
        raise HTTPException(status_code=400, detail="Alasan terlalu panjang (maks. 500 huruf)")
    order = service.get_order_row(db, order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Permintaan radiologi tidak ditemukan")
    try:
        service.set_returned(db, order_id, reason, user)
    except service.NotRequested:
        raise HTTPException(status_code=409, detail="Permintaan ini sudah diproses")
    record(db, "return_order", request=request, user=user, entity_type="order", entity_id=order_id,
           patient_id=order.patient_id, detail={"reason": reason})
    db.commit()
    return service.get_order(db, order_id)
