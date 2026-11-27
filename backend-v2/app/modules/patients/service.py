"""Patient registry rules. The JSON shape the pages get (`to_public`) is the old backend's,
plus `id` and `mrn`."""
from datetime import date

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.modules.auth.models import User
from app.modules.patients.models import Patient

# The pages (and SATUSEHAT client) speak Indonesian labels; the database stores M / F / O.
GENDER_TO_SEX = {"Laki-laki": "M", "Perempuan": "F"}
SEX_TO_GENDER = {v: k for k, v in GENDER_TO_SEX.items()}
CONTACT_FIELDS = ("phone", "address", "city")


class AlreadyRegistered(Exception):
    pass


def to_public(p: Patient, created_by: str | None = None) -> dict:
    contact = p.contact or {}
    return {
        "id": p.id, "mrn": p.mrn, "nik": p.nik, "ihs_number": p.ihs_number, "satusehat": p.satusehat_link,
        "created": p.created_at.isoformat(timespec="seconds") if p.created_at else None,
        "created_by": created_by,
        "name": p.name, "gender": SEX_TO_GENDER.get(p.sex or "", ""),
        "birthDate": p.birth_date.isoformat() if p.birth_date else "",
        "birthPlace": p.birth_place or "",
        **{key: contact.get(key, "") for key in CONTACT_FIELDS},
    }


def list_patients(db: Session, q: str = "", limit: int = 1000, offset: int = 0) -> list[dict]:
    stmt = select(Patient, User.username).outerjoin(User, User.id == Patient.created_by)
    q = q.strip()
    if q:
        # name: "contains" (uses the trigram index); NIK / MRN: starts with
        # autoescape: a typed "%" or "_" is searched for literally, not used as a wildcard
        stmt = stmt.where(or_(Patient.name.icontains(q, autoescape=True), Patient.nik.startswith(q, autoescape=True),
                              Patient.mrn.startswith(q.upper(), autoescape=True)))
    stmt = stmt.order_by(func.lower(Patient.name), Patient.id).limit(limit).offset(offset)
    return [to_public(p, username) for p, username in db.execute(stmt)]


def get_by_nik(db: Session, nik: str | None) -> Patient | None:
    nik = str(nik or "").strip()
    return db.scalar(select(Patient).where(Patient.nik == nik)) if nik else None


def add_patient(db: Session, *, nik: str, ihs_number: str, how: str, name: str, gender: str, birth_date: date,
                birth_place: str, contact: dict, user: User) -> Patient:
    patient = Patient(nik=nik, ihs_number=ihs_number or None, satusehat_link=how or None, name=name,
                      sex=GENDER_TO_SEX.get(gender), birth_date=birth_date, birth_place=birth_place or None,
                      contact={k: v for k, v in contact.items() if v}, created_by=user.id)
    try:
        with db.begin_nested():          # savepoint: a duplicate only undoes this insert
            db.add(patient)
            db.flush()
    except IntegrityError:
        raise AlreadyRegistered(nik)
    db.refresh(patient)                  # read back the MRN PostgreSQL generated
    return patient


def order_patient(p: Patient) -> dict:
    """The patient block shown on a request (same keys as the old backend)."""
    return {"nik": p.nik or "", "mrn": p.mrn, "name": p.name, "gender": SEX_TO_GENDER.get(p.sex or "", ""),
            "birthDate": p.birth_date.isoformat() if p.birth_date else "", "ihs": p.ihs_number or ""}
