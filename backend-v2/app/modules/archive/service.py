"""Archive rules: ingest uploads into Study -> Series -> Instance, list studies, find files.

Ingest, in order:
  1. every upload is already in storage/tmp (storage.receive), hashed;
  2. each file is classified: DICOM, NIfTI, or refused;
  3. a NIfTI volume is kept as-is AND converted into DICOM slices, which then go through the same path as DICOM;
  4. tags are read (dicom.read_header) and checked: all files must belong to one study;
  5. study, series and instance rows are created or matched by UID; an instance already archived with the
     same bytes is skipped (re-uploading is harmless), with different bytes it is refused;
  6. files move to their final, content-addressed place.
The caller commits. If ingest fails it deletes the files it created; if the caller's commit fails,
the caller deletes `Ingest.created`. Either way no file is left on disk without a database row.
"""
import io
from dataclasses import dataclass, field

import pydicom
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session, aliased

from app.modules.archive import dicom, nifti, storage
from app.modules.archive.models import Instance, Series, StoredFile, Study
from app.modules.auth.models import User
from app.modules.orders.models import Order
from app.modules.patients.models import Patient
from app.modules.patients.service import SEX_TO_GENDER
from app.modules.reports.models import Report

NIFTI_MIME = "application/x-nifti"
ONLY_IMAGES = "Hanya berkas DICOM (.dcm, .ima) atau NIfTI (.nii, .nii.gz) yang diterima"


class IngestError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


@dataclass
class Ingest:
    study: Study | None = None
    added: int = 0
    skipped: int = 0
    warnings: list[str] = field(default_factory=list)
    created: list = field(default_factory=list)     # files this ingest put on disk (delete them on failure)


@dataclass
class _Item:
    received: storage.Received
    header: dicom.DicomHeader
    kind: str                                       # dicom | derived


def _is_nifti(path) -> bool:
    with open(path, "rb") as f:
        head = f.read(64 * 1024)
    try:
        return nifti.is_nifti(head)
    except Exception:
        return False


def _nifti_to_items(src: storage.Received, info: dict) -> list[_Item]:
    try:
        datasets = nifti.nifti_to_datasets(src.path.read_bytes(), info)
    except Exception as e:
        raise IngestError(400, f"{src.original_name}: berkas NIfTI tidak bisa dibaca ({e})")
    items = []
    try:
        for i, ds in enumerate(datasets, 1):
            buf = io.BytesIO()
            pydicom.dcmwrite(buf, ds, enforce_file_format=True)
            rec = storage.receive_bytes(buf.getvalue(), f"{i:04d}.dcm")
            items.append(_Item(rec, dicom.read_header(rec.path, rec.original_name), "derived"))
    except BaseException:
        storage.discard(item.received.path for item in items)
        raise
    return items


