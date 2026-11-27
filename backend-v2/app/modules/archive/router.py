"""/api/studies, /api/series, /api/instances.

Compatible with the old backend (same URLs, multipart fields and answers the MyPACS pages use):
    GET  /api/studies                      list (newest first)
    POST /api/studies                      upload: multipart `file` (+ `meta` JSON with order_id)
    GET  /api/studies/{id}/file            the study's main file (NIfTI volume, or first image)
    GET  /api/studies/{id}/slices          {count, urls} of every image, in viewing order
    POST /api/studies/{id}/reading         save the radiologist's draft {icd10, diagnosis, finding}
New:
    POST /api/studies with several `files` at once (a whole series in one go)
    POST /api/studies/{id}/instances       add more files to a study (large series in batches)
    GET  /api/studies/{id}/series          the study's series
    GET  /api/series/{uid}/instances       a series' images
    GET  /api/instances/{uid}/file         one image

The endpoints are plain `def` (not async): FastAPI runs them in a worker thread, so reading files,
parsing DICOM and converting NIfTI never block other requests.
"""
import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.modules.archive import service, storage
from app.modules.archive.models import STUDY_STATUSES, Instance, Series, StoredFile, Study
from app.modules.audit.service import record
from app.modules.auth.deps import require_roles
from app.modules.auth.models import User
from app.modules.auth.roles import ARCHIVE_READ, ARCHIVE_WRITE, REPORTERS
from app.modules.orders import service as orders
from app.modules.orders.models import Order
from app.modules.patients.models import Patient
from app.modules.patients.service import get_by_nik
from app.modules.reports import service as reports

router = APIRouter(prefix="/api", tags=["archive"])


def _trim_draft(study: dict, user: User) -> dict:
    """A draft is the radiologist's unfinished work: other roles only learn that one exists (old behaviour)."""
    if user.role_code not in REPORTERS and study.get("draft"):
        study = {**study, "draft": {"saved": study["draft"].get("saved", "")}}
    return study


def _study_or_404(db: Session, study_id: int, lock: bool = False) -> Study:
    study = db.get(Study, study_id, with_for_update=lock)
    if study is None:
        raise HTTPException(status_code=404, detail="Studi tidak ditemukan")
    return study


def _file_response(stored: StoredFile | None) -> FileResponse:
    if stored is None:
        raise HTTPException(status_code=404, detail="file not found")
    path = storage.absolute(stored.relative_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="file missing on disk")
    return FileResponse(path, media_type=stored.content_type, filename=stored.original_filename or path.name)


def _receive(uploads: list[UploadFile]) -> list[storage.Received]:
    received = []
    try:
        for up in uploads:
            received.append(storage.receive(up.file, up.filename or "upload"))
    except storage.TooLarge as e:
        storage.discard(r.path for r in received)
        raise HTTPException(status_code=413, detail=str(e))
    except BaseException:
        storage.discard(r.path for r in received)
        raise
    return received


def _ingest_and_commit(db: Session, received, after, **kwargs) -> service.Ingest:
    """Ingest, run `after(result)` (status changes, audit), commit. If anything after the ingest fails,
    roll back and delete the files the ingest created, so disk and database agree."""
    try:
        result = service.ingest(db, received, **kwargs)
    except service.IngestError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)
    try:
        after(result)
        db.commit()
    except BaseException:
        db.rollback()
        storage.discard(result.created)
        raise
    return result


# ------------------------------------------------------------------ list / upload
@router.get("/studies")
def list_studies(request: Request, status: str = "", limit: int = Query(500, ge=1, le=1000),
                 offset: int = Query(0, ge=0), user: User = Depends(require_roles(*ARCHIVE_READ)),
                 db: Session = Depends(get_db)):
    if status and status not in STUDY_STATUSES:
        raise HTTPException(status_code=400, detail="Status harus salah satu dari " + ", ".join(STUDY_STATUSES))
    rows = [_trim_draft(s, user) for s in service.list_studies(db, status or None, limit, offset)]
    record(db, "list_studies", request=request, user=user, detail={"status": status, "count": len(rows)})
    return rows


