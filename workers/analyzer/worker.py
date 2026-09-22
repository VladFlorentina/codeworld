from __future__ import annotations

import dataclasses
import logging
import os
import uuid
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
    Building,
    City,
    Connection,
    DependencyEdge,
    District,
    EdgeType,
    FileRecord,
    Repository,
    RepositoryStatus,
)

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

            file_rec_map: dict[str, str] = {}
            file_records_to_insert: list[FileRecord] = []
            cycle_nodes = {n for g in graph_analysis.circular_groups for n in g}

            for fa in file_analyses:
                f_id = str(uuid.uuid4())
                file_rec_map[fa.file_info.path] = f_id
                extra_metrics = {
                    "loc_total": fa.loc_total,
                    "loc_blank": fa.loc_blank,
                    "interface_count": fa.interface_count,
                    "in_degree": graph_analysis.in_degree.get(fa.file_info.path, 0),
                    "out_degree": graph_analysis.out_degree.get(fa.file_info.path, 0),
                    "is_in_cycle": fa.file_info.path in cycle_nodes,
                }
                file_records_to_insert.append(
                    FileRecord(
                        id=f_id,
                        run_id=run.id,
                        path=fa.file_info.path,
                        language=fa.file_info.language,
                        loc=fa.loc_code,
                        complexity=fa.complexity,
                        function_count=fa.function_count,
                        class_count=fa.class_count,
                        import_count=len(fa.imports),
                        metrics=extra_metrics,
                    )
                )

            session.add_all(file_records_to_insert)
            await session.flush()

            city_id = str(uuid.uuid4())
            city_row = City(
                id=city_id,
                run_id=run.id,
                repository_id=repo.id,
                generated_at=utcnow(),
            )
            session.add(city_row)
            await session.flush()

            districts_to_insert = [
                District(
                    id=d.id,
                    city_id=city_id,
                    parent_id=d.parent_id,
                    path=d.path,
                    name=d.name,
                    depth=d.depth,
                )
                for d in city_dto.districts
            ]
            session.add_all(districts_to_insert)
            await session.flush()

            buildings_to_insert = []
            for b in city_dto.buildings:
                fr_id = file_rec_map.get(b.path)
                if not fr_id:
                    fr_id = str(uuid.uuid4())
                    session.add(
                        FileRecord(
                            id=fr_id,
                            run_id=run.id,
                            path=b.path,
                            language=b.language,
                            loc=0,
                            metrics={},
                        )
                    )
                    await session.flush()

                buildings_to_insert.append(
                    Building(
                        id=b.id,
                        city_id=city_id,
                        district_id=b.district_id,
                        file_record_id=fr_id,
                        name=b.name,
                        path=b.path,
                        color_hex=b.color_hex,
                        height=1.0,
                        width=1.0,
                        depth=1.0,
                        position_x=0.0,
                        position_z=0.0,
                    )
                )
            session.add_all(buildings_to_insert)
            await session.flush()

            valid_bld_ids = {b.id for b in buildings_to_insert}
            connections_to_insert = [
                Connection(
                    id=c.id,
                    city_id=city_id,
                    source_building_id=c.source_building_id,
                    target_building_id=c.target_building_id,
                    connection_type=c.connection_type,
                )
                for c in city_dto.connections
                if c.source_building_id in valid_bld_ids and c.target_building_id in valid_bld_ids
            ]
            session.add_all(connections_to_insert)
            await session.flush()

            dep_edges_to_insert = [
                DependencyEdge(
                    id=str(uuid.uuid4()),
                    run_id=run.id,
                    source_file=e.source_path,
                    target_file=e.target,
                    edge_type=EdgeType.import_ if e.edge_type == "import" else EdgeType.package,
                )
                for e in graph_analysis.edges
            ]
            session.add_all(dep_edges_to_insert)
            await session.flush()

            current_meta = dict(run.analysis_meta or {})
            current_meta["summary"] = dataclasses.asdict(city_dto.summary)
            run.analysis_meta = current_meta
            run.commit_sha = commit_sha
            run.status = AnalysisRunStatus.complete
            run.completed_at = utcnow()
            repo.status = RepositoryStatus.ready

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
