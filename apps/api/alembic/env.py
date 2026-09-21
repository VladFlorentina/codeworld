"""
Alembic migration environment.

This file is the bridge between Alembic and our SQLAlchemy models.
It tells Alembic:
  1. How to connect to the database.
  2. Where to find our ORM models (for autogenerate).

Key design decisions:
  - We import Base from app.models so Alembic's autogenerate can
    detect schema changes by comparing models to the live database.
  - We read DATABASE_URL from the environment, not from alembic.ini,
    so the same migration files work in Docker and locally.
  - We use psycopg2 (synchronous) for Alembic. Alembic does not
    support async drivers. We swap the driver prefix at runtime.
"""
import os
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool
from alembic import context

# Import our models so Alembic can detect them for autogenerate
from app.models import *  # noqa: F401, F403
from app.database import Base

# Alembic Config object — provides access to alembic.ini values
config = context.config

# Set up Python logging from alembic.ini
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Tell Alembic about our schema — this enables autogenerate
target_metadata = Base.metadata


def get_database_url() -> str:
    """
    Read the database URL from the environment.

    Alembic uses psycopg2 (synchronous), but our app uses asyncpg.
    We replace the async driver prefix so the same DATABASE_URL works.
    """
    url = os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg2://codeworld:codeworld@localhost:5432/codeworld",
    )
    # Replace asyncpg driver with psycopg2 for Alembic
    return url.replace("postgresql+asyncpg", "postgresql+psycopg2")


def run_migrations_offline() -> None:
    """
    Run migrations in 'offline' mode.

    This emits migration SQL to stdout without connecting to the database.
    Useful for reviewing what a migration will do before applying it.
    """
    url = get_database_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """
    Run migrations in 'online' mode — connects to the database directly.
    This is what `alembic upgrade head` uses.
    """
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = get_database_url()

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,  # Don't pool connections in migration scripts
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            # compare_type=True enables detecting column type changes
            compare_type=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
