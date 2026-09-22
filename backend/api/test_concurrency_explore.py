"""
Concurrency verification test for Checkpoint 2.

Tests two concurrent scenarios using asyncio.gather:
  Test 1: Existing Repository without City/Run for current HEAD SHA
  Test 2: Completely NEW Repository (not yet in repositories table)

Asserts:
  - AnalysisRun rows for repo + HEAD == 1
  - ARQ jobs enqueued in Redis == 1
  - Both requests receive the same active operation (run_id A == run_id B, job_id A == job_id B)
  - For Test 2: Repository rows == 1, neither request gets HTTP 500
"""
import asyncio
import redis
import httpx
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy import select, func
from codeworld_db import Repository, AnalysisRun, City, AnalysisRunStatus, RepositoryStatus

BASE_URL = "http://localhost:8000/api/v1"
DB_URL = "postgresql+asyncpg://codeworld:codeworld@postgres:5432/codeworld"
REDIS_URL = "redis://redis:6379"


async def run_concurrency_tests():
    print("==================================================================")
    print("        CHECKPOINT 2: CONCURRENCY VALIDATION TESTS               ")
    print("==================================================================")

    engine = create_async_engine(DB_URL)
    r_client = redis.Redis.from_url(REDIS_URL)

    # Clean redis queue before tests
    r_client.delete("arq:queue")

    async with httpx.AsyncClient(base_url=BASE_URL, timeout=30.0) as client:
        # =====================================================================
        # TEST 1: Existing Repository without complete City or Run on HEAD
        # =====================================================================
        print("\n------------------------------------------------------------------")
        print("TEST 1: Existing Repository without complete City/Run on current HEAD")
        print("------------------------------------------------------------------")
        test1_url = "https://github.com/pallets/click"
        test1_fullname = "pallets/click"

        # 1. Setup DB state: Ensure repo exists, but has NO runs for its current HEAD
        async with AsyncSession(engine) as s:
            repo = (await s.execute(select(Repository).where(Repository.full_name == test1_fullname))).scalar_one_or_none()
            if repo:
                await s.delete(repo)
                await s.commit()

            repo = Repository(
                github_owner="pallets",
                github_name="click",
                full_name=test1_fullname,
                clone_url=test1_url,
                status=RepositoryStatus.ready,
            )
            s.add(repo)
            await s.flush()
            repo_id = repo.id
            await s.commit()
            print(f"Prepared existing repository in DB: id={repo_id}, full_name={test1_fullname}")

        # Flush queue before test 1
        r_client.delete("arq:queue")
        q_before_1 = r_client.zcard("arq:queue")

        # 2. Trigger 2 simultaneous POST requests
        print("Sending Request A and Request B simultaneously via asyncio.gather...")
        t0 = asyncio.get_event_loop().time()
        resA, resB = await asyncio.gather(
            client.post("/repositories", json={"url": test1_url}),
            client.post("/repositories", json={"url": test1_url}),
        )
        duration_ms = int((asyncio.get_event_loop().time() - t0) * 1000)
        print(f"Both requests completed in {duration_ms}ms")

        statusA, bodyA = resA.status_code, resA.json()
        statusB, bodyB = resB.status_code, resB.json()

        print("\n[Result Test 1]")
        print(f"Request A: HTTP {statusA} -> {bodyA}")
        print(f"Request B: HTTP {statusB} -> {bodyB}")

        # Inspect DB state
        head_sha = bodyA.get("commit_sha") or bodyB.get("commit_sha")
        async with AsyncSession(engine) as s:
            runs_stmt = select(AnalysisRun).where(
                AnalysisRun.repository_id == repo_id,
                AnalysisRun.commit_sha == head_sha,
            )
            runs = (await s.execute(runs_stmt)).scalars().all()
            run_count = len(runs)
            print(f"\nDB State: Found {run_count} AnalysisRun(s) for commit_sha={head_sha}")
            for r in runs:
                print(f"  - run_id: {r.id}, status: {r.status.value}, meta: {r.analysis_meta}")

        # Inspect Redis state
        queued_jobs = r_client.zrange("arq:queue", 0, -1)
        job_count = len(queued_jobs)
        print(f"Redis State: Found {job_count} job(s) in arq:queue -> {queued_jobs}")

        test1_race = False
        if run_count != 1:
            print(f"❌ RACE CONDITION DETECTED in Test 1: Created {run_count} AnalysisRuns instead of 1!")
            test1_race = True
        if job_count != 1:
            print(f"❌ RACE CONDITION DETECTED in Test 1: Enqueued {job_count} ARQ jobs instead of 1!")
            test1_race = True
        if bodyA.get("run_id") != bodyB.get("run_id"):
            print(f"❌ MISMATCH in Test 1: run_id A ({bodyA.get('run_id')}) != run_id B ({bodyB.get('run_id')})")
            test1_race = True
        if bodyA.get("job_id") != bodyB.get("job_id"):
            print(f"❌ MISMATCH in Test 1: job_id A ({bodyA.get('job_id')}) != job_id B ({bodyB.get('job_id')})")
            test1_race = True

        if not test1_race:
            print("✓ PASS: Test 1 passed concurrency check with exactly 1 AnalysisRun and 1 ARQ job!")

        # =====================================================================
        # TEST 2: Completely NEW Repository (not yet in repositories table)
        # =====================================================================
        print("\n------------------------------------------------------------------")
        print("TEST 2: Completely NEW Repository (not yet in DB)")
        print("------------------------------------------------------------------")
        test2_url = "https://github.com/psf/requests"
        test2_fullname = "psf/requests"

        # Ensure repo does NOT exist in DB
        async with AsyncSession(engine) as s:
            existing2 = (await s.execute(select(Repository).where(Repository.full_name == test2_fullname))).scalar_one_or_none()
            if existing2:
                await s.delete(existing2)
                await s.commit()
            print(f"Ensured {test2_fullname} is completely removed from DB before test.")

        # Flush queue before test 2
        r_client.delete("arq:queue")

        print("Sending Request A and Request B simultaneously for completely NEW repository...")
        t0 = asyncio.get_event_loop().time()
        resA2, resB2 = await asyncio.gather(
            client.post("/repositories", json={"url": test2_url}),
            client.post("/repositories", json={"url": test2_url}),
        )
        duration_ms2 = int((asyncio.get_event_loop().time() - t0) * 1000)
        print(f"Both requests completed in {duration_ms2}ms")

        statusA2, bodyA2 = resA2.status_code, resA2.json()
        statusB2, bodyB2 = resB2.status_code, resB2.json()

        print("\n[Result Test 2]")
        print(f"Request A: HTTP {statusA2} -> {bodyA2}")
        print(f"Request B: HTTP {statusB2} -> {bodyB2}")

        # Inspect DB state for Test 2
        test2_race = False
        if statusA2 == 500 or statusB2 == 500:
            print(f"❌ HTTP 500 ERROR DETECTED in Test 2!")
            test2_race = True

        async with AsyncSession(engine) as s:
            repos2 = (await s.execute(select(Repository).where(Repository.full_name == test2_fullname))).scalars().all()
            repo_count2 = len(repos2)
            print(f"\nDB State: Found {repo_count2} Repository row(s) for {test2_fullname}")
            if repo_count2 != 1:
                print(f"❌ VIOLATION in Test 2: Expected 1 Repository row, found {repo_count2}")
                test2_race = True

            if repo_count2 > 0:
                head_sha2 = bodyA2.get("commit_sha") or bodyB2.get("commit_sha")
                runs2 = (await s.execute(select(AnalysisRun).where(
                    AnalysisRun.repository_id == repos2[0].id,
                    AnalysisRun.commit_sha == head_sha2
                ))).scalars().all()
                run_count2 = len(runs2)
                print(f"DB State: Found {run_count2} AnalysisRun(s) for commit_sha={head_sha2}")
                if run_count2 != 1:
                    print(f"❌ RACE CONDITION DETECTED in Test 2: Created {run_count2} AnalysisRuns instead of 1!")
                    test2_race = True

        queued_jobs2 = r_client.zrange("arq:queue", 0, -1)
        job_count2 = len(queued_jobs2)
        print(f"Redis State: Found {job_count2} job(s) in arq:queue -> {queued_jobs2}")
        if job_count2 != 1:
            print(f"❌ RACE CONDITION DETECTED in Test 2: Enqueued {job_count2} ARQ jobs instead of 1!")
            test2_race = True

        if not test2_race:
            print("✓ PASS: Test 2 passed concurrency check with exactly 1 Repository, 1 AnalysisRun, and 1 ARQ job!")

        # Final cleanup of test repos
        async with AsyncSession(engine) as s:
            for fn in (test1_fullname, test2_fullname):
                r = (await s.execute(select(Repository).where(Repository.full_name == fn))).scalar_one_or_none()
                if r:
                    await s.delete(r)
            await s.commit()
        await engine.dispose()

        print("\n==================================================================")
        if test1_race or test2_race:
            print("❌ CONCURRENCY VERIFICATION FOUND RACE CONDITION(S)!")
        else:
            print("✓ ALL CONCURRENCY VERIFICATION CHECKS PASSED PERFECTLY!")
        print("==================================================================")


if __name__ == "__main__":
    asyncio.run(run_concurrency_tests())
