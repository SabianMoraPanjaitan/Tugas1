"""/api/patients: same URLs, bodies, answers and error texts as the old backend."""
import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.modules.audit.service import record
from app.modules.auth.deps import require_roles
from app.modules.auth.models import User
from app.modules.auth.roles import ARCHIVE_READ, REGISTRARS
from app.modules.patients import service
from app.modules.satusehat.client import client as sehat

router = APIRouter(prefix="/api/patients", tags=["patients"])


class PatientBody(BaseModel):
    nik: str = ""
    name: str = ""
    gender: str = ""
    birthDate: str = ""
    phone: str | None = None
    address: str | None = None
    city: str | None = None
    birthPlace: str | None = None


LIMITS = {"name": 200, "phone": 30, "address": 300, "city": 100, "birthPlace": 100}


@router.get("")
def list_patients(request: Request, q: str = Query("", max_length=100), limit: int = Query(1000, ge=1, le=1000),
                  offset: int = Query(0, ge=0), user: User = Depends(require_roles(*ARCHIVE_READ)),
                  db: Session = Depends(get_db)):
    """Registered patients, by name. Optional `q` searches name (contains), NIK or MRN (starts with)."""
    rows = service.list_patients(db, q, limit, offset)
    record(db, "list_patients", request=request, user=user, detail={"q": q, "count": len(rows)})
    return rows


@router.post("")
async def register_patient(body: PatientBody, request: Request, user: User = Depends(require_roles(*REGISTRARS)),
                           db: Session = Depends(get_db)):
    """Register a patient: find (or create) them in SATUSEHAT by NIK, then keep them here.
    Returns {ok, mode, logs, how: found | created, patient}.
    `async` because the SATUSEHAT call is awaited; the few short database calls run on the event loop,
    which is fine at this scale (move them to a thread if this endpoint ever becomes busy)."""
    p = {key: str(value or "").strip() for key, value in body.model_dump().items()}
    if not (p["nik"].isdigit() and len(p["nik"]) == 16):
        raise HTTPException(status_code=400, detail="NIK harus 16 digit angka")
    if not p["name"]:
        raise HTTPException(status_code=400, detail="Nama pasien wajib diisi")
    if p["gender"] not in service.GENDER_TO_SEX:
        raise HTTPException(status_code=400, detail="Jenis kelamin harus Laki-laki atau Perempuan")
    try:
        born = datetime.date.fromisoformat(p["birthDate"])
    except ValueError:
        raise HTTPException(status_code=400, detail="Tanggal lahir harus berformat YYYY-MM-DD")
    if born > datetime.date.today():
        raise HTTPException(status_code=400, detail="Tanggal lahir tidak boleh di masa depan")
    for key, most in LIMITS.items():
        if len(p[key]) > most:
            raise HTTPException(status_code=400, detail=f"{key} terlalu panjang (maks. {most} huruf)")
    if service.get_by_nik(db, p["nik"]):
        raise HTTPException(status_code=409, detail="Pasien dengan NIK ini sudah terdaftar")

    result = await sehat.register_patient(p)
    result["patient"] = None
    if result["ok"]:
        try:
            patient = service.add_patient(
                db, nik=p["nik"], ihs_number=result["ihs_number"], how=result["how"], name=p["name"],
                gender=p["gender"], birth_date=born, birth_place=p["birthPlace"],
                contact={key: p[key] for key in service.CONTACT_FIELDS}, user=user)
        except service.AlreadyRegistered:
            raise HTTPException(status_code=409, detail="Pasien dengan NIK ini sudah terdaftar")
        record(db, "register_patient", request=request, user=user, entity_type="patient", entity_id=patient.id,
               patient_id=patient.id, detail={"satusehat": result["how"], "mode": result.get("mode")})
        db.commit()
        result["patient"] = service.to_public(patient, user.username)
    return result
