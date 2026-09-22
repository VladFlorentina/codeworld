"""
Test suite for Checkpoint Phase 6 Milestone WM1:
Data Contract & Explore Backend Endpoint (GET /api/v1/explore/world).

Verifies:
  1. Anonymous access -> HTTP 200 without session cookie or token
  2. Public ready repository -> included in world map with accurate DTO fields
  3. Private repository -> strictly excluded (is_private=True)
  4. Non-ready public repository -> strictly excluded (pending, analyzing, failed)
  5. Two complete runs -> exactly one city returned, newest completed_at selected
  6. Two complete runs with identical completed_at -> deterministic single selection
  7. Non-source / docs / config excluded from primary-language resolution
  8. Language tie-breaker -> deterministic alphabetical resolution
  9. No source language -> fallback to "Unknown"
 10. Defensive handling for missing/legacy metadata -> 200 OK with safe defaults
 11. DTO repository_id contract -> exact match with Repository.id
 12. Guaranteed cleanup -> exactly cleans up records created during this run
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import uuid
from uuid import UUID

import httpx
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.main import app
from codeworld_db import (
    AnalysisRun,
    AnalysisRunStatus,
    Repository,
    RepositoryStatus,
    SyncType,
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def run_wm1_explore_tests():
    print("==================================================================")
    print("  CHECKPOINT WM1: EXPLORE WORLD MAP BACKEND ENDPOINT TESTS        ")
    print("==================================================================")

    test_run_prefix = f"test-wm1-{uuid.uuid4().hex[:8]}"
    created_repo_ids: set[str] = set()
    created_run_ids: set[str] = set()

    now = utcnow()

    # Define test entities
    # 1. Public Ready Repo (Standard)
    id_pub_ready = str(uuid.uuid4())
    run_id_pub_ready = str(uuid.uuid4())
    sha_pub_ready = "1111222233334444555566667777888899990001"

    # 2. Private Repo (Must be excluded)
    id_priv = str(uuid.uuid4())
    run_id_priv = str(uuid.uuid4())

    # 3. Non-ready Repos (Must be excluded)
    id_pending = str(uuid.uuid4())
    run_id_pending = str(uuid.uuid4())
    id_analyzing = str(uuid.uuid4())
    run_id_analyzing = str(uuid.uuid4())
    id_failed = str(uuid.uuid4())
    run_id_failed = str(uuid.uuid4())

    # 4. Multi-run Repo (Different completed_at)
    id_multirun = str(uuid.uuid4())
    run_id_older = str(uuid.uuid4())
    run_id_newer = str(uuid.uuid4())
    sha_older = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    sha_newer = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

    # 5. Same-timestamp Multi-run Repo (Identical completed_at tie-breaker)
    id_sametime = str(uuid.uuid4())
    # Deterministic IDs
    run_id_low = "00000000-0000-0000-0000-000000000001"
    run_id_high = "ffffffff-ffff-ffff-ffff-ffffffffffff"
    sha_low = "cccccccccccccccccccccccccccccccccccccccc"
    sha_high = "dddddddddddddddddddddddddddddddddddddddd"

    # 6. Docs / Config Exclusion Repo
    id_docs_exclude = str(uuid.uuid4())
    run_id_docs_exclude = str(uuid.uuid4())

    # 7. Language Tie-Breaker Repo
    id_tie = str(uuid.uuid4())
    run_id_tie = str(uuid.uuid4())

    # 8. No Source Language Fallback Repo
    id_no_source = str(uuid.uuid4())
    run_id_no_source = str(uuid.uuid4())

    # 9. Missing / Legacy Metadata Repo
    id_missing_meta = str(uuid.uuid4())
    run_id_missing_meta = str(uuid.uuid4())

    # Track for cleanup
    all_repo_ids = [
        id_pub_ready, id_priv, id_pending, id_analyzing, id_failed,
        id_multirun, id_sametime, id_docs_exclude, id_tie, id_no_source, id_missing_meta,
    ]
    all_run_ids = [
        run_id_pub_ready, run_id_priv, run_id_pending, run_id_analyzing, run_id_failed,
        run_id_older, run_id_newer, run_id_low, run_id_high, run_id_docs_exclude,
        run_id_tie, run_id_no_source, run_id_missing_meta,
    ]
    created_repo_ids.update(all_repo_ids)
    created_run_ids.update(all_run_ids)

    async with AsyncSessionLocal() as session:
        # 1. Public Ready
        repo_pub_ready = Repository(
            id=id_pub_ready,
            github_owner=test_run_prefix,
            github_name="pub-ready",
            full_name=f"{test_run_prefix}/pub-ready",
            description="Public ready repository",
            is_private=False,
            status=RepositoryStatus.ready,
            sync_type=SyncType.public,
            clone_url=f"https://github.com/{test_run_prefix}/pub-ready",
        )
        run_pub_ready = AnalysisRun(
            id=run_id_pub_ready,
            repository_id=id_pub_ready,
            commit_sha=sha_pub_ready,
            status=AnalysisRunStatus.complete,
            completed_at=now,
            analysis_meta={
                "summary": {
                    "languages": {"Python": 42, "Markdown": 5},
                    "total_files": 47,
                    "total_loc_code": 3500,
                    "total_complexity": 120,
                }
            },
        )

        # 2. Private Repo
        repo_priv = Repository(
            id=id_priv,
            github_owner=test_run_prefix,
            github_name="priv-repo",
            full_name=f"{test_run_prefix}/priv-repo",
            description="Secret private repo",
            is_private=True,
            status=RepositoryStatus.ready,
            sync_type=SyncType.live,
            clone_url=f"https://github.com/{test_run_prefix}/priv-repo",
        )
        run_priv = AnalysisRun(
            id=run_id_priv,
            repository_id=id_priv,
            commit_sha="2222222222222222222222222222222222222222",
            status=AnalysisRunStatus.complete,
            completed_at=now,
            analysis_meta={"summary": {"languages": {"Python": 10}, "total_files": 10}},
        )

        # 3. Non-ready Repos
        repo_pending = Repository(
            id=id_pending,
            github_owner=test_run_prefix,
            github_name="pending-repo",
            full_name=f"{test_run_prefix}/pending-repo",
            is_private=False,
            status=RepositoryStatus.pending,
            sync_type=SyncType.public,
            clone_url=f"https://github.com/{test_run_prefix}/pending-repo",
        )
        run_pending = AnalysisRun(
            id=run_id_pending,
            repository_id=id_pending,
            status=AnalysisRunStatus.complete,
            completed_at=now,
        )

        repo_analyzing = Repository(
            id=id_analyzing,
            github_owner=test_run_prefix,
            github_name="analyzing-repo",
            full_name=f"{test_run_prefix}/analyzing-repo",
            is_private=False,
            status=RepositoryStatus.analyzing,
            sync_type=SyncType.public,
            clone_url=f"https://github.com/{test_run_prefix}/analyzing-repo",
        )
        run_analyzing = AnalysisRun(
            id=run_id_analyzing,
            repository_id=id_analyzing,
            status=AnalysisRunStatus.complete,
            completed_at=now,
        )

        repo_failed = Repository(
            id=id_failed,
            github_owner=test_run_prefix,
            github_name="failed-repo",
            full_name=f"{test_run_prefix}/failed-repo",
            is_private=False,
            status=RepositoryStatus.failed,
            sync_type=SyncType.public,
            clone_url=f"https://github.com/{test_run_prefix}/failed-repo",
        )
        run_failed = AnalysisRun(
            id=run_id_failed,
            repository_id=id_failed,
            status=AnalysisRunStatus.complete,
            completed_at=now,
        )

        # 4. Multi-run (Different timestamps)
        repo_multirun = Repository(
            id=id_multirun,
            github_owner=test_run_prefix,
            github_name="multi-run-repo",
            full_name=f"{test_run_prefix}/multi-run-repo",
            is_private=False,
            status=RepositoryStatus.ready,
            sync_type=SyncType.public,
            clone_url=f"https://github.com/{test_run_prefix}/multi-run-repo",
        )
        run_older = AnalysisRun(
            id=run_id_older,
            repository_id=id_multirun,
            commit_sha=sha_older,
            status=AnalysisRunStatus.complete,
            completed_at=now - timedelta(hours=2),
            analysis_meta={"summary": {"languages": {"Rust": 5}, "total_files": 5}},
        )
        run_newer = AnalysisRun(
            id=run_id_newer,
            repository_id=id_multirun,
            commit_sha=sha_newer,
            status=AnalysisRunStatus.complete,
            completed_at=now - timedelta(hours=1),
            analysis_meta={"summary": {"languages": {"Rust": 15}, "total_files": 15}},
        )

        # 5. Same-timestamp Multi-run (id.desc tie-breaker)
        repo_sametime = Repository(
            id=id_sametime,
            github_owner=test_run_prefix,
            github_name="same-time-repo",
            full_name=f"{test_run_prefix}/same-time-repo",
            is_private=False,
            status=RepositoryStatus.ready,
            sync_type=SyncType.public,
            clone_url=f"https://github.com/{test_run_prefix}/same-time-repo",
        )
        run_same_low = AnalysisRun(
            id=run_id_low,
            repository_id=id_sametime,
            commit_sha=sha_low,
            status=AnalysisRunStatus.complete,
            completed_at=now,
            analysis_meta={"summary": {"languages": {"Go": 3}, "total_files": 3}},
        )
        run_same_high = AnalysisRun(
            id=run_id_high,
            repository_id=id_sametime,
            commit_sha=sha_high,
            status=AnalysisRunStatus.complete,
            completed_at=now,
            analysis_meta={"summary": {"languages": {"Go": 30}, "total_files": 30}},
        )

        # 6. Docs / Config Exclusion Repo
        repo_docs_exclude = Repository(
            id=id_docs_exclude,
            github_owner=test_run_prefix,
            github_name="docs-exclude-repo",
            full_name=f"{test_run_prefix}/docs-exclude-repo",
            is_private=False,
            status=RepositoryStatus.ready,
            sync_type=SyncType.public,
            clone_url=f"https://github.com/{test_run_prefix}/docs-exclude-repo",
        )
        run_docs_exclude = AnalysisRun(
            id=run_id_docs_exclude,
            repository_id=id_docs_exclude,
            commit_sha="6666666666666666666666666666666666666666",
            status=AnalysisRunStatus.complete,
            completed_at=now,
            analysis_meta={
                "summary": {
                    "languages": {
                        "Markdown": 1200,
                        "JSON": 400,
                        "YAML": 50,
                        "TOML": 20,
                        "Text": 10,
                        "TypeScript": 85,  # Dominant source
                        "HTML": 15,        # HTML is kept as source/fact per spec, but TS has higher count
                    },
                    "total_files": 1780,
                }
            },
        )

        # 7. Language Tie-Breaker Repo
        repo_tie = Repository(
            id=id_tie,
            github_owner=test_run_prefix,
            github_name="tie-repo",
            full_name=f"{test_run_prefix}/tie-repo",
            is_private=False,
            status=RepositoryStatus.ready,
            sync_type=SyncType.public,
            clone_url=f"https://github.com/{test_run_prefix}/tie-repo",
        )
        run_tie = AnalysisRun(
            id=run_id_tie,
            repository_id=id_tie,
            commit_sha="7777777777777777777777777777777777777777",
            status=AnalysisRunStatus.complete,
            completed_at=now,
            analysis_meta={
                "summary": {
                    "languages": {
                        "TypeScript": 50,
                        "Python": 50,  # 'Python' < 'TypeScript' alphabetically
                    },
                    "total_files": 100,
                }
            },
        )

        # 8. No Source Language Fallback Repo
        repo_no_source = Repository(
            id=id_no_source,
            github_owner=test_run_prefix,
            github_name="no-source-repo",
            full_name=f"{test_run_prefix}/no-source-repo",
            is_private=False,
            status=RepositoryStatus.ready,
            sync_type=SyncType.public,
            clone_url=f"https://github.com/{test_run_prefix}/no-source-repo",
        )
        run_no_source = AnalysisRun(
            id=run_id_no_source,
            repository_id=id_no_source,
            commit_sha="8888888888888888888888888888888888888888",
            status=AnalysisRunStatus.complete,
            completed_at=now,
            analysis_meta={
                "summary": {
                    "languages": {
                        "Markdown": 150,
                        "JSON": 40,
                        "Unknown": 10,
                    },
                    "total_files": 200,
                }
            },
        )

        # 9. Missing / Legacy Metadata Repo
        repo_missing_meta = Repository(
            id=id_missing_meta,
            github_owner=test_run_prefix,
            github_name="missing-meta-repo",
            full_name=f"{test_run_prefix}/missing-meta-repo",
            is_private=False,
            status=RepositoryStatus.ready,
            sync_type=SyncType.public,
            clone_url=f"https://github.com/{test_run_prefix}/missing-meta-repo",
        )
        run_missing_meta = AnalysisRun(
            id=run_id_missing_meta,
            repository_id=id_missing_meta,
            commit_sha="9999999999999999999999999999999999999999",
            status=AnalysisRunStatus.complete,
            completed_at=now,
            analysis_meta=None,  # Missing entirely
        )

        session.add_all([
            repo_pub_ready, repo_priv, repo_pending, repo_analyzing, repo_failed,
            repo_multirun, repo_sametime, repo_docs_exclude, repo_tie, repo_no_source,
            repo_missing_meta,
            run_pub_ready, run_priv, run_pending, run_analyzing, run_failed,
            run_older, run_newer, run_same_low, run_same_high, run_docs_exclude,
            run_tie, run_no_source, run_missing_meta,
        ])
        await session.commit()

    print("✓ Test database fixtures seeded successfully.")

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost:8000") as client:
            # -------------------------------------------------------------
            # 1. Anonymous access -> HTTP 200
            # -------------------------------------------------------------
            print("\n[Test 1] Anonymous access to /api/v1/explore/world -> HTTP 200")
            resp = await client.get("/api/v1/explore/world")
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            data = resp.json()
            assert "cities" in data and "total_cities" in data, "Response missing top-level keys"
            assert data["total_cities"] == len(data["cities"]), "total_cities mismatch"
            print(f"✓ Anonymous access returned 200 with {data['total_cities']} total cities.")

            # Filter response for our test run's repositories
            test_cities = [c for c in data["cities"] if c["owner"] == test_run_prefix]
            test_cities_by_id = {c["repository_id"]: c for c in test_cities}

            # -------------------------------------------------------------
            # 2. Public Ready Repo -> Included with exact fields
            # -------------------------------------------------------------
            print("\n[Test 2] Public ready repository inclusion & DTO fields")
            assert id_pub_ready in test_cities_by_id, "Public ready repo not found in world map"
            city_pub = test_cities_by_id[id_pub_ready]
            assert city_pub["repository_id"] == id_pub_ready, "repository_id mismatch"
            assert city_pub["owner"] == test_run_prefix
            assert city_pub["name"] == "pub-ready"
            assert city_pub["full_name"] == f"{test_run_prefix}/pub-ready"
            assert city_pub["description"] == "Public ready repository"
            assert city_pub["primary_language"] == "Python"
            assert city_pub["total_files"] == 47
            assert city_pub["total_loc"] == 3500
            assert city_pub["complexity"] == 120
            assert city_pub["commit_sha"] == sha_pub_ready
            assert "analyzed_at" in city_pub and city_pub["analyzed_at"] is not None
            print("✓ Public ready repo verified with complete DTO fields.")

            # -------------------------------------------------------------
            # 3. Private Repo -> Strictly Excluded
            # -------------------------------------------------------------
            print("\n[Test 3] Private repository exclusion")
            assert id_priv not in test_cities_by_id, "CRITICAL: Private repository found in public explore world!"
            print("✓ Private repository is strictly excluded from world map.")

            # -------------------------------------------------------------
            # 4. Non-ready Public Repos -> Strictly Excluded
            # -------------------------------------------------------------
            print("\n[Test 4] Non-ready public repositories exclusion")
            assert id_pending not in test_cities_by_id, "Pending repo must not appear in world map"
            assert id_analyzing not in test_cities_by_id, "Analyzing repo must not appear in world map"
            assert id_failed not in test_cities_by_id, "Failed repo must not appear in world map"
            print("✓ Pending, analyzing, and failed repositories strictly excluded.")

            # -------------------------------------------------------------
            # 5. Multi-run Repo -> Exactly one city, newest completed_at
            # -------------------------------------------------------------
            print("\n[Test 5] Latest complete run selection (completed_at DESC)")
            assert id_multirun in test_cities_by_id, "Multi-run repo missing from world map"
            city_multirun = test_cities_by_id[id_multirun]
            # Ensure only 1 entry in the whole test list
            multirun_matches = [c for c in test_cities if c["repository_id"] == id_multirun]
            assert len(multirun_matches) == 1, f"Expected exactly 1 entry for multi-run repo, got {len(multirun_matches)}"
            assert city_multirun["commit_sha"] == sha_newer, (
                f"Expected newer commit SHA {sha_newer}, got {city_multirun['commit_sha']}"
            )
            assert city_multirun["total_files"] == 15, "Expected stats from newer run"
            print("✓ Multi-run repository returns exactly one city with the latest completed run.")

            # -------------------------------------------------------------
            # 6. Identical completed_at -> Deterministic single selection
            # -------------------------------------------------------------
            print("\n[Test 6] Identical completed_at tie-breaker (id.desc)")
            assert id_sametime in test_cities_by_id, "Same-timestamp repo missing from world map"
            sametime_matches = [c for c in test_cities if c["repository_id"] == id_sametime]
            assert len(sametime_matches) == 1, (
                f"Expected exactly 1 entry for same-time repo, got {len(sametime_matches)}"
            )
            city_sametime = test_cities_by_id[id_sametime]
            assert city_sametime["commit_sha"] == sha_high, (
                f"Expected tie-breaker to select run_id_high ({sha_high}), got {city_sametime['commit_sha']}"
            )
            print("✓ Identical completed_at resolves deterministically to a single run via id tie-breaker.")

            # -------------------------------------------------------------
            # 7. Documentation / Config Excluded from Primary Language
            # -------------------------------------------------------------
            print("\n[Test 7] Docs & config exclusion in primary_language")
            city_docs = test_cities_by_id[id_docs_exclude]
            assert city_docs["primary_language"] == "TypeScript", (
                f"Expected TypeScript, got {city_docs['primary_language']} (Markdown/JSON should be excluded)"
            )
            print("✓ Docs (Markdown, Text) and config (JSON, YAML, TOML) excluded; TypeScript resolved.")

            # -------------------------------------------------------------
            # 8. Deterministic Language Tie-Breaker
            # -------------------------------------------------------------
            print("\n[Test 8] Deterministic language tie-breaker (alphabetical)")
            city_tie = test_cities_by_id[id_tie]
            assert city_tie["primary_language"] == "Python", (
                f"Expected Python on 50/50 tie with TypeScript, got {city_tie['primary_language']}"
            )
            print("✓ Equal language file counts resolved deterministically ('Python' < 'TypeScript').")

            # -------------------------------------------------------------
            # 9. No Source Language Fallback -> 'Unknown'
            # -------------------------------------------------------------
            print("\n[Test 9] No source language fallback -> 'Unknown'")
            city_no_source = test_cities_by_id[id_no_source]
            assert city_no_source["primary_language"] == "Unknown", (
                f"Expected Unknown, got {city_no_source['primary_language']}"
            )
            print("✓ Repositories without recognized source code fall back cleanly to 'Unknown'.")

            # -------------------------------------------------------------
            # 10. Defensive handling for missing / legacy metadata
            # -------------------------------------------------------------
            print("\n[Test 10] Defensive handling for missing / legacy metadata")
            city_missing_meta = test_cities_by_id[id_missing_meta]
            assert city_missing_meta["primary_language"] == "Unknown"
            assert city_missing_meta["total_files"] == 0
            assert city_missing_meta["total_loc"] == 0
            assert city_missing_meta["complexity"] == 0
            print("✓ Missing metadata handled defensibly with zero HTTP 500 errors.")

            # -------------------------------------------------------------
            # 11. DTO repository_id contract verification
            # -------------------------------------------------------------
            print("\n[Test 11] DTO repository_id contract verification")
            for city in test_cities:
                repo_uuid = UUID(city["repository_id"])
                assert str(repo_uuid) in created_repo_ids, "repository_id does not match created repository"
            print("✓ repository_id matches Repository.id across all returned items.")

    finally:
        # Guaranteed cleanup of all created test entities
        async with AsyncSessionLocal() as session:
            if created_run_ids:
                stmt_runs = select(AnalysisRun).where(AnalysisRun.id.in_(list(created_run_ids)))
                res_runs = await session.execute(stmt_runs)
                for r in res_runs.scalars().all():
                    await session.delete(r)

            if created_repo_ids:
                stmt_repos = select(Repository).where(Repository.id.in_(list(created_repo_ids)))
                res_repos = await session.execute(stmt_repos)
                for r in res_repos.scalars().all():
                    await session.delete(r)

            await session.commit()
        print("✓ All WM1 test fixtures cleanly purged from database.")

    print("\n==================================================================")
    print("  ALL CHECKPOINT WM1 EXPLORE WORLD TESTS PASSED (11/11)!          ")
    print("==================================================================")


if __name__ == "__main__":
    asyncio.run(run_wm1_explore_tests())
