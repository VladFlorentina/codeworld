from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.schemas import SubmitRepositoryResponse
from app.security.session import verify_session_cookie_value
from app.services import github_installations
from app.services.github_auth import AuthenticationRequiredException, get_valid_user_access_token
from codeworld_db import (
    AnalysisRun,
    AnalysisRunStatus,
    City,
    Repository,
    RepositoryStatus,
    User,
)

logger = logging.getLogger(__name__)


def parse_github_parts(url: str) -> tuple[str, str, str]:
    """Extract (owner, repo_name, full_name) from validated github url."""
    path = url.removeprefix("https://github.com/").strip("/")
    parts = [p for p in path.split("/") if p]
    owner, name = parts[0], parts[1]
    return owner, name, f"{owner}/{name}"


async def get_remote_head_commit(clone_url: str, timeout_seconds: float = 5.0) -> str | None:
    """Resolve HEAD commit SHA using git ls-remote without cloning."""
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


async def authorize_repository_access(
    repo: Repository,
    request: Request,
    db: AsyncSession,
) -> User | None:
    """
    Authorize access to a Repository.

    Security rules:
      - Public repository (is_private=False):
        Anonymous access allowed immediately without calling GitHub. Returns None.
      - Private repository (is_private=True):
        Requires an active CodeWorld session cookie and live verification
        via GitHub App that the authenticated user has access to
        repo.github_repository_id.
        - Missing or invalid session -> raises HTTP 401 Unauthorized.
        - User not found -> raises HTTP 401 Unauthorized.
        - User lacks access to numeric repo.github_repository_id -> raises HTTP 403 Forbidden.
        - Authorized -> returns authenticated User.
    """
    if not repo.is_private:
        return None

    session_cookie = request.cookies.get(settings.session_cookie_name)
    if not session_cookie:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required to access this private repository.",
        )
    try:
        user_id = verify_session_cookie_value(session_cookie)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session cookie.",
        )

    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found.",
        )

    try:
        user_token = await get_valid_user_access_token(user, db)
        accessible_repos = await github_installations.fetch_all_user_repositories(access_token=user_token)
    except AuthenticationRequiredException:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="GitHub session expired or revoked. Please log in again.",
        )

    accessible_gh_ids = {r["id"] for r in accessible_repos}

    if not repo.github_repository_id or repo.github_repository_id not in accessible_gh_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: user does not have access to this private repository.",
        )

    return user


