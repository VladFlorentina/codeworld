"""
Verification script for Checkpoint 1.

Tests the 5 scenarios required by the user:
  1. Repo existent + SHA existent    -> ready / 200
  2. Repo existent + SHA nou         -> newly_queued / 202
  3. Run activ pentru același SHA    -> analyzing / 202
  4. Repo inexistent                 -> 404 eroare controlată
  5. Timeout ls-remote               -> 504 eroare temporară controlată
"""
import asyncio
import httpx
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy import select, delete
from codeworld_db import Repository, AnalysisRun, City, AnalysisRunStatus, RepositoryStatus
from app.routers.repositories import _get_remote_head_commit
from fastapi import HTTPException

BASE_URL = "http://localhost:8000/api/v1"
DB_URL = "postgresql+asyncpg://codeworld:codeworld@postgres:5432/codeworld"


async def run_tests():
    print("==================================================================")
    print("   RUNNING CHECKPOINT 1 VERIFICATION TESTS (POST /repositories)   ")
    print("==================================================================")

    async with httpx.AsyncClient(base_url=BASE_URL, timeout=15.0) as client:
        # ─────────────────────────────────────────────────────────────
        # TEST 1: Repo existent + SHA existent -> ready / HTTP 200
        # ─────────────────────────────────────────────────────────────
        print("\n--- [Test 1: Repo existent + SHA existent -> ready / 200] ---")
        res1 = await client.post("/repositories", json={"url": "https://github.com/tiangolo/fastapi"})
        print(f"Status Code: {res1.status_code}")
        data1 = res1.json()
        print(f"Response: {data1}")
        assert res1.status_code == 200, f"Expected 200, got {res1.status_code}"
        assert data1["status"] == "ready", f"Expected ready, got {data1['status']}"
        assert data1["commit_sha"] == "50113da16fec53b66b80d75e80a89296de4fa5a5"
        assert data1["repository_id"] == "9ca0ba88-7ab2-45e4-b92e-26dcf16ef8ac"
        assert data1["job_id"] is None
        print("✓ PASS: Test 1 (ready / 200)")

        # ─────────────────────────────────────────────────────────────
        # TEST 4: Repo inexistent -> eroare controlată / HTTP 404
        # ─────────────────────────────────────────────────────────────
        print("\n--- [Test 4: Repo inexistent -> eroare controlată / 404] ---")
        res4 = await client.post(
            "/repositories",
            json={"url": "https://github.com/tiangolo/nonexistent-codeworld-fake-repo-xyz999"}
        )
        print(f"Status Code: {res4.status_code}")
        data4 = res4.json()
        print(f"Response: {data4}")
        assert res4.status_code == 404, f"Expected 404, got {res4.status_code}"
        assert "not found or is inaccessible" in data4["detail"]
        print("✓ PASS: Test 4 (controlled 404)")

        # ─────────────────────────────────────────────────────────────
        # TEST 5: Timeout ls-remote -> eroare temporară controlată / HTTP 504
        # ─────────────────────────────────────────────────────────────
        print("\n--- [Test 5: Timeout ls-remote -> eroare temporară / 504] ---")
        try:
            # Calling helper directly with an impossibly small timeout (0.00001s)
            await _get_remote_head_commit("https://github.com/tiangolo/fastapi", timeout_seconds=0.00001)
            assert False, "Expected HTTPException 504 on timeout"
        except HTTPException as exc:
            print(f"Caught expected HTTPException: status={exc.status_code}, detail='{exc.detail}'")
            assert exc.status_code == 504
            assert "Timeout resolving GitHub repository HEAD commit" in exc.detail
        print("✓ PASS: Test 5 (controlled 504 on timeout)")

        # ─────────────────────────────────────────────────────────────
        # SETUP FOR TESTS 2 & 3:
        # Create a test repository with an old dummy commit SHA in DB
        # ─────────────────────────────────────────────────────────────
        print("\n--- [Setup for Tests 2 & 3: Repo existent + SHA nou] ---")
        engine = create_async_engine(DB_URL)
        test_repo_owner = "pallets"
        test_repo_name = "click"
        test_full_name = f"{test_repo_owner}/{test_repo_name}"
        test_clone_url = f"https://github.com/{test_full_name}"

        async with AsyncSession(engine) as s:
            # Clean any old test records for pallets/click
            existing = (await s.execute(select(Repository).where(Repository.full_name == test_full_name))).scalar_one_or_none()
            if existing:
                await s.delete(existing)
                await s.commit()

            # Create the repository with an older dummy commit_sha
            dummy_repo = Repository(
                github_owner=test_repo_owner,
                github_name=test_repo_name,
                full_name=test_full_name,
                clone_url=test_clone_url,
                status=RepositoryStatus.ready,
            )
            s.add(dummy_repo)
            await s.flush()

            # Create an old complete run with a DUMMY older commit SHA (not the current HEAD)
            old_run = AnalysisRun(
                repository_id=dummy_repo.id,
                commit_sha="0000000000000000000000000000000000000000",
                status=AnalysisRunStatus.complete,
            )
            s.add(old_run)
            await s.flush()

            dummy_city = City(
                run_id=old_run.id,
                repository_id=dummy_repo.id,
            )
            s.add(dummy_city)
            await s.commit()
            print(f"Initialized test repo '{test_full_name}' with dummy SHA in DB.")

        # ─────────────────────────────────────────────────────────────
        # TEST 2: Repo existent + SHA nou -> newly_queued / HTTP 202
        # ─────────────────────────────────────────────────────────────
        print("\n--- [Test 2: Repo existent + SHA nou -> newly_queued / 202] ---")
        res2 = await client.post("/repositories", json={"url": test_clone_url})
        print(f"Status Code: {res2.status_code}")
        data2 = res2.json()
        print(f"Response: {data2}")
        assert res2.status_code == 202, f"Expected 202, got {res2.status_code}"
        assert data2["status"] == "newly_queued", f"Expected newly_queued, got {data2['status']}"
        assert data2["commit_sha"] != "0000000000000000000000000000000000000000"
        assert len(data2["commit_sha"]) == 40
        assert data2["job_id"] is not None
        new_run_id = data2["run_id"]
        new_job_id = data2["job_id"]
        new_commit_sha = data2["commit_sha"]
        print(f"✓ PASS: Test 2 (newly_queued / 202, run_id={new_run_id}, job_id={new_job_id})")

        # ─────────────────────────────────────────────────────────────
        # TEST 3: Run activ pentru același SHA -> analyzing / HTTP 202
        # (while the worker has the job queued or running)
        # ─────────────────────────────────────────────────────────────
        print("\n--- [Test 3: Run activ pentru același SHA -> analyzing / 202] ---")
        # Ensure status is queued or running in DB for testing
        async with AsyncSession(engine) as s:
            run_in_db = await s.get(AnalysisRun, new_run_id)
            if run_in_db.status not in (AnalysisRunStatus.queued, AnalysisRunStatus.running):
                run_in_db.status = AnalysisRunStatus.running
                await s.commit()

        res3 = await client.post("/repositories", json={"url": test_clone_url})
        print(f"Status Code: {res3.status_code}")
        data3 = res3.json()
        print(f"Response: {data3}")
        assert res3.status_code == 202, f"Expected 202, got {res3.status_code}"
        assert data3["status"] == "analyzing", f"Expected analyzing, got {data3['status']}"
        assert data3["run_id"] == new_run_id, f"Expected same run_id {new_run_id}, got {data3['run_id']}"
        assert data3["job_id"] == new_job_id, f"Expected same job_id {new_job_id}, got {data3['job_id']}"
        assert data3["commit_sha"] == new_commit_sha
        print("✓ PASS: Test 3 (analyzing / 202, exactly reused in-flight run and job)")

        # Cleanup test repo
        async with AsyncSession(engine) as s:
            t_repo = (await s.execute(select(Repository).where(Repository.full_name == test_full_name))).scalar_one_or_none()
            if t_repo:
                await s.delete(t_repo)
                await s.commit()
        await engine.dispose()

    print("\n==================================================================")
    print("      ALL 5 CHECKPOINT 1 SCENARIOS PASSED WITH ZERO ERRORS!       ")
    print("==================================================================")


if __name__ == "__main__":
    asyncio.run(run_tests())
