"""Imports every module's models so SQLAlchemy and Alembic see the whole schema."""
from app.core.db import Base  # noqa: F401
from app.modules.archive.models import Instance, Series, StoredFile, Study  # noqa: F401
from app.modules.audit.models import AuditLog  # noqa: F401
from app.modules.auth.models import Role, User, UserSession  # noqa: F401
from app.modules.operations.models import Operation  # noqa: F401
from app.modules.orders.models import Order  # noqa: F401
from app.modules.patients.models import Patient  # noqa: F401
from app.modules.reports.models import Report, ReportVersion  # noqa: F401
