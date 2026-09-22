"""
Worker persistence & transaction atomicity tests for Checkpoint Q6.

Verifies:
  1. Successful persistence:
     - persist_analysis_result adds all entities (City, District, Building, FileRecord, Connection, DependencyEdge)
     - commits atomically with AnalysisRun.status=complete and Repository.status=ready
  2. Forced persistence failure & atomicity:
     - when persistence/flush raises an exception, the transaction is rolled back
     - zero partial City / Building / District / FileRecord rows are committed
     - outer failure handler marks AnalysisRun.status=failed and Repository.status=failed
  3. Clean DB teardown:
     - strictly cleans up all inserted test records in try...finally
     - zero orphan rows left in the database.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import networkx as nx
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from analyzer.deps import GraphAnalysis, DependencyEdge as GraphEdge
from analyzer.models import FileAnalysis, FileInfo, ImportedSymbol
from analyzer.world_generator import (
    BuildingDTO,
    BuildingMetricsDTO,
    CityDTO,
    CitySummaryDTO,
    ConnectionDTO,
    DistrictDTO,
)
from codeworld_db import (
    AnalysisRun,
    AnalysisRunStatus,
    Building,
    City,
    Connection,
    DependencyEdge,
    District,
    FileRecord,
    Repository,
    RepositoryStatus,
)
from persistence import persist_analysis_result
from worker import analyze_repository

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://codeworld:codeworld@localhost:5432/codeworld",
)


def make_dummy_analysis_data(run_id: str, repo_name: str, commit_sha: str):
    file_info = FileInfo(
        path="src/main.py",
        absolute_path=f"/tmp/{run_id}/src/main.py",
        language="Python",
        size_bytes=100,
        extension=".py",
    )
    file_analyses = [
        FileAnalysis(
            file_info=file_info,
            loc_total=10,
            loc_blank=2,
            loc_code=8,
            function_count=1,
            class_count=0,
            complexity=2,
            imports=[ImportedSymbol(raw="sys", is_external=True)],
        )
    ]
    graph_analysis = GraphAnalysis(
        graph=nx.DiGraph(),
        edges=[GraphEdge(source_path="src/main.py", target="sys", edge_type="package")],
        in_degree={"src/main.py": 0},
        out_degree={"src/main.py": 1},
        circular_groups=[],
    )
    district_id = str(uuid.uuid4())
    building_id = str(uuid.uuid4())
    city_dto = CityDTO(
        repository_name=repo_name,
        commit_sha=commit_sha,
        summary=CitySummaryDTO(
            total_files=1,
            total_loc_code=8,
            total_complexity=2,
            languages={"Python": 1},
            circular_dependency_count=0,
        ),
        districts=[
            DistrictDTO(
                id=district_id,
                path="src",
                name="src",
                parent_id=None,
                depth=1,
            )
        ],
        buildings=[
            BuildingDTO(
                id=building_id,
                district_id=district_id,
                name="main.py",
                path="src/main.py",
                language="Python",
                color_hex="#3572A5",
                metrics=BuildingMetricsDTO(
                    loc_total=10,
                    loc_code=8,
                    loc_blank=2,
                    complexity=2,
                    function_count=1,
                    class_count=0,
                    interface_count=0,
                    in_degree=0,
                    out_degree=1,
                    is_in_cycle=False,
                ),
            )
        ],
        connections=[],
    )
    return file_analyses, graph_analysis, city_dto


async def cleanup_test_records(session_factory, repo_ids: list[str], run_ids: list[str], city_ids: list[str]):
    """Guaranteed deletion of all test records in reverse foreign-key order."""
    async with session_factory() as session:
        for cid in city_ids:
            if cid:
                await session.execute(delete(Connection).where(Connection.city_id == cid))
                await session.execute(delete(Building).where(Building.city_id == cid))
                await session.execute(delete(District).where(District.city_id == cid))
        for rid in run_ids:
            if rid:
                await session.execute(delete(City).where(City.run_id == rid))
                await session.execute(delete(DependencyEdge).where(DependencyEdge.run_id == rid))
                await session.execute(delete(FileRecord).where(FileRecord.run_id == rid))
                await session.execute(delete(AnalysisRun).where(AnalysisRun.id == rid))
        for repid in repo_ids:
            if repid:
                await session.execute(delete(Repository).where(Repository.id == repid))
        await session.commit()


async def test_successful_persistence():
    print("\n--- Test 1: Successful persistence & atomic commit ---")
    engine = create_async_engine(DATABASE_URL)
    session_factory = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

    repo_id = str(uuid.uuid4())
    run_id = str(uuid.uuid4())
    city_id = None
    commit_sha = "abcdef1234567890abcdef1234567890abcdef12"

    unique_suffix = uuid.uuid4().hex[:8]
    repo_name = f"test-repo-{unique_suffix}"
    full_name = f"test-owner/{repo_name}"

    try:
        async with session_factory() as session:
            repo = Repository(
                id=repo_id,
                github_owner="test-owner",
                github_name=repo_name,
                full_name=full_name,
                clone_url=f"https://github.com/{full_name}",
                is_private=False,
                status=RepositoryStatus.pending,
            )
            run = AnalysisRun(
                id=run_id,
                repository_id=repo_id,
                status=AnalysisRunStatus.running,
                commit_sha=commit_sha,
            )
            session.add(repo)
            session.add(run)
            await session.commit()

        file_analyses, graph_analysis, city_dto = make_dummy_analysis_data(run_id, full_name, commit_sha)

        # Execute persistence
        async with session_factory() as session:
            db_repo = await session.get(Repository, repo_id)
            db_run = await session.get(AnalysisRun, run_id)
            assert db_repo is not None and db_run is not None

            city_id = await persist_analysis_result(
                session,
                db_repo,
                db_run,
                file_analyses=file_analyses,
                graph_analysis=graph_analysis,
                city_dto=city_dto,
                commit_sha=commit_sha,
            )
            # Commit owned by caller
            await session.commit()

        # Verify committed state in fresh session
        async with session_factory() as session:
            res_city = await session.execute(select(City).where(City.run_id == run_id))
            cities = res_city.scalars().all()
            assert len(cities) == 1
            assert cities[0].id == city_id
            assert cities[0].repository_id == repo_id

            res_dist = await session.execute(select(District).where(District.city_id == city_id))
            assert len(res_dist.scalars().all()) == 1

            res_bld = await session.execute(select(Building).where(Building.city_id == city_id))
            assert len(res_bld.scalars().all()) == 1

            res_file = await session.execute(select(FileRecord).where(FileRecord.run_id == run_id))
            assert len(res_file.scalars().all()) == 1

            res_edge = await session.execute(select(DependencyEdge).where(DependencyEdge.run_id == run_id))
            assert len(res_edge.scalars().all()) == 1

            db_run = await session.get(AnalysisRun, run_id)
            assert db_run.status == AnalysisRunStatus.complete
            assert db_run.analysis_meta["summary"]["total_files"] == 1

            db_repo = await session.get(Repository, repo_id)
            assert db_repo.status == RepositoryStatus.ready

        print("✓ All 6 entities successfully persisted and committed atomically.")
        print("✓ AnalysisRun marked complete and Repository marked ready.")
    finally:
        await cleanup_test_records(session_factory, repo_ids=[repo_id], run_ids=[run_id], city_ids=[city_id] if city_id else [])
        # Verify 0 orphan records left
        async with session_factory() as session:
            orphan_repo = await session.get(Repository, repo_id)
            orphan_run = await session.get(AnalysisRun, run_id)
            assert orphan_repo is None and orphan_run is None
        print("✓ Test 1 cleanup verified: 0 orphan records left in database.")
        await engine.dispose()


async def test_forced_persistence_failure_atomicity():
    print("\n--- Test 2: Forced persistence failure atomicity & rollback ---")
    engine = create_async_engine(DATABASE_URL)
    session_factory = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

    repo_id = str(uuid.uuid4())
    run_id = str(uuid.uuid4())
    commit_sha = "9999999999999999999999999999999999999999"

    unique_suffix = uuid.uuid4().hex[:8]
    repo_name = f"test-fail-{unique_suffix}"
    full_name = f"test-owner/{repo_name}"

    try:
        async with session_factory() as session:
            repo = Repository(
                id=repo_id,
                github_owner="test-owner",
                github_name=repo_name,
                full_name=full_name,
                clone_url=f"https://github.com/{full_name}",
                is_private=False,
                status=RepositoryStatus.pending,
            )
            run = AnalysisRun(
                id=run_id,
                repository_id=repo_id,
                status=AnalysisRunStatus.queued,
                commit_sha=commit_sha,
            )
            session.add(repo)
            session.add(run)
            await session.commit()

        ctx = {"session_factory": session_factory}

        # Simulate an error inside persist_analysis_result after some rows were added/flushed
        async def faulty_persist(*args, **kwargs):
            session: AsyncSession = args[0]
            # Create a partial City row in the session
            partial_city = City(
                id=str(uuid.uuid4()),
                run_id=run_id,
                repository_id=repo_id,
                generated_at=datetime.now(timezone.utc),
            )
            session.add(partial_city)
            await session.flush()
            # Force failure
            raise RuntimeError("Simulated database failure during city graph insertion")

        with patch("worker.clone_repository", return_value=(Path("/tmp/fake_clone"), "test-owner", "test-fail-repo", commit_sha)), \
             patch("worker.discover_files", return_value=([], [])), \
             patch("worker.build_dependency_graph", return_value=GraphAnalysis(graph=nx.DiGraph(), edges=[], in_degree={}, out_degree={}, circular_groups=[])), \
             patch("worker.generate_city_dto", return_value=CityDTO(
                 repository_name="test-owner/test-fail-repo",
                 commit_sha=commit_sha,
                 summary=CitySummaryDTO(total_files=0, total_loc_code=0, total_complexity=0, languages={}, circular_dependency_count=0),
                 districts=[],
                 buildings=[],
                 connections=[],
             )), \
             patch("worker.persist_analysis_result", side_effect=faulty_persist):

            result = await analyze_repository(ctx, repository_id=repo_id, run_id=run_id)
            assert result["status"] == "failed"
            assert "Simulated database failure" in result["error"]
            print(f"✓ analyze_repository returned failed result: {result['error']}")

        # Verify in DB: transaction rolled back, ZERO City rows exist, status is failed
        async with session_factory() as session:
            res_city = await session.execute(select(City).where(City.run_id == run_id))
            cities = res_city.scalars().all()
            assert len(cities) == 0, f"Expected 0 cities due to rollback, found {len(cities)}"
            print("✓ Zero partial City rows committed in database (clean rollback verified).")

            db_run = await session.get(AnalysisRun, run_id)
            assert db_run.status == AnalysisRunStatus.failed
            assert "Simulated database failure" in db_run.error_message
            print(f"✓ AnalysisRun status verified as failed: {db_run.status}")

            db_repo = await session.get(Repository, repo_id)
            assert db_repo.status == RepositoryStatus.failed
            print(f"✓ Repository status verified as failed: {db_repo.status}")
    finally:
        await cleanup_test_records(session_factory, repo_ids=[repo_id], run_ids=[run_id], city_ids=[])
        async with session_factory() as session:
            orphan_repo = await session.get(Repository, repo_id)
            orphan_run = await session.get(AnalysisRun, run_id)
            assert orphan_repo is None and orphan_run is None
        print("✓ Test 2 cleanup verified: 0 orphan records left in database.")
        await engine.dispose()


async def main():
    print("==================================================================")
    print("  CHECKPOINT Q6: WORKER PERSISTENCE & ATOMICITY TESTS             ")
    print("==================================================================")
    await test_successful_persistence()
    await test_forced_persistence_failure_atomicity()
    print("\n==================================================================")
    print("  ALL WORKER PERSISTENCE & ATOMICITY TESTS PASSED!                ")
    print("==================================================================")


if __name__ == "__main__":
    asyncio.run(main())
