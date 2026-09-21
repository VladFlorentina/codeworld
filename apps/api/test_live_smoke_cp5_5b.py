"""
Live smoke test for Checkpoint 5.5B:
End-to-End Private Repository Discovery, Analysis, and Secure City Authorization.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
import sys

import httpx
from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal
from app.security.session import create_session_cookie_value
from codeworld_db import (
    AnalysisRun,
    AnalysisRunStatus,
    City,
    Repository,
    RepositoryStatus,
    User,
)


async def run_live_smoke_test():
    print("=" * 68)
    print("      CHECKPOINT 5.5B: LIVE REAL SMOKE TEST (GITHUB APP PRIVATE FLOW)")
    print("=" * 68)

    # 1. Fetch real authenticated user from database
    async with AsyncSessionLocal() as session:
        user = (await session.execute(
            select(User).where(User.github_login == "VladFlorentina")
        )).scalar_one_or_none()

        if not user:
            print("ERROR: User 'VladFlorentina' not found in database.")
            sys.exit(1)

        print(f"✓ Real user located: id={user.id}, login={user.github_login}, gh_id={user.github_user_id}")
        user_id = str(user.id)

    session_cookie_val = create_session_cookie_value(user_id)
    auth_cookies = {settings.session_cookie_name: session_cookie_val}

    async with httpx.AsyncClient(base_url="http://127.0.0.1:8000", timeout=60.0) as client:
        # ─────────────────────────────────────────────────────────────────
        # STEP 1: Real Discovery (/installations & /repositories)
        # ─────────────────────────────────────────────────────────────────
        print("\n--- Step 1: Real Discovery ---")
        inst_res = await client.get("/api/v1/github/installations", cookies=auth_cookies)
        if inst_res.status_code != 200:
            print(f"ERROR: /installations returned {inst_res.status_code}: {inst_res.text}")
            sys.exit(1)

        inst_data = inst_res.json()
        installations = inst_data.get("installations", [])
        print(f"✓ Installations count: {len(installations)}")
        if not installations:
            print("ERROR: No installations found for user.")
            sys.exit(1)

        inst = installations[0]
        real_installation_id = inst["id"]
        print(f"✓ Active installation_id: {real_installation_id} ({inst.get('account_login')}, {inst.get('repository_selection')})")

        repos_res = await client.get("/api/v1/github/repositories", cookies=auth_cookies)
        if repos_res.status_code != 200:
            print(f"ERROR: /repositories returned {repos_res.status_code}: {repos_res.text}")
            sys.exit(1)

        repos_data = repos_res.json()
        all_repos = repos_data.get("repositories", [])
        print(f"✓ Discovered accessible repositories: {len(all_repos)}")

        private_repos = [r for r in all_repos if r.get("private") is True]
        if not private_repos:
            print("ERROR: No private repositories found in installation!")
            print("Available repositories:", [(r.get("full_name"), r.get("private")) for r in all_repos])
            sys.exit(1)

        target_private_repo = private_repos[0]
        priv_gh_id = target_private_repo["id"]
        priv_owner = target_private_repo["owner"]
        priv_name = target_private_repo["name"]
        priv_full_name = target_private_repo["full_name"]
        priv_inst_id = target_private_repo["installation_id"]

        print(f"✓ Target Private Repository discovered:")
        print(f"    github_repository_id: {priv_gh_id}")
        print(f"    full_name:            {priv_full_name}")
        print(f"    private:              {target_private_repo['private']}")
        print(f"    installation_id:      {priv_inst_id}")
        print(f"    default_branch:       {target_private_repo.get('default_branch')}")

        assert target_private_repo["private"] is True
        assert priv_inst_id == real_installation_id
        assert isinstance(priv_gh_id, int) and priv_gh_id > 0

        # ─────────────────────────────────────────────────────────────────
        # STEP 2: Real Private Analysis Submission
        # ─────────────────────────────────────────────────────────────────
        print("\n--- Step 2: Real Private Analysis Submission ---")
        analyze_payload = {
            "installation_id": priv_inst_id,
            "repository_id": priv_gh_id,
        }
        analyze_res = await client.post(
            "/api/v1/github/repositories/analyze",
            json=analyze_payload,
            cookies=auth_cookies,
        )
        print(f"POST /analyze response status: {analyze_res.status_code}")
        assert analyze_res.status_code in (200, 202), f"Unexpected status: {analyze_res.status_code}: {analyze_res.text}"

        analyze_data = analyze_res.json()
        submit_status = analyze_data["status"]
        cw_repo_id = analyze_data["repository_id"]
        run_id = analyze_data["run_id"]
        job_id = analyze_data.get("job_id")
        commit_sha = analyze_data.get("commit_sha")

        print(f"✓ Submission result: status='{submit_status}', repository_id={cw_repo_id}, run_id={run_id}, commit_sha={commit_sha}")
        assert submit_status in ("newly_queued", "analyzing", "ready")
        assert cw_repo_id is not None
        assert run_id is not None
        assert commit_sha is not None and len(commit_sha) == 40

        # ─────────────────────────────────────────────────────────────────
        # STEP 3: Worker Execution Monitoring
        # ─────────────────────────────────────────────────────────────────
        print("\n--- Step 3: Worker Execution Monitoring ---")
        max_wait_seconds = 60
        poll_interval = 2.0
        elapsed = 0.0

        run_completed = False
        while elapsed < max_wait_seconds:
            async with AsyncSessionLocal() as session:
                run_row = await session.get(AnalysisRun, run_id)
                repo_row = await session.get(Repository, cw_repo_id)

                if run_row and run_row.status == AnalysisRunStatus.complete:
                    run_completed = True
                    print(f"✓ AnalysisRun completed in ~{elapsed:.1f}s!")
                    break
                elif run_row and run_row.status == AnalysisRunStatus.failed:
                    print(f"ERROR: AnalysisRun failed! error={run_row.error_message}")
                    sys.exit(1)
                else:
                    curr_run_st = run_row.status.value if run_row else "unknown"
                    curr_repo_st = repo_row.status.value if repo_row else "unknown"
                    print(f"  Waiting for worker... run={curr_run_st}, repo={curr_repo_st} ({elapsed:.1f}s)")

            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

        if not run_completed:
            print(f"ERROR: AnalysisRun did not complete within {max_wait_seconds}s.")
            sys.exit(1)

        # Verify database entities
        async with AsyncSessionLocal() as session:
            repo_row = await session.get(Repository, cw_repo_id)
            run_row = await session.get(AnalysisRun, run_id)
            city_row = (await session.execute(
                select(City).where(City.run_id == run_id)
            )).scalar_one_or_none()

            assert repo_row is not None
            assert repo_row.is_private is True
            assert repo_row.github_repository_id == priv_gh_id
            assert repo_row.status == RepositoryStatus.ready
            print(f"✓ Repository in DB: is_private=True, github_repository_id={repo_row.github_repository_id}, status={repo_row.status.value}")

            assert run_row is not None
            assert run_row.status == AnalysisRunStatus.complete
            assert run_row.commit_sha == commit_sha
            print(f"✓ AnalysisRun in DB: status={run_row.status.value}, commit_sha={run_row.commit_sha}")

            # Verify no tokens leaked in analysis_meta
            meta_str = str(run_row.analysis_meta)
            assert "ghu_" not in meta_str, "User token leaked in analysis_meta!"
            assert "ghs_" not in meta_str, "Installation token leaked in analysis_meta!"
            assert "Bearer" not in meta_str, "Bearer token leaked in analysis_meta!"
            print("✓ Zero secret tokens leaked in AnalysisRun.analysis_meta.")

            assert city_row is not None
            print(f"✓ City created: city_id={city_row.id}, generated_at={city_row.generated_at}")

        # ─────────────────────────────────────────────────────────────────
        # STEP 4: Private City Authorization Verification
        # ─────────────────────────────────────────────────────────────────
        print("\n--- Step 4: Private City Authorization Verification ---")

        # 4a. Authenticated request with authorized user session -> 200 OK
        city_auth_res = await client.get(f"/api/v1/cities/{cw_repo_id}", cookies=auth_cookies)
        assert city_auth_res.status_code == 200, f"Expected 200, got {city_auth_res.status_code}: {city_auth_res.text}"
        city_data = city_auth_res.json()
        print(f"✓ Authorized GET /cities/{cw_repo_id}: 200 OK")
        print(f"    Repository: {city_data.get('repository_name')} ({city_data.get('repository_owner')})")
        print(f"    Commit SHA: {city_data.get('commit_sha')}")
        print(f"    Districts:  {len(city_data.get('districts', []))}")
        print(f"    Buildings:  {len(city_data.get('buildings', []))}")
        print(f"    Connections:{len(city_data.get('connections', []))}")
        assert city_data["commit_sha"] == commit_sha
        assert len(city_data.get("buildings", [])) >= 0

        # 4b. Completely anonymous request without session cookie -> 401 Unauthorized
        city_anon_res = await client.get(f"/api/v1/cities/{cw_repo_id}")
        assert city_anon_res.status_code == 401, f"Expected 401, got {city_anon_res.status_code}: {city_anon_res.text}"
        print(f"✓ Anonymous GET /cities/{cw_repo_id}: 401 Unauthorized (detail: {city_anon_res.json().get('detail')})")

        # ─────────────────────────────────────────────────────────────────
        # STEP 5: Public Regressions Check
        # ─────────────────────────────────────────────────────────────────
        print("\n--- Step 5: Public Regressions Check ---")
        h_res = await client.get("/api/v1/health")
        assert h_res.status_code == 200
        print("✓ /api/v1/health: 200 OK")

        pub_analyze = await client.post("/api/v1/repositories", json={"url": "https://github.com/tiangolo/fastapi"})
        assert pub_analyze.status_code == 200
        assert pub_analyze.json()["status"] == "ready"
        print("✓ Public POST /api/v1/repositories: 200 ready")

        pub_city = await client.get("/api/v1/cities/2e945127-9c5d-4b5a-a0d9-9d52e2cbadfe")
        assert pub_city.status_code == 200
        print(f"✓ Anonymous public GET /cities/starlette: 200 OK ({len(pub_city.json()['buildings'])} buildings)")

    print("\n" + "=" * 68)
    print("     ALL LIVE CP5.5B SMOKE TEST CHECKS PASSED SUCCESSFULLY!       ")
    print("=" * 68)


if __name__ == "__main__":
    asyncio.run(run_live_smoke_test())
