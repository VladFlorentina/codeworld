from __future__ import annotations

import logging
import uuid
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.services.repository_service import authorize_repository_access
from codeworld_db import AnalysisRun, Repository

logger = logging.getLogger(__name__)

router = APIRouter()


def _sanitize_error_message(raw_error: str | None) -> str | None:
    """
    Sanitize error message to prevent leaking tracebacks, environment variables,
    credentials, or internal server paths. Returns safe user-facing explanations.
    """
    if not raw_error:
        return None

    err_lower = raw_error.lower()
    if "too large" in err_lower or "max_repo_size" in err_lower:
        return "Repository exceeds maximum supported size limit."
    if "timeout" in err_lower:
        return "Repository analysis timed out."
    if "authentication failed" in err_lower or "bad credentials" in err_lower:
        return "GitHub authentication failed while accessing the repository."
    if "not our ref" in err_lower or "mismatch" in err_lower or "expected commit" in err_lower:
        return "Specified commit SHA could not be checked out."
    if "git clone failed" in err_lower:
        return "Failed to clone repository from GitHub."
    if "empty repository" in err_lower or "no supported files" in err_lower:
        return "No supported source files found in repository."
    if "not found" in err_lower:
        return "Repository not found on GitHub."

    return "Repository analysis failed during pipeline processing."


@router.get("/jobs/{job_id}")
async def get_job_status(
    job_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Get the status of an analysis job with sanitized errors and repo authorization."""
    conditions = [AnalysisRun.analysis_meta["job_id"].as_string() == job_id]
    try:
        val_uuid = str(uuid.UUID(job_id))
        conditions.append(AnalysisRun.id == val_uuid)
    except (ValueError, TypeError, AttributeError):
        pass

    stmt = select(AnalysisRun).where(or_(*conditions))
    res = await db.execute(stmt)
    run = res.scalar_one_or_none()

    if not run:
        raise HTTPException(status_code=404, detail="Analysis job not found")

    repo = await db.get(Repository, run.repository_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")

    await authorize_repository_access(repo, request, db)

    return {
        "job_id": job_id,
        "run_id": run.id,
        "repository_id": run.repository_id,
        "status": run.status.value,
        "error": _sanitize_error_message(run.error_message),
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
    }
