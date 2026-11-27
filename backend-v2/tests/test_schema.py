"""Schema checks that need no database: the models compile to valid PostgreSQL DDL
and contain the DICOM hierarchy with its UID constraints."""
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable

import app.models as m

TABLES = {"roles", "users", "sessions", "patients", "orders", "studies", "series", "instances", "storage",
          "reports", "report_versions", "audit_logs", "operations"}


def test_all_tables_present():
    assert set(m.Base.metadata.tables) == TABLES


def test_models_compile_for_postgresql():
    dialect = postgresql.dialect()
    for table in m.Base.metadata.sorted_tables:
        assert "CREATE TABLE" in str(CreateTable(table).compile(dialect=dialect))


def _unique_columns(table):
    return {c.name for c in table.columns if c.unique} | {
        col.name for con in table.constraints if con.__class__.__name__ == "UniqueConstraint" for col in con.columns}


def test_dicom_uids_are_unique():
    t = m.Base.metadata.tables
    assert "study_instance_uid" in _unique_columns(t["studies"])
    assert "series_instance_uid" in _unique_columns(t["series"])
    assert "sop_instance_uid" in _unique_columns(t["instances"])


def test_hierarchy_foreign_keys():
    def targets(name):
        return {fk.target_fullname for fk in m.Base.metadata.tables[name].foreign_keys}
    assert "patients.id" in targets("studies")
    assert "studies.id" in targets("series")
    assert "series.id" in targets("instances")
    assert "storage.id" in targets("instances")


def test_ids_are_bigint():
    for table in m.Base.metadata.sorted_tables:
        if "id" in table.columns:
            assert str(table.columns["id"].type.compile(dialect=postgresql.dialect())) == "BIGINT", table.name