def ingest(db: Session, uploads: list[storage.Received], *, patient: Patient, order: Order | None,
           user: User, study: Study | None = None) -> Ingest:
    """Archive `uploads` as a new study (study=None) or add them to `study`."""
    result = Ingest(study=study)
    if not uploads:
        raise IngestError(400, "Tidak ada berkas yang diunggah")

    niftis = [u for u in uploads if _is_nifti(u.path)]
    items: list[_Item] = []
    source: storage.Received | None = None
    try:
        if niftis:
            if len(uploads) != 1 or study is not None:
                raise IngestError(400, "Satu volume NIfTI per studi: unggah berkas NIfTI sendiri, tanpa berkas lain")
            source = uploads[0]
            info = {"name": patient.name, "nik": patient.nik or patient.mrn, "gender": SEX_TO_GENDER.get(patient.sex or "", ""),
                    "birthDate": patient.birth_date.isoformat() if patient.birth_date else "",
                    "description": order.exam_description if order else "NIfTI volume",
                    "modality": order.modality if order else "MR", "order_id": order.accession_number if order else ""}
            items = _nifti_to_items(source, info)
        else:
            for u in uploads:
                if not dicom.looks_like_dicom(u.path):
                    raise IngestError(400, ONLY_IMAGES)
                try:
                    items.append(_Item(u, dicom.read_header(u.path, u.original_name), "dicom"))
                except (dicom.NotDicom, dicom.BadDicom) as e:
                    raise IngestError(400, str(e))

        study_uids = {it.header.study_uid for it in items}
        if len(study_uids) != 1:
            raise IngestError(400, "Semua berkas harus dari satu studi (StudyInstanceUID yang sama)")
        study_uid = study_uids.pop()

        if study is None:
            if db.scalar(select(Study.id).where(Study.study_instance_uid == study_uid)):
                raise IngestError(409, "Studi ini (StudyInstanceUID yang sama) sudah ada di arsip")
            first = items[0].header
            study = Study(study_instance_uid=study_uid, patient_id=patient.id,
                          order_id=order.id if order else None,
                          accession_number=order.accession_number if order else first.accession_number,
                          study_datetime=first.study_datetime,
                          description=(order.exam_description if order else first.study_description),
                          status="unread", uploaded_by=user.id)
            db.add(study)
            db.flush()
            result.study = study
        elif study.study_instance_uid != study_uid:
            raise IngestError(400, "Berkas ini milik studi lain (StudyInstanceUID berbeda)")

        if source is not None:
            rel = storage.relative_path_for("nifti_source", source.sha256,
                                            ".nii.gz" if source.original_name.lower().endswith(".gz") else ".nii")
            if db.scalar(select(StoredFile.id).where(StoredFile.relative_path == rel)):
                raise IngestError(409, "Berkas NIfTI ini sudah ada di arsip")
            if storage.place(source, rel):
                result.created.append(storage.absolute(rel))
            db.add(StoredFile(relative_path=rel, kind="nifti_source", size_bytes=source.size, sha256=source.sha256,
                              content_type=NIFTI_MIME, original_filename=source.original_name, study_id=study.id))

        _check_patient(items, patient, result)
        _add_instances(db, study, items, result)
        _refresh_counts(db, study)
        return result
    except BaseException:
        storage.discard(result.created)      # no database rows will point at these
        raise
    finally:
        # anything still in storage/tmp (refused, skipped, or after an error) is not needed any more
        storage.discard(u.path for u in uploads)
        storage.discard(it.received.path for it in items)


def _check_patient(items: list[_Item], patient: Patient, result: Ingest) -> None:
    """The request is the source of truth for the patient. A different PatientID inside the files is
    reported back (not fatal: demo data is often anonymised)."""
    ids = {it.header.patient_id for it in items if it.header.patient_id and it.kind == "dicom"}
    known = {patient.nik, patient.mrn} - {None}
    if ids and not ids & known:
        result.warnings.append("PatientID di berkas (" + ", ".join(sorted(ids))[:80] +
                               ") tidak sama dengan NIK/MRN pasien. Periksa berkasnya.")


