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
| `/api/studies` (upload, list, slices, reading), DICOM parsing into series/instances, NIfTI | ⏳ next |
| `/api/satusehat/send-study`, `/api/operations` + `send-procedure` (Bedah) | ⏳ after that |

**What works against v2 right now:**
- Login.
- Patient registration.
- Creating requests on `dept.html`.
- Sending requests back on `orders.html`.

**What doesn't work yet:** the worklist (`home.html`), the viewer and the upload page also call `/api/studies`, which isn't ported yet.
Use the old `Backend/` for full demos until it is.

What is different from the old backend (the pages don't depend on any of it):
- Requests have accession numbers (`RQ-yymmdd-XXXX`), which double as the request id.
- Patients get an MRN (`MR00000001`).
- `GET /api/patients` accepts `?q=` to search, and both lists accept `?limit=&offset=`.
- Viewing the patient or request lists is written to the audit log.

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
