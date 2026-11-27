"""Studies end to end against the PostgreSQL test database: upload (DICOM and NIfTI), list, files,
slices, drafts, and the request status changing to 'imaged'."""
import hashlib
import json

import pytest

from app.core.config import REPO_DIR, get_settings
from tests.test_patients_orders_db import _login, _register

pytestmark = pytest.mark.db

SAMPLES = REPO_DIR / "Backend" / "seed_samples"
MR1, MR2 = SAMPLES / "mr_brain_sagittal_1.dcm", SAMPLES / "mr_brain_sagittal_2.dcm"
NII = SAMPLES / "mri_brain_axial.nii.gz"


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "storage_dir", tmp_path / "storage")
    return tmp_path / "storage"


@pytest.fixture()
def people(client, migrated_db):
    return {role: _login(client, role) for role in ("dokter_bedah", "radiografer", "radiolog")}


def _order(client, people, modality="MR"):
    nik, _ = _register(client, people["dokter_bedah"])
    r = client.post("/api/orders", headers=people["dokter_bedah"],
                    json={"patient": {"nik": nik}, "exam": {"modality": modality, "description": "MRI Kepala"}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _fresh_copy(tmp_path, src, n):
    """The sample files are shared by every test run; give each copy new UIDs so uploads don't collide."""
    import pydicom
    from pydicom.uid import generate_uid
    out = []
    study_uid, series_uid = generate_uid(), generate_uid()
    for i, f in enumerate(src[:n]):
        ds = pydicom.dcmread(f)
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.SOPInstanceUID = study_uid, series_uid, generate_uid()
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        p = tmp_path / f"slice{i}.dcm"
        ds.save_as(p)
        out.append(p)
    return out


def test_dicom_upload_flow(client, people, tmp_path):
    order_id = _order(client, people)
    files = _fresh_copy(tmp_path, [MR1, MR2], 2)
    up = [("files", (f.name, f.read_bytes(), "application/dicom")) for f in files]
    r = client.post("/api/studies", headers=people["radiografer"], files=up, data={"meta": json.dumps({"order_id": order_id})})
    assert r.status_code == 200, r.text
    study = r.json()
    assert study["added"] == 2 and study["series_count"] == 1 and study["instance_count"] == 2
    assert study["status"] == "unread" and study["order_id"] == order_id and study["modality"] == "MR"
    assert study["file"] == "slice0.dcm" and study["sent"] is False

    order = next(o for o in client.get("/api/orders", headers=people["radiografer"]).json() if o["id"] == order_id)
    assert order["status"] == "imaged" and order["study_id"] == study["id"]

    again = client.post("/api/studies", headers=people["radiografer"], files=up,
                        data={"meta": json.dumps({"order_id": order_id})})
    assert again.status_code == 409                       # the request already has images

    slices = client.get(f"/api/studies/{study['id']}/slices", headers=people["radiolog"]).json()
    assert slices["count"] == 2
    first = client.get(slices["urls"][0], headers=people["radiolog"])
    assert first.status_code == 200 and hashlib.sha256(first.content).hexdigest() == hashlib.sha256(files[0].read_bytes()).hexdigest()
    assert client.get(f"/api/studies/{study['id']}/file", headers=people["radiografer"]).status_code == 200
    assert client.get(f"/api/studies/{study['id']}/slices", headers=people["radiografer"]).status_code == 403

    # adding the same files again is harmless
    more = client.post(f"/api/studies/{study['id']}/instances", headers=people["radiografer"], files=up)
    assert more.status_code == 200 and more.json()["skipped"] == 2 and more.json()["instance_count"] == 2


def test_draft_and_redaction(client, people, tmp_path):
    order_id = _order(client, people)
    f = _fresh_copy(tmp_path, [MR1], 1)[0]
    sid = client.post("/api/studies", headers=people["radiografer"], files={"file": (f.name, f.read_bytes())},
                      data={"meta": json.dumps({"order_id": order_id})}).json()["id"]
    body = {"icd10": "G93.6", "diagnosis": "Cerebral oedema", "finding": "Edema serebri difus."}
    r = client.post(f"/api/studies/{sid}/reading", headers=people["radiolog"], json=body)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "draft" and r.json()["draft"]["finding"] == body["finding"]
    assert r.json()["icd10"] == ""                         # a draft is not the final reading

    seen = next(s for s in client.get("/api/studies", headers=people["radiografer"]).json() if s["id"] == sid)
    assert set(seen["draft"]) == {"saved"}                 # other roles only see that a draft exists

    cleared = client.post(f"/api/studies/{sid}/reading", headers=people["radiolog"],
                          json={"icd10": "", "diagnosis": "", "finding": ""}).json()
    assert cleared["draft"] is None and cleared["status"] == "unread"

    from sqlalchemy import func, select

    from app.core.db import SessionLocal
    from app.modules.reports.models import Report, ReportVersion
    with SessionLocal() as db:
        report_id = db.scalar(select(Report.id).where(Report.study_id == int(sid)))
        assert db.scalar(select(func.count()).where(ReportVersion.report_id == report_id)) == 2   # history kept


def test_finalize_sends_and_locks(client, people, tmp_path):
    """Finalize = POST /api/satusehat/send-study with archive_id (MOCK mode in tests)."""
    order_id = _order(client, people)
    f = _fresh_copy(tmp_path, [MR1], 1)[0]
    sid = client.post("/api/studies", headers=people["radiografer"], files={"file": (f.name, f.read_bytes())},
                      data={"meta": json.dumps({"order_id": order_id})}).json()["id"]
    client.post(f"/api/studies/{sid}/reading", headers=people["radiolog"],
                json={"icd10": "G93.6", "diagnosis": "Cerebral oedema", "finding": "Draf awal."})
    body = {"archive_id": sid, "name": "IGNORED", "nik": "0000000000000000", "modality": "DX",
            "description": "ignored", "icd10": "G93.6", "diagnosis": "Cerebral oedema", "finding": "Edema serebri difus."}
    r = client.post("/api/satusehat/send-study", headers=people["radiolog"], json=body)
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["ok"] and result["imaging_study_id"] and result["diagnostic_report_id"]

    study = next(s for s in client.get("/api/studies", headers=people["radiolog"]).json() if s["id"] == sid)
    assert study["sent"] is True and study["status"] == "final" and study["draft"] is None
    assert study["finding"] == "Edema serebri difus." and study["icd10"] == "G93.6"
    assert study["imaging_study_id"] == result["imaging_study_id"]
    assert study["diagnostic_report_id"] == result["diagnostic_report_id"]
    order = next(o for o in client.get("/api/orders", headers=people["radiolog"]).json() if o["id"] == order_id)
    assert order["status"] == "reported" and order["study"]["sent"] is True

    # the patient sent to SATUSEHAT came from the archive, not from the request body
    sent_names = [str(log) for log in result["logs"]]
    assert not any("IGNORED" in s for s in sent_names)

    assert client.post("/api/satusehat/send-study", headers=people["radiolog"], json=body).status_code == 409
    assert client.post(f"/api/studies/{sid}/reading", headers=people["radiolog"],
                       json={"finding": "ubah"}).status_code == 409

    from sqlalchemy import select

    from app.core.db import SessionLocal
    from app.modules.reports.models import Report, ReportVersion
    with SessionLocal() as db:
        report = db.scalar(select(Report).where(Report.study_id == int(sid)))
        statuses = db.scalars(select(ReportVersion.status).where(ReportVersion.report_id == report.id)
                              .order_by(ReportVersion.version)).all()
    assert report.status == "final" and report.finalized_at is not None and statuses == ["draft", "final"]


def test_nifti_upload(client, people):
    order_id = _order(client, people)
    r = client.post("/api/studies", headers=people["radiografer"],
                    files={"file": ("brain.nii.gz", NII.read_bytes())}, data={"meta": json.dumps({"order_id": order_id})})
    if r.status_code == 409:
        pytest.skip("this NIfTI sample is already in the test database from an earlier run")
    assert r.status_code == 200, r.text
    study = r.json()
    assert study["file"] == "brain.nii.gz" and study["instance_count"] > 1
    got = client.get(f"/api/studies/{study['id']}/file", headers=people["radiolog"])
    assert got.content == NII.read_bytes()                 # the original volume, unchanged


def test_refuses_non_images(client, people):
    order_id = _order(client, people)
    r = client.post("/api/studies", headers=people["radiografer"], files={"file": ("x.png", b"\x89PNG" + b"0" * 300)},
                    data={"meta": json.dumps({"order_id": order_id})})
    assert r.status_code == 400 and "Hanya berkas DICOM" in r.json()["detail"]
    order = next(o for o in client.get("/api/orders", headers=people["radiografer"]).json() if o["id"] == order_id)
    assert order["status"] == "requested"                  # nothing changed


def test_no_files_left_behind(client, people, tmp_path, store):
    order_id = _order(client, people)
    files = _fresh_copy(tmp_path, [MR1], 1)
    bad = tmp_path / "bad.txt"
    bad.write_text("not dicom")
    up = [("files", (files[0].name, files[0].read_bytes())), ("files", ("bad.txt", bad.read_bytes()))]
    r = client.post("/api/studies", headers=people["radiografer"], files=up, data={"meta": json.dumps({"order_id": order_id})})
    assert r.status_code == 400
    leftovers = [p for p in store.rglob("*") if p.is_file()]
    assert leftovers == []