async def ensure_repository_analysis(
    db: AsyncSession,
    owner: str,
    name: str,
    full_name: str,
    clone_url: str,
    current_head_sha: str,
    is_private: bool = False,
    github_repository_id: int | None = None,
    default_branch: str = "main",
    installation_id: int | None = None,
) -> tuple[int, SubmitRepositoryResponse]:
    """Ensure repository analysis with deduplication, concurrency lock, and ARQ queueing."""
    stmt = select(Repository).where(Repository.full_name == full_name)
    res = await db.execute(stmt)
    repo = res.scalar_one_or_none()

    if repo is None:
        try:
            repo = Repository(
                github_owner=owner,
                github_name=name,
                full_name=full_name,
                clone_url=clone_url,
                default_branch=default_branch,
                is_private=is_private,
                github_repository_id=github_repository_id,
                status=RepositoryStatus.pending,
            )
            db.add(repo)
            await db.flush()
        except IntegrityError:
            await db.rollback()
            res = await db.execute(stmt)
            repo = res.scalar_one_or_none()
            if repo is None:
                raise HTTPException(status_code=500, detail="Failed to acquire repository record.")
    else:
        if repo.is_private != is_private:
            repo.is_private = is_private
        if github_repository_id is not None and repo.github_repository_id != github_repository_id:
            repo.github_repository_id = github_repository_id
        if default_branch and repo.default_branch != default_branch:
            repo.default_branch = default_branch
        await db.flush()

    # Advisory lock serializes concurrent analysis requests for identical repo + commit SHA
    lock_key = f"codeworld:analyze:{repo.id}:{current_head_sha}"
    await db.execute(select(func.pg_advisory_xact_lock(func.hashtext(lock_key))))

    city_stmt = (
        select(City, AnalysisRun)
        .join(AnalysisRun, City.run_id == AnalysisRun.id)
        .where(
            City.repository_id == repo.id,
            AnalysisRun.commit_sha == current_head_sha,
            AnalysisRun.status == AnalysisRunStatus.complete,
        )
        .order_by(City.generated_at.desc())
    )
    city_match = (await db.execute(city_stmt)).first()

    if city_match:
        city, run = city_match
        return status.HTTP_200_OK, SubmitRepositoryResponse(
            status="ready",
            repository_id=repo.id,
            run_id=run.id,
            job_id=None,
            commit_sha=current_head_sha,
            message="City is already analyzed and ready.",
        )

    active_run_stmt = (
        select(AnalysisRun)
        .where(
            AnalysisRun.repository_id == repo.id,
            AnalysisRun.commit_sha == current_head_sha,
            AnalysisRun.status.in_([AnalysisRunStatus.queued, AnalysisRunStatus.running]),
        )
        .order_by(AnalysisRun.created_at.desc())
    )
    active_run = (await db.execute(active_run_stmt)).scalar_one_or_none()

    if active_run:
        existing_job_id = None
        if active_run.analysis_meta and isinstance(active_run.analysis_meta, dict):
            existing_job_id = active_run.analysis_meta.get("job_id")
        if not existing_job_id:
            existing_job_id = active_run.id

        return status.HTTP_202_ACCEPTED, SubmitRepositoryResponse(
            status="analyzing",
            repository_id=repo.id,
            run_id=active_run.id,
            job_id=existing_job_id,
            commit_sha=current_head_sha,
            message="Analysis is already in progress for this commit.",
        )

    run_id = str(uuid.uuid4())
    job_id = str(uuid.uuid4())
    meta: dict[str, Any] = {"job_id": job_id}
    if installation_id is not None:
        meta["installation_id"] = installation_id

    run = AnalysisRun(
        id=run_id,
        repository_id=repo.id,
        commit_sha=current_head_sha,
        status=AnalysisRunStatus.queued,
        analysis_meta=meta,
    )
    repo.status = RepositoryStatus.analyzing
    db.add(run)
    await db.commit()

    redis_pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
    try:
        job = await redis_pool.enqueue_job(
            "analyze_repository",
            repository_id=repo.id,
            run_id=run.id,
            installation_id=installation_id,
            github_repository_id=github_repository_id or repo.github_repository_id,
            _job_id=job_id,
        )
        if job is None:
            logger.error("Failed to enqueue job in Redis", extra={"job_id": job_id})
            run.status = AnalysisRunStatus.failed
            run.error_message = "Failed to enqueue job in Redis queue."
            await db.commit()
            raise HTTPException(status_code=500, detail="Failed to enqueue analysis job in queue.")
    except Exception as enqueue_exc:
        logger.error(
            "Exception while enqueueing job in Redis",
            extra={"job_id": job_id, "error": str(enqueue_exc)},
        )
        run.status = AnalysisRunStatus.failed
        run.error_message = f"Failed to enqueue in Redis: {str(enqueue_exc)}"
        await db.commit()
        raise HTTPException(
            status_code=500,
            detail=f"Failed to enqueue analysis job: {str(enqueue_exc)}",
        )
    finally:
        await redis_pool.aclose()

    logger.info(
        "Repository queued for analysis",
        extra={
            "repository_id": repo.id,
            "run_id": run.id,
            "job_id": job_id,
            "commit_sha": current_head_sha,
            "full_name": full_name,
            "is_private": is_private,
        },
    )

    return status.HTTP_202_ACCEPTED, SubmitRepositoryResponse(
        status="newly_queued",
        repository_id=repo.id,
        run_id=run.id,
        job_id=job_id,
        commit_sha=current_head_sha,
        message=f"Repository {full_name} queued for analysis.",
    )