@router.post("/studies")
def add_study(request: Request, file: UploadFile | None = File(None), files: list[UploadFile] | None = File(None),
              meta: str = Form("{}"), user: User = Depends(require_roles(*ARCHIVE_WRITE)),
              db: Session = Depends(get_db)):
    """Archive images for a radiology request. meta (JSON): {order_id} — the request decides the patient
    and the exam. An admin may upload without a request by giving {nik} of a registered patient."""
    try:
        m = json.loads(meta or "{}")
        if not isinstance(m, dict):
            raise ValueError
    except ValueError:
        raise HTTPException(status_code=400, detail="meta harus berupa JSON object")
    uploads = ([file] if file is not None else []) + list(files or [])
    if not uploads:
        raise HTTPException(status_code=400, detail="Tidak ada berkas yang diunggah")

    order: Order | None = None
    order_id = str(m.get("order_id") or "").strip()
    if order_id:
        # lock the request row: two uploads for the same request at once -> the second waits, then gets 409
        order = db.scalar(select(Order).where(Order.accession_number == order_id).with_for_update())
        if order is None:
            raise HTTPException(status_code=404, detail="Permintaan radiologi tidak ditemukan")
        if order.status != "requested":
            raise HTTPException(status_code=409, detail="Permintaan ini sudah diproses")
        patient = db.get(Patient, order.patient_id)
    elif user.role_code == "radiografer":
        raise HTTPException(status_code=400, detail="Pilih permintaan radiologi terlebih dulu")
    else:
        patient = get_by_nik(db, m.get("nik"))
        if patient is None:
            raise HTTPException(status_code=400, detail="Tanpa permintaan radiologi, isi NIK pasien yang sudah terdaftar")

    def after(result: service.Ingest) -> None:
        if order is not None:
            orders.set_imaged(db, order.accession_number)
        record(db, "upload_study", request=request, user=user, entity_type="study", entity_id=result.study.id,
               patient_id=patient.id, detail={"added": result.added, "skipped": result.skipped,
                                              "order": order_id or None, "warnings": result.warnings})

    result = _ingest_and_commit(db, _receive(uploads), after, patient=patient, order=order, user=user)
    return {**service.get_public(db, result.study.id), "added": result.added, "skipped": result.skipped,
            "warnings": result.warnings}


@router.post("/studies/{study_id}/instances")
def add_instances(study_id: int, request: Request, files: list[UploadFile] = File(...),
                  user: User = Depends(require_roles(*ARCHIVE_WRITE)), db: Session = Depends(get_db)):
    """Add files to an existing study, e.g. a 1,000-slice CT uploaded 100 files at a time.
    Re-sending a file that is already archived is harmless (it is counted as skipped)."""
    study = _study_or_404(db, study_id, lock=True)
    if study.status in ("final", "amended"):
        raise HTTPException(status_code=409, detail="Studi ini sudah dibaca dan dikirim ke SATUSEHAT")
    patient = db.get(Patient, study.patient_id)
    order = db.get(Order, study.order_id) if study.order_id else None
    def after(result: service.Ingest) -> None:
        record(db, "upload_instances", request=request, user=user, entity_type="study", entity_id=study.id,
               patient_id=patient.id, detail={"added": result.added, "skipped": result.skipped})

    result = _ingest_and_commit(db, _receive(files), after, patient=patient, order=order, user=user, study=study)
    return {**service.get_public(db, study.id), "added": result.added, "skipped": result.skipped,
            "warnings": result.warnings}


