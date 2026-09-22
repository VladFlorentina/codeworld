from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

from arq.connections import RedisSettings
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from analyzer.ast import analyze_file
from analyzer.cloner import cleanup_clone, clone_repository
from analyzer.deps import build_dependency_graph
from analyzer.discovery import discover_files
from analyzer.world_generator import generate_city_dto
from codeworld_github_app import create_installation_access_token
from codeworld_db import (
    AnalysisRun,
    AnalysisRunStatus,
    Repository,
    RepositoryStatus,
)
from persistence import persist_analysis_result

logger = logging.getLogger(__name__)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+asyncpg://codeworld:codeworld@localhost:5432/codeworld")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def analyze_repository(
    ctx: dict,
    repository_id: str,
    run_id: str,
    installation_id: int | None = None,
    github_repository_id: int | None = None,
) -> dict:
    """Execute repository analysis pipeline and persist city model."""
    session_factory: async_sessionmaker[AsyncSession] = ctx["session_factory"]

    async with session_factory() as session:
        repo = await session.get(Repository, repository_id)
        run = await session.get(AnalysisRun, run_id)
        if not repo or not run:
            logger.error("Repository or AnalysisRun not found", extra={"repo_id": repository_id, "run_id": run_id})
            return {"status": "failed", "error": "Entity not found"}

        run.status = AnalysisRunStatus.running
        run.started_at = utcnow()
        await session.commit()
        clone_url = repo.clone_url
        full_name = repo.full_name
        is_private = repo.is_private
        db_gh_repo_id = repo.github_repository_id
        target_commit_sha = run.commit_sha

    clone_path = None
    auth_token = None
    try:
        logger.info(
            "Starting pipeline execution",
            extra={"full_name": full_name, "run_id": run_id, "is_private": is_private},
        )

        target_inst_id = installation_id
        if target_inst_id is None and run.analysis_meta and isinstance(run.analysis_meta, dict):
            target_inst_id = run.analysis_meta.get("installation_id")

        target_gh_repo_id = github_repository_id or db_gh_repo_id

        if is_private and target_inst_id:
            logger.info(
                "Generating in-memory scoped installation token for private clone",
                extra={"installation_id": target_inst_id, "github_repository_id": target_gh_repo_id},
            )
            scoped_repos = [target_gh_repo_id] if target_gh_repo_id else None
            token_dto = await create_installation_access_token(
                installation_id=target_inst_id,
                repository_ids=scoped_repos,
            )
            auth_token = token_dto.token

        clone_path, owner, repo_name, commit_sha = clone_repository(
            clone_url,
            auth_token=auth_token,
            expected_commit_sha=target_commit_sha,
        )
        auth_token = None  # Token kept only in local runtime scope, dropped after clone

        files, skipped = discover_files(clone_path)
        file_analyses = [analyze_file(f) for f in files]
        file_set = {f.path for f in files}
        graph_analysis = build_dependency_graph(file_analyses, file_set)
        city_dto = generate_city_dto(
            files,
            file_analyses,
            graph_analysis,
            full_name,
            commit_sha,
            scope=run_id,
        )

        async with session_factory() as session:
            repo = await session.get(Repository, repository_id)
            run = await session.get(AnalysisRun, run_id)
            if not repo or not run:
                logger.error("Repository or AnalysisRun not found before persistence", extra={"repo_id": repository_id, "run_id": run_id})
                return {"status": "failed", "error": "Entity not found"}

            city_id = await persist_analysis_result(
                session,
                repo,
                run,
                file_analyses=file_analyses,
                graph_analysis=graph_analysis,
                city_dto=city_dto,
                commit_sha=commit_sha,
            )
            await session.commit()
            logger.info("Pipeline and persistence completed successfully", extra={"run_id": run.id, "city_id": city_id})
            return {"status": "complete", "repository_id": repo.id, "run_id": run.id}

    except Exception as exc:
        logger.error("Analysis pipeline failed with exception", extra={"run_id": run_id, "error": str(exc)}, exc_info=True)
        async with session_factory() as session:
            run = await session.get(AnalysisRun, run_id)
            repo = await session.get(Repository, repository_id)
            if run:
                run.status = AnalysisRunStatus.failed
                run.completed_at = utcnow()
                run.error_message = str(exc)
            if repo:
                repo.status = RepositoryStatus.failed
            await session.commit()
        return {"status": "failed", "error": str(exc)}
    finally:
        auth_token = None
        if clone_path:
            cleanup_clone(clone_path)


class WorkerSettings:
    functions = [analyze_repository]
    redis_settings = RedisSettings.from_dsn(REDIS_URL)
    max_jobs = 4
    job_timeout = 600
    keep_result = 3600

    @staticmethod
    async def on_startup(ctx: dict) -> None:
        logger.info("Starting up CodeWorld analysis worker")
        engine = create_async_engine(DATABASE_URL, pool_size=5, max_overflow=10)
        ctx["engine"] = engine
        ctx["session_factory"] = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

    @staticmethod
    async def on_shutdown(ctx: dict) -> None:
        logger.info("Shutting down CodeWorld analysis worker")
        engine = ctx.get("engine")
        if engine:
            await engine.dispose()
