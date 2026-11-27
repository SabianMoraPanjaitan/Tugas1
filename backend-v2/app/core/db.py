"""Database connection.

- `engine` keeps a small pool of open PostgreSQL connections and re-uses them
  (opening a new connection for every request is slow).
- `get_db` is a FastAPI dependency: each request gets its own Session (a unit of work),
  committed if the endpoint finishes, rolled back if it raises.
  Endpoints that change data call `db.commit()` themselves before answering, so a failed commit
  becomes an error response instead of a "success" the database never kept.
"""
from collections.abc import Iterator

from sqlalchemy import BigInteger, MetaData, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings

# Predictable constraint names, so Alembic migrations can refer to them later.
NAMING = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)
    # Python `int` columns (ids, foreign keys) become BIGINT: a CT archive can pass 2 billion instances.
    # Columns that set Integer explicitly (slice numbers, rows, ...) stay 4-byte INTEGER.
    type_annotation_map = {int: BigInteger}


engine = create_engine(get_settings().database_url, pool_pre_ping=True, pool_size=5, max_overflow=10)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