# ------------------------------------------------------------------ files
@router.get("/studies/{study_id}/file")
def study_file(study_id: int, request: Request, user: User = Depends(require_roles(*ARCHIVE_READ)),
               db: Session = Depends(get_db)):
    study = _study_or_404(db, study_id)
    response = _file_response(service.main_file(db, study.id))
    record(db, "view_study", request=request, user=user, entity_type="study", entity_id=study.id,
           patient_id=study.patient_id, detail={"what": "file"})
    db.commit()
    return response


@router.get("/studies/{study_id}/slices")
def study_slices(study_id: int, request: Request, user: User = Depends(require_roles(*REPORTERS)),
                 db: Session = Depends(get_db)):
    """URLs of every image of the study in viewing order (a NIfTI study: its converted slices)."""
    study = _study_or_404(db, study_id)
    rows = service.instances_in_order(db, study.id)
    if not rows:
        raise HTTPException(status_code=404, detail="file not found")
    record(db, "view_study", request=request, user=user, entity_type="study", entity_id=study.id,
           patient_id=study.patient_id, detail={"what": "slices", "count": len(rows)})
    db.commit()
    return {"count": len(rows), "urls": [f"/api/instances/{inst.sop_instance_uid}/file" for inst, _, _ in rows]}


@router.get("/studies/{study_id}/series")
def study_series(study_id: int, user: User = Depends(require_roles(*ARCHIVE_READ)), db: Session = Depends(get_db)):
    return service.series_of(db, _study_or_404(db, study_id).id)


@router.get("/series/{series_uid}/instances")
def series_instances(series_uid: str, user: User = Depends(require_roles(*ARCHIVE_READ)),
                     db: Session = Depends(get_db)):
    series = db.scalar(select(Series).where(Series.series_instance_uid == series_uid))
    if series is None:
        raise HTTPException(status_code=404, detail="Seri tidak ditemukan")
    rows = db.execute(select(Instance).where(Instance.series_id == series.id)
                      .order_by(Instance.instance_number.asc().nulls_last(), Instance.id)).scalars()
    return [{"sop_instance_uid": i.sop_instance_uid, "instance_number": i.instance_number, "rows": i.rows,
             "columns": i.columns, "number_of_frames": i.number_of_frames, "slice_location": i.slice_location,
             "url": f"/api/instances/{i.sop_instance_uid}/file"} for i in rows]


@router.get("/instances/{sop_uid}/file")
def instance_file(sop_uid: str, user: User = Depends(require_roles(*ARCHIVE_READ)), db: Session = Depends(get_db)):
    # not audited one by one: opening a study (/slices or /file) is already logged, and a CT has hundreds of these
    stored = db.scalar(select(StoredFile).join(Instance, Instance.storage_id == StoredFile.id)
                       .where(Instance.sop_instance_uid == sop_uid))
    return _file_response(stored)


# ------------------------------------------------------------------ reading (draft)
class ReadingBody(BaseModel):
    icd10: str | None = ""
    diagnosis: str | None = ""
    finding: str | None = ""


@router.post("/studies/{study_id}/reading")
def save_reading(study_id: int, body: ReadingBody, request: Request,
                 user: User = Depends(require_roles(*REPORTERS)), db: Session = Depends(get_db)):
    """Save the radiologist's reading as a draft, without sending it. All three empty removes the draft."""
    study = _study_or_404(db, study_id, lock=True)       # one save at a time per study
    reading = {key: str(getattr(body, key) or "").strip() for key in reports.LIMITS}
    for key, most in reports.LIMITS.items():
        if len(reading[key]) > most:
            raise HTTPException(status_code=400, detail=f"{key} terlalu panjang (maks. {most} huruf)")
    try:
        reports.save_draft(db, study, user, reading)
    except reports.AlreadyFinal:
        raise HTTPException(status_code=409, detail="Studi ini sudah dibaca dan dikirim ke SATUSEHAT")
    record(db, "save_draft", request=request, user=user, entity_type="study", entity_id=study.id,
           patient_id=study.patient_id, detail={"empty": not any(reading.values())})
    db.commit()
    return service.get_public(db, study.id)
