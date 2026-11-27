"""Test setup.

Tests marked `db` need PostgreSQL. They run against TEST_DATABASE_URL (a separate, throwaway database,
e.g. postgresql+psycopg://pacs:...@localhost:5432/pacs_test), never against your normal one.
Without TEST_DATABASE_URL they are skipped.
"""
import os

import pytest

TEST_DB = os.environ.get("TEST_DATABASE_URL", "")
if TEST_DB:
    os.environ["DATABASE_URL"] = TEST_DB        # must happen before app modules are imported
else:
    # Point at a port nothing listens on, so no test can touch a real database by accident.
    os.environ["DATABASE_URL"] = "postgresql+psycopg://nobody:nothing@127.0.0.1:1/none?connect_timeout=1"


def pytest_configure(config):
    config.addinivalue_line("markers", "db: needs PostgreSQL (TEST_DATABASE_URL)")


def pytest_collection_modifyitems(config, items):
    if TEST_DB:
        return
    skip = pytest.mark.skip(reason="TEST_DATABASE_URL not set")
    for item in items:
        if "db" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def migrated_db():
    """Bring the test database to the latest migration (once per test run)."""
    from alembic import command
    from alembic.config import Config

    from app.core.config import BACKEND_DIR

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    command.upgrade(cfg, "head")
    return cfg


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from app.main import app
    return TestClient(app)