def _add_instances(db: Session, study: Study, items: list[_Item], result: Ingest) -> None:
    series_by_uid: dict[str, Series] = {}
    seen: set[str] = set()
    for it in items:
        h = it.header
        if h.sop_uid in seen:                 # the same image twice in one upload
            result.skipped += 1
            continue
        seen.add(h.sop_uid)

        series = series_by_uid.get(h.series_uid) or db.scalar(select(Series).where(Series.series_instance_uid == h.series_uid))
        if series is None:
            series = Series(series_instance_uid=h.series_uid, study_id=study.id, modality=h.modality,
                            series_number=h.series_number, description=h.series_description, body_part=h.body_part,
                            frame_of_reference_uid=h.frame_of_reference_uid, manufacturer=h.manufacturer,
                            station_name=h.station_name)
            db.add(series)
            db.flush()
        elif series.study_id != study.id:
            raise IngestError(409, f"{it.received.original_name}: SeriesInstanceUID ini milik studi lain di arsip")
        series_by_uid[h.series_uid] = series

        existing = db.execute(select(Instance, StoredFile.sha256).join(StoredFile, StoredFile.id == Instance.storage_id)
                              .where(Instance.sop_instance_uid == h.sop_uid)).first()
        if existing is not None:
            if existing[1] == it.received.sha256:
                result.skipped += 1           # already archived, identical bytes
                continue
            raise IngestError(409, f"{it.received.original_name}: SOPInstanceUID ini sudah ada di arsip dengan isi berbeda")

        rel = storage.relative_path_for(it.kind, it.received.sha256, ".dcm")
        if storage.place(it.received, rel):
            result.created.append(storage.absolute(rel))
        stored = StoredFile(relative_path=rel, kind=it.kind, size_bytes=it.received.size, sha256=it.received.sha256,
                            content_type=dicom.DICOM_MIME, original_filename=it.received.original_name)
        db.add(stored)
        db.flush()
        db.add(Instance(sop_instance_uid=h.sop_uid, series_id=series.id, sop_class_uid=h.sop_class_uid,
                        instance_number=h.instance_number, transfer_syntax_uid=h.transfer_syntax_uid, rows=h.rows,
                        columns=h.columns, number_of_frames=h.number_of_frames, slice_location=h.slice_location,
                        storage_id=stored.id))
        result.added += 1
    db.flush()


def _refresh_counts(db: Session, study: Study) -> None:
    for series in db.scalars(select(Series).where(Series.study_id == study.id)):
        series.instance_count = db.scalar(select(func.count()).where(Instance.series_id == series.id)) or 0
    study.modalities = sorted(set(db.scalars(select(Series.modality).where(Series.study_id == study.id))))
    db.flush()


# ---------------------------------------------------------------- reading
def _first_file_name():
    """The name the pages show as the study's file: the NIfTI volume if there is one, else the first image."""
    nifti_name = (select(StoredFile.original_filename)
                  .where(StoredFile.study_id == Study.id, StoredFile.kind == "nifti_source")
                  .limit(1).scalar_subquery())
    first_image = (select(StoredFile.original_filename)
                   .join(Instance, Instance.storage_id == StoredFile.id)
                   .join(Series, Series.id == Instance.series_id)
                   .where(Series.study_id == Study.id)
                   .order_by(Series.series_number.asc().nulls_last(), Series.id,
                             Instance.instance_number.asc().nulls_last(), Instance.id)
                   .limit(1).scalar_subquery())
    return func.coalesce(nifti_name, first_image)


def list_query() -> Select:
    requester, uploader, author = aliased(User), aliased(User), aliased(User)
    n_series = select(func.count()).where(Series.study_id == Study.id).scalar_subquery()
    n_instances = (select(func.count()).select_from(Instance).join(Series, Series.id == Instance.series_id)
                   .where(Series.study_id == Study.id).scalar_subquery())
    return (select(Study, Patient, Order, requester.full_name, uploader.username, Report, author.username,
                   _first_file_name(), n_series, n_instances)
            .join(Patient, Patient.id == Study.patient_id)
            .outerjoin(Order, Order.id == Study.order_id)
            .outerjoin(requester, requester.id == Order.requested_by)
            .outerjoin(uploader, uploader.id == Study.uploaded_by)
            .outerjoin(Report, Report.study_id == Study.id)
            .outerjoin(author, author.id == Report.author_id)
            .execution_options(populate_existing=True))


def _iso(value):
    return value.isoformat(timespec="seconds") if value else None


