"""Reading the DICOM tags the archive needs, without loading pixel data.

Every DICOM file carries its place in the hierarchy:
    StudyInstanceUID (0020,000D) -> SeriesInstanceUID (0020,000E) -> SOPInstanceUID (0008,0018)
`read_header` pulls those plus the descriptive tags we index, and checks the UIDs are well formed.
"""
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import pydicom
from pydicom.errors import InvalidDicomError

UID_RE = re.compile(r"^[0-9]+(\.[0-9]+)*$")
DICOM_MIME = "application/dicom"


class NotDicom(ValueError):
    pass


class BadDicom(ValueError):
    """A DICOM file we cannot archive (missing or malformed UIDs). The message is shown to the user."""


@dataclass
class DicomHeader:
    study_uid: str
    series_uid: str
    sop_uid: str
    sop_class_uid: str
    modality: str
    transfer_syntax_uid: str | None
    instance_number: int | None
    series_number: int | None
    rows: int | None
    columns: int | None
    number_of_frames: int
    slice_location: float | None
    series_description: str | None
    body_part: str | None
    frame_of_reference_uid: str | None
    manufacturer: str | None
    station_name: str | None
    study_description: str | None
    study_datetime: datetime | None
    accession_number: str | None
    patient_id: str | None
    patient_name: str | None


def looks_like_dicom(path: Path) -> bool:
    """Part-10 file ('DICM' after the 128-byte preamble), or a preamble-less dataset pydicom can read."""
    with open(path, "rb") as f:
        head = f.read(132)
    if len(head) == 132 and head[128:132] == b"DICM":
        return True
    try:
        ds = pydicom.dcmread(path, force=True, stop_before_pixels=True)
        return "SOPClassUID" in ds or "Modality" in ds
    except Exception:
        return False


def _text(ds, keyword) -> str | None:
    value = ds.get(keyword)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _int(ds, keyword) -> int | None:
    try:
        value = ds.get(keyword)
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _float(ds, keyword) -> float | None:
    try:
        value = ds.get(keyword)
        return float(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _study_datetime(ds) -> datetime | None:
    date = _text(ds, "StudyDate")
    if not date or not re.fullmatch(r"\d{8}", date):
        return None
    time = re.sub(r"[^0-9.]", "", _text(ds, "StudyTime") or "")
    hh, mm, ss = time[0:2] or "00", time[2:4] or "00", time[4:6] or "00"
    try:
        # DICOM times have no zone; this PACS treats them as the server's local time.
        return datetime.strptime(date + hh + mm + ss, "%Y%m%d%H%M%S").astimezone()
    except ValueError:
        return None


def _uid(ds, keyword, label, name) -> str:
    value = _text(ds, keyword)
    if not value:
        raise BadDicom(f"{name}: {label} tidak ada di berkas DICOM")
    value = value.rstrip("\x00")
    if len(value) > 64 or not UID_RE.match(value):
        raise BadDicom(f"{name}: {label} tidak valid ({value[:70]})")
    return value


def read_header(path: Path, name: str = "") -> DicomHeader:
    name = name or path.name
    try:
        ds = pydicom.dcmread(path, force=True, stop_before_pixels=True)
    except (InvalidDicomError, OSError, ValueError) as e:
        raise NotDicom(f"{name}: {e}") from e
    meta = getattr(ds, "file_meta", None)
    sop_class = _text(ds, "SOPClassUID") or (_text(meta, "MediaStorageSOPClassUID") if meta else None)
    if not sop_class:
        raise BadDicom(f"{name}: SOPClassUID tidak ada di berkas DICOM")
    return DicomHeader(
        study_uid=_uid(ds, "StudyInstanceUID", "StudyInstanceUID", name),
        series_uid=_uid(ds, "SeriesInstanceUID", "SeriesInstanceUID", name),
        sop_uid=_uid(ds, "SOPInstanceUID", "SOPInstanceUID", name),
        sop_class_uid=sop_class,
        modality=(_text(ds, "Modality") or "OT").upper(),
        transfer_syntax_uid=_text(meta, "TransferSyntaxUID") if meta else None,
        instance_number=_int(ds, "InstanceNumber"),
        series_number=_int(ds, "SeriesNumber"),
        rows=_int(ds, "Rows"),
        columns=_int(ds, "Columns"),
        number_of_frames=_int(ds, "NumberOfFrames") or 1,
        slice_location=_float(ds, "SliceLocation"),
        series_description=_text(ds, "SeriesDescription"),
        body_part=_text(ds, "BodyPartExamined"),
        frame_of_reference_uid=_text(ds, "FrameOfReferenceUID"),
        manufacturer=_text(ds, "Manufacturer"),
        station_name=_text(ds, "StationName"),
        study_description=_text(ds, "StudyDescription"),
        study_datetime=_study_datetime(ds),
        accession_number=_text(ds, "AccessionNumber"),
        patient_id=_text(ds, "PatientID"),
        patient_name=_text(ds, "PatientName"),
    )
