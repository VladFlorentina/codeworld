from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

# ─── Engine ───────────────────────────────────────────────────
# echo=True in development prints every SQL statement to stdout.
# This is invaluable for debugging — turn it off in production.
engine = create_async_engine(
    settings.database_url,
    echo=settings.is_development,
    pool_size=5,
    max_overflow=10,
)

# ─── Session factory ──────────────────────────────────────────
# expire_on_commit=False means ORM objects remain usable after
# a commit without issuing extra SELECT queries. This is the
# correct default for async SQLAlchemy usage in FastAPI.
AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

from codeworld_db.base import Base


# ─── Dependency for FastAPI route handlers ────────────────────
async def get_db() -> AsyncSession:
    """
    FastAPI dependency that yields an async database session.

    Usage in a route:
        async def my_route(db: AsyncSession = Depends(get_db)):
            ...

    The session is automatically closed after the request completes,
    even if an exception is raised.
    """
    async with AsyncSessionLocal() as session:
        yield session