def to_public(row) -> dict:
    """A study in the old backend's shape (plus UIDs and counts). `draft` holds the full draft here;
    the router trims it for roles that may not read unsent reports."""
    study, patient, order, requester_name, uploader_name, report, author_name, file_name, n_series, n_instances = row
    sent = study.status in ("final", "amended")
    final = report if (report is not None and sent) else None
    draft = None
    if report is not None and report.status == "draft" and any((report.icd10, report.diagnosis, report.findings)):
        draft = {"icd10": report.icd10 or "", "diagnosis": report.diagnosis or "", "finding": report.findings or "",
                 "by": author_name, "saved": _iso(report.updated_at)}
    modality = order.modality if order is not None else ((study.modalities or [""])[0])
    return {
        "id": str(study.id), "study_instance_uid": study.study_instance_uid, "accession_number": study.accession_number,
        "created": _iso(study.created_at), "status": study.status, "file": file_name, "sent": sent,
        "name": patient.name, "nik": patient.nik or "", "mrn": patient.mrn,
        "gender": SEX_TO_GENDER.get(patient.sex or "", ""),
        "birthDate": patient.birth_date.isoformat() if patient.birth_date else "",
        "modality": modality, "modalities": list(study.modalities or []), "description": study.description or "",
        "doctor": requester_name or "", "clinical": (order.indication_text or "") if order is not None else "",
        "order_id": order.accession_number if order is not None else "",
        "saved_by": uploader_name, "series_count": n_series, "instance_count": n_instances,
        "icd10": (final.icd10 or "") if final else "", "diagnosis": (final.diagnosis or "") if final else "",
        "finding": (final.findings or "") if final else "", "reported_by": author_name if final else None,
        "draft": draft,
        "imaging_study_id": study.satusehat_imaging_study_id or "",
        "diagnostic_report_id": (report.satusehat_diagnostic_report_id or "") if final else "",
    }


def list_studies(db: Session, status: str | None = None, limit: int = 500, offset: int = 0) -> list[dict]:
    stmt = list_query()
    if status:
        stmt = stmt.where(Study.status == status)
    stmt = stmt.order_by(Study.created_at.desc(), Study.id.desc()).limit(limit).offset(offset)
    return [to_public(row) for row in db.execute(stmt)]


def get_public(db: Session, study_id: int) -> dict | None:
    row = db.execute(list_query().where(Study.id == study_id)).first()
    return to_public(row) if row else None


def instances_in_order(db: Session, study_id: int):
    """(Instance, StoredFile, Series) for a study, in viewing order: series by number, slices by number."""
    return db.execute(select(Instance, StoredFile, Series)
                      .join(Series, Series.id == Instance.series_id)
                      .join(StoredFile, StoredFile.id == Instance.storage_id)
                      .where(Series.study_id == study_id)
                      .order_by(Series.series_number.asc().nulls_last(), Series.id,
                                Instance.instance_number.asc().nulls_last(), Instance.id)).all()


def main_file(db: Session, study_id: int) -> StoredFile | None:
    """What GET /studies/{id}/file serves: the NIfTI volume if the study came from one, else the first image."""
    nifti_file = db.scalar(select(StoredFile).where(StoredFile.study_id == study_id, StoredFile.kind == "nifti_source"))
    if nifti_file is not None:
        return nifti_file
    rows = db.execute(select(StoredFile)
                      .join(Instance, Instance.storage_id == StoredFile.id)
                      .join(Series, Series.id == Instance.series_id)
                      .where(Series.study_id == study_id)
                      .order_by(Series.series_number.asc().nulls_last(), Series.id,
                                Instance.instance_number.asc().nulls_last(), Instance.id).limit(1)).first()
    return rows[0] if rows else None


def series_of(db: Session, study_id: int) -> list[dict]:
    return [{"series_instance_uid": s.series_instance_uid, "modality": s.modality, "series_number": s.series_number,
             "description": s.description or "", "body_part": s.body_part or "", "instance_count": s.instance_count}
            for s in db.scalars(select(Series).where(Series.study_id == study_id)
                                .order_by(Series.series_number.asc().nulls_last(), Series.id))]
