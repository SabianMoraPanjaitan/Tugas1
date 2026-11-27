"""MyPACS backend v2: FastAPI + PostgreSQL, organised as a modular monolith.

Run from the backend-v2 folder:
    uvicorn app.main:app --reload --port 8000
Then open http://localhost:8000/mypacs/login.html  (the API lives under /api/*).
"""
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app.core.config import get_settings
from app.core.db import engine
from app.modules.archive.router import router as archive_router
from app.modules.auth.router import router as auth_router
from app.modules.operations.router import router as operations_router
from app.modules.orders.router import router as orders_router
from app.modules.patients.router import router as patients_router
from app.modules.satusehat.router import router as satusehat_router


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="MyPACS API", version="2.0")

    if settings.cors_origin_list:
        # Only needed when the pages are opened from another origin; the default (pages served
        # by this backend) is same-origin and needs no CORS at all.
        app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origin_list, allow_credentials=True,
                           allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                           allow_headers=["Authorization", "Content-Type"])

    @app.middleware("http")
    async def no_stale_pages(request: Request, call_next):
        """Browsers re-check pages and scripts on every load, so they never run an outdated copy."""
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/api/health", tags=["status"])
    def health():
        """api.js calls this to decide between live data and its demo data."""
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            database = "ok"
        except Exception:
            database = "unreachable"
        body = {"status": "ok" if database == "ok" else "degraded", "database": database,
                "mode": settings.satusehat_mode, "version": "2"}
        return JSONResponse(body, status_code=200 if database == "ok" else 503)

    app.include_router(auth_router)
    app.include_router(patients_router)
    app.include_router(orders_router)
    app.include_router(archive_router)
    app.include_router(satusehat_router)
    app.include_router(operations_router)

    # Serve the Frontend/ folder (MyPACS at /mypacs/...). Mounted LAST so it never hides an /api route.
    if settings.frontend_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.frontend_dir, html=True), name="frontend")
    return app


app = create_app()
