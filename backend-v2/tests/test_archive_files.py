"""DICOM tag reading, file storage and NIfTI conversion, using the sample files in Backend/seed_samples.
No database needed."""
import hashlib
import io

import pydicom
import pytest

from app.core.config import REPO_DIR, get_settings
from app.modules.archive import dicom, service, storage

SAMPLES = REPO_DIR / "Backend" / "seed_samples"
CT = SAMPLES / "ct_thoracic_spine.dcm"
MR1, MR2 = SAMPLES / "mr_brain_sagittal_1.dcm", SAMPLES / "mr_brain_sagittal_2.dcm"
NII = SAMPLES / "mri_brain_axial.nii.gz"


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "storage_dir", tmp_path / "storage")
    return tmp_path / "storage"


def test_header_of_ct_sample():
    h = dicom.read_header(CT)
    assert h.modality == "CT" and h.rows == 128 and h.instance_number == 1
    assert dicom.UID_RE.match(h.study_uid) and dicom.UID_RE.match(h.sop_uid)


def test_two_slices_share_study_and_series():
    a, b = dicom.read_header(MR1), dicom.read_header(MR2)
    assert a.study_uid == b.study_uid and a.series_uid == b.series_uid and a.sop_uid != b.sop_uid


def _altered(tmp_path, **changes):
    ds = pydicom.dcmread(CT)
    for key, value in changes.items():
        if value is None:
            delattr(ds, key)
        else:
            setattr(ds, key, value)
    out = tmp_path / "altered.dcm"
    ds.save_as(out)
    return out


def test_missing_uid_is_refused(tmp_path):
    with pytest.raises(dicom.BadDicom, match="SOPInstanceUID tidak ada"):
        dicom.read_header(_altered(tmp_path, SOPInstanceUID=None))


def test_malformed_uid_is_refused(tmp_path):
    with pytest.raises(dicom.BadDicom, match="StudyInstanceUID tidak valid"):
        dicom.read_header(_altered(tmp_path, StudyInstanceUID="1.2.abc"))


def test_detects_file_types(tmp_path):
    png = tmp_path / "x.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 200)
    assert dicom.looks_like_dicom(CT) and not dicom.looks_like_dicom(png)
    assert service._is_nifti(NII) and not service._is_nifti(CT)


def test_receive_hashes_and_places(store):
    data = CT.read_bytes()
    rec = storage.receive(io.BytesIO(data), "../../evil/ct.dcm")
    assert rec.original_name == "ct.dcm"                     # no path tricks in stored names
    assert rec.size == len(data) and rec.sha256 == hashlib.sha256(data).hexdigest()
    rel = storage.relative_path_for("dicom", rec.sha256, ".dcm")
    assert storage.place(rec, rel) is True
    assert storage.absolute(rel).read_bytes() == data
    again = storage.receive(io.BytesIO(data), "ct.dcm")
    assert storage.place(again, rel) is False                # same bytes already stored
    assert not any((store / "tmp").iterdir())


def test_receive_enforces_size_limit(store, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_upload_mb", 0)
    with pytest.raises(storage.TooLarge):
        storage.receive(io.BytesIO(b"x" * 10), "big.dcm")
    assert not any((store / "tmp").iterdir())                # partial file removed


def test_storage_refuses_paths_outside(store):
    with pytest.raises(ValueError):
        storage.absolute("../outside.txt")


def test_nifti_becomes_dicom_slices(store):
    src = storage.receive(io.BytesIO(NII.read_bytes()), "brain.nii.gz")
    items = service._nifti_to_items(src, {"name": "Uji Coba", "nik": "3171234567890123", "modality": "MR",
                                          "description": "MRI Kepala", "order_id": "RQ-261127-0001"})
    try:
        assert len(items) > 1
        assert len({i.header.study_uid for i in items}) == 1 and len({i.header.series_uid for i in items}) == 1
        assert len({i.header.sop_uid for i in items}) == len(items)
        assert all(i.kind == "derived" for i in items)
    finally:
        storage.discard(i.received.path for i in items)
        storage.discard([src.path])


def test_sample_files_exist():
    for f in (CT, MR1, MR2, NII):
        assert f.exists(), f"missing sample {f}"
