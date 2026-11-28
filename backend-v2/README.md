# MyPACS backend v2 (FastAPI + PostgreSQL)

A new backend for the MyPACS frontend (`Frontend/mypacs`). It replaces the old `Backend/`, which used SQLite
and a JSON file, with **PostgreSQL** and a proper DICOM schema (Patient → Study → Series → Instance).
It keeps the **same `/api/...` URLs** the MyPACS pages already call, so the frontend doesn't need changes.

The old `Backend/` is untouched and still works. Both use port 8000, so run only one of them at a time.

## Status

| Part | State |
|---|---|
| Full database schema (13 tables), first migration, indexes, audit-log protection | ✅ done |
| `/api/health`, `/api/auth/login · logout · me · tab-session` | ✅ done (same answers as the old backend) |
| Account script (`scripts/manage_users.py`) | ✅ done |
| `GET/POST /api/patients` (registration goes through SATUSEHAT, live or mock) | ✅ done |
| `GET/POST /api/orders`, `POST /api/orders/{id}/return` | ✅ done |
| SATUSEHAT client (ported unchanged; only patient registration uses it so far) | ✅ ported |
| `/api/studies`: upload, list, `/file`, `/slices`, `/reading` (drafts) | ✅ done |
| DICOM ingest into study → series → instance, NIfTI kept and converted to DICOM slices | ✅ done |
| `/api/satusehat/send-study` (the viewer's **Finalize**), `/patient`, `/token`, raw passthroughs | ✅ done |
| `/api/operations` + `/api/satusehat/send-procedure` (Bedah) | ✅ done |

**Every endpoint the old backend had is ported**, with two exceptions:
- `POST /api/normalize-series` is left out on purpose (see below).
- `GET /api/series/{sid}/{name}` is replaced by `GET /api/instances/{uid}/file`. Pages only ever got those URLs from `/slices`, which now returns the new ones. The MyPACS radiology flow is covered:
1. A ward makes a request (`dept.html`), or radiology sends it back (`orders.html`).
2. The radiographer uploads images (`upload.html`).
3. The study appears in the worklist (`home.html`).
4. The radiologist opens it in the viewer, uses **Save Draft**, then **Finalize**.

The Bedah module (`bedah.html`) is covered too: it saves operations and sends them as Encounter + Procedure.
An operation must now belong to a **registered** patient (`bedah.html` already picks patients from the registry).
A sent operation is read-only, and sending one twice is refused.

### Finalize (send-study)
When the request carries `archive_id`, which MyPACS always sends:
1. **Lock:** the study row is locked, so two radiologists can't send the same study twice.
2. **Source of truth:** the patient, exam and modality are taken from the database, not from the browser.
3. **Send:** the chain Encounter → ServiceRequest → ImagingStudy → Observation → DiagnosticReport goes to SATUSEHAT (live, or mock without credentials).
4. **Save:** only if SATUSEHAT accepts the chain, the report becomes final (one more row in `report_versions`), the study is marked final and the request reported, all in one commit.

A failed send changes nothing except an audit entry (`send_study_failed`) that records which step was refused.
A finalised study refuses both a second Finalize and further draft edits (409). Amending a final report is a later feature.

Known limit: the SATUSEHAT client was ported unchanged, and it still makes up a placeholder series/instance UID for the
ImagingStudy. Sending the real UIDs from the archive is a small follow-up, but it has to be re-checked against the live sandbox.

### How images are stored
1. An upload is copied to `storage/tmp` in 1 MB chunks, and its SHA-256 is worked out as it's copied, so a big file never sits fully in memory.
2. Each file must be DICOM or NIfTI. Anything else is refused.
3. The DICOM tags are read (pydicom, without pixel data). StudyInstanceUID, SeriesInstanceUID and SOPInstanceUID must exist and be well formed, and every file in one upload must belong to one study.
4. Rows are created in `studies`, `series` and `instances`, plus one `storage` row per file. The bytes go to `storage/dicom/ab/cd/<sha256>.dcm`.
5. Uploading an image that's already archived with identical bytes is skipped. The same SOPInstanceUID with *different* bytes is refused.
6. A NIfTI volume is kept unchanged (`storage/nifti/...`) and also converted into DICOM slices (`storage/derived/...`), using the old backend's converter. `/file` returns the original volume; `/slices` returns the converted slices.
7. If anything fails, the database transaction is rolled back and the files this upload wrote are deleted, so no file is left on disk without a database row.

The radiology request decides which patient a study belongs to. If the PatientID inside the files is different,
the upload still succeeds, and the answer includes a warning (`warnings`).

What is different from the old backend:
- Requests have accession numbers (`RQ-yymmdd-XXXX`), which double as the request id.
- Patients get an MRN (`MR00000001`).
- Study ids are numbers (as strings, e.g. `"12"`), not 12-character hex codes.
- `POST /api/studies` also accepts several `files` at once. `POST /api/studies/{id}/instances` adds more files later, so a large CT can go up in batches.
  MyPACS's upload page still sends one file; letting it send a whole series is a small frontend change for later.
- New read endpoints:
  - `GET /api/studies/{id}/series`
  - `GET /api/series/{uid}/instances`
  - `GET /api/instances/{uid}/file`
- `GET /api/patients` accepts `?q=` to search, and the list endpoints accept `?limit=&offset=`.
- Lists, study opening, uploads and draft saves are written to the audit log.
- A study must have at least one image. The old backend allowed a study with no file.
- `POST /api/normalize-series` (used only by the old `pacs.html`) is **not** ported. It rewrote the FrameOfReferenceUID
  inside the images, and the MyPACS viewer doesn't need it.

## Folder layout

```
backend-v2/
├─ app/
│  ├─ main.py                 creates the FastAPI app, health check, serves ../Frontend
│  ├─ models.py               imports every module's tables (for Alembic)
│  ├─ core/                   shared plumbing
│  │  ├─ config.py            settings from .env
│  │  ├─ db.py                PostgreSQL connection pool, per-request session
│  │  └─ security.py          password hashing, session tokens
│  └─ modules/                one folder per area; each can grow router.py / service.py / models.py
│     ├─ auth/                users, roles, sessions, login endpoints, require_roles()
│     ├─ patients/            patient registry
│     ├─ orders/              radiology requests (= worklist)
│     ├─ archive/             studies, series, instances, storage (file locations)
│     ├─ reports/             reports + report_versions (edit history)
│     ├─ audit/               append-only audit log + record() helper
│     ├─ operations/          surgery (Bedah) module
│     └─ satusehat/           FHIR client (from the old backend) + its settings
├─ migrations/versions/       database migrations (Alembic)
├─ scripts/manage_users.py    create / list accounts, change passwords
└─ tests/
```

## First-time setup (Windows)

### 1. Install PostgreSQL
1. Download the **PostgreSQL 17** Windows installer from https://www.postgresql.org/download/windows/ (the "EDB" installer).
2. Run it and keep the defaults (port **5432**). Pick a password for the `postgres` superuser and write it down.
   You can untick *Stack Builder* at the end.

### 2. Create the database user and databases
Open PowerShell and run these one at a time. Each asks for the `postgres` password.
Replace `choose-a-password` with your own password, and use the same one in step 3.

```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -c "CREATE ROLE pacs LOGIN PASSWORD 'choose-a-password';"
```
```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -c "CREATE DATABASE pacs OWNER pacs;"
```
```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -c "CREATE DATABASE pacs_test OWNER pacs;"
```
`pacs` is for the app. `pacs_test` is a throwaway database for the automated tests.

### 3. Configure and install the backend
Run from this `backend-v2` folder:
```powershell
Copy-Item .env.example .env
```
Edit `.env` and put your password into `DATABASE_URL`, for example `postgresql+psycopg://pacs:choose-a-password@localhost:5432/pacs`.
```powershell
python -m venv .venv
```
```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 4. Create the tables and demo accounts
```powershell
.\.venv\Scripts\alembic.exe upgrade head
```
```powershell
.\.venv\Scripts\python.exe -m scripts.manage_users demo
```
The demo accounts match the old backend (`admin/admin123`, `radiolog/radiolog123`, ...). **Sandbox use only.**

### 5. Run it
```powershell
.\.venv\Scripts\uvicorn.exe app.main:app --reload --port 8000
```
- http://localhost:8000/api/health should return `"status": "ok", "database": "ok"`.
- http://localhost:8000/docs is the interactive API documentation (FastAPI builds it automatically).
- http://localhost:8000/mypacs/login.html: log in as `radiolog` / `radiolog123`.

## Tests
```powershell
.\.venv\Scripts\python.exe -m pytest -q
```
Without a test database, the tests that need PostgreSQL are **skipped**. To run them too, point `TEST_DATABASE_URL`
at the `pacs_test` database (never at `pacs`):
```powershell
$env:TEST_DATABASE_URL = "postgresql+psycopg://pacs:choose-a-password@localhost:5432/pacs_test"; .\.venv\Scripts\python.exe -m pytest -q
```
The database tests check:
- login, logout and tab sessions
- registering, searching and rejecting duplicate patients
- the request flow: create, filter by status or NIK, send back, and refuse a second send-back
- uploading a two-slice MR series and a NIfTI volume, the request moving to "imaged", slices and files coming back byte for byte, drafts and their version history, and that a failed upload leaves no files behind
- Bedah: saving and updating an operation, sending it, and refusing a second send or an edit after sending
- Finalize: the report becomes final, the request reported, the SATUSEHAT ids are saved, browser-sent patient details are ignored, and a second send is refused
- that failed logins and patient registrations are written to the audit log
- that the audit log refuses UPDATE and DELETE
- that duplicate or malformed DICOM UIDs are rejected
- that the models and the migration match (`alembic check`)

## Design notes (short version; see `docs/01-architecture-assessment.md` in PACS-Project for the full reasoning)
- **Internal `id` and DICOM UID:** every archive table has a short `bigint` id for joins, *and* its DICOM UID with a `UNIQUE` constraint plus a format check (digits and dots, at most 64 characters).
- **File bytes live on disk** (`storage/`), and every file has a row in the `storage` table with its size and SHA-256. Everything else is in PostgreSQL.
- **Sessions are kept in the database**, not in a JWT, so logout and password changes take effect immediately. Only a SHA-256 of each token is stored.
- **Passwords:** PBKDF2-SHA256 with 600,000 iterations and a per-user salt.
- **The audit log is append-only**, enforced by a database trigger.
- **Changing the schema:** edit the model, then run `alembic revision --autogenerate -m "what changed"`, read the generated file, and run `alembic upgrade head`. Never edit a migration that has already been applied somewhere else.
