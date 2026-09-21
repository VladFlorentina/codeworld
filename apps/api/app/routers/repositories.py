import asyncio
import logging
import uuid
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from arq import create_pool
from arq.connections import RedisSettings

from app.config import settings
from app.database import get_db
from app.schemas import SubmitRepositoryRequest, SubmitRepositoryResponse
from app.services.repository_service import (
    authorize_repository_access,
    ensure_repository_analysis,
)
from codeworld_db import (
    AnalysisRun,
    AnalysisRunStatus,
    City,
    Repository,
    RepositoryStatus,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _parse_github_parts(url: str) -> tuple[str, str, str]:
    """Extract (owner, repo_name, full_name) from validated github url."""
    path = url.removeprefix("https://github.com/").strip("/")
    parts = [p for p in path.split("/") if p]
    owner, name = parts[0], parts[1]
    return owner, name, f"{owner}/{name}"


async def _get_remote_head_commit(clone_url: str, timeout_seconds: float = 5.0) -> str | None:
    """
    Resolve HEAD commit SHA using `git ls-remote <url> HEAD` without cloning.

    Runs via asyncio.create_subprocess_exec (no shell).
    Times out strictly after timeout_seconds, raising HTTP 504.
    Returns None if repository does not exist or is private (non-zero exit code).
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            "ls-remote",
            clone_url,
            "HEAD",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)
        if proc.returncode != 0:
            logger.warning(
                "git ls-remote failed",
                extra={
                    "clone_url": clone_url,
                    "returncode": proc.returncode,
                    "stderr": stderr.decode().strip(),
                },
            )
            return None
        output = stdout.decode().strip()
        if not output:
            return None
        # Format of stdout: "<40-hex-sha>\tHEAD"
        sha = output.split()[0]
        if len(sha) == 40 and all(c in "0123456789abcdefABCDEF" for c in sha):
            return sha.lower()
        return None
    except asyncio.TimeoutError:
        logger.error("git ls-remote timed out", extra={"clone_url": clone_url, "timeout": timeout_seconds})
        raise HTTPException(
            status_code=504,
            detail="Timeout resolving GitHub repository HEAD commit. Please try again.",
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("git ls-remote unexpected error", extra={"clone_url": clone_url, "error": str(exc)})
        raise HTTPException(
            status_code=500,
            detail=f"Failed to inspect GitHub repository: {str(exc)}",
        )


@router.post("/repositories", response_model=SubmitRepositoryResponse)
async def submit_repository(
    body: SubmitRepositoryRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> SubmitRepositoryResponse:
    """
    Ensure world operation for a GitHub repository.

    Flow:
      1. Resolves current HEAD commit SHA via `git ls-remote` (async + timeout).
      2. Gets or creates Repository (handling concurrent insertion via uq_repository_full_name).
      3. Checks if a complete City already exists for (repository + current_head_sha):
         -> return 200 with status="ready" (instant reuse).
      4. Checks if an active AnalysisRun (queued/running) exists for (repository + current_head_sha):
         -> return 202 with status="analyzing" (reuse in-flight operation).
      5. Otherwise, creates a new AnalysisRun with commit_sha populated immediately,
         commits to PostgreSQL, and enqueues to ARQ Redis:
         -> return 202 with status="newly_queued".
    """
    owner, name, full_name = _parse_github_parts(body.url)

    # 1. Resolve current HEAD commit SHA
    current_head_sha = await _get_remote_head_commit(body.url)
    if not current_head_sha:
        raise HTTPException(
            status_code=404,
            detail=f"GitHub repository not found or is inaccessible: {body.url}. Please verify the URL or ensure the repository is public.",
        )

    # 2. Delegate to unified ensure_repository_analysis
    resp_code, result = await ensure_repository_analysis(
        db=db,
        owner=owner,
        name=name,
        full_name=full_name,
        clone_url=body.url,
        current_head_sha=current_head_sha,
        is_private=False,
    )
    response.status_code = resp_code
    return result


@router.get("/repositories/{repository_id}")
async def get_repository(
    repository_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Get the status and metadata of a repository."""
    stmt = select(Repository).where(Repository.id == repository_id)
    res = await db.execute(stmt)
    repo = res.scalar_one_or_none()

    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")

    await authorize_repository_access(repo, request, db)

    return {
        "id": repo.id,
        "owner": repo.github_owner,
        "name": repo.github_name,
        "full_name": repo.full_name,
        "status": repo.status,
        "clone_url": repo.clone_url,
        "created_at": repo.created_at.isoformat() if repo.created_at else None,
        "updated_at": repo.updated_at.isoformat() if repo.updated_at else None,
    }
