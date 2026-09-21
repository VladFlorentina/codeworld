"""
Checkpoint 5.2 Verification Script:
1. Verifies API /health endpoint returns 200 OK.
2. Verifies POST /api/v1/repositories with FastAPI returns 200 ready.
3. Verifies GET /api/v1/cities/{id} returns 200 with full city payload.
4. Verifies SQLAlchemy ORM querying User and Repository.is_private.
"""
import asyncio
import httpx
from codeworld_db import User, Repository
from app.database import AsyncSessionLocal
from sqlalchemy import select


async def test_orm_models():
    print("\n--- [ORM Models Test] ---")
    async with AsyncSessionLocal() as session:
        # Query repositories including is_private
        result = await session.execute(select(Repository).limit(5))
        repos = result.scalars().all()
        print(f"Loaded {len(repos)} repositories via ORM.")
        for r in repos:
            print(f"  Repo: {r.full_name}, is_private: {r.is_private}")
            assert r.is_private is False, f"Expected is_private=False for {r.full_name}"

        # Query User model
        user_result = await session.execute(select(User))
        users = user_result.scalars().all()
        print(f"Loaded {len(users)} users via ORM.")
    print("✓ PASS: ORM queries with new User model and is_private column succeed.")


def test_api_endpoints():
    print("\n--- [API Endpoints Test] ---")
    with httpx.Client(base_url="http://localhost:8000/api/v1", timeout=15.0) as client:
        # 1. Health
        h_res = client.get("/health")
        print(f"GET /health: status={h_res.status_code}, body={h_res.json()}")
        assert h_res.status_code == 200
        assert h_res.json()["status"] == "ok"
        print("✓ PASS: /health returns 200")

        # 2. POST FastAPI public repo
        f_res = client.post("/repositories", json={"url": "https://github.com/tiangolo/fastapi"})
        print(f"POST /repositories: status={f_res.status_code}, data={f_res.json()}")
        assert f_res.status_code == 200
        assert f_res.json()["status"] == "ready"
        print("✓ PASS: POST /repositories returns 200 ready")

        # 3. GET existing City
        # The endpoint expects repository_id:
        repo_id = "2e945127-9c5d-4b5a-a0d9-9d52e2cbadfe"  # Starlette
        c_res = client.get(f"/cities/{repo_id}")
        print(f"GET /cities/{repo_id}: status={c_res.status_code}")
        assert c_res.status_code == 200
        city_data = c_res.json()
        print(f"  City ID: {city_data.get('id')}")
        print(f"  Repository: {city_data.get('repository_name')}")
        print(f"  Districts: {len(city_data.get('districts', []))}")
        print(f"  Buildings: {len(city_data.get('buildings', []))}")
        print(f"  Connections: {len(city_data.get('connections', []))}")
        assert len(city_data.get("buildings", [])) > 0
        print("✓ PASS: GET /cities/{repository_id} returns full 3D layout data")


async def main():
    await test_orm_models()
    test_api_endpoints()
    print("\n==================================================================")
    print("   ALL CHECKPOINT 5.2 VERIFICATION TESTS PASSED SUCCESSFULLY!    ")
    print("==================================================================")


if __name__ == "__main__":
    asyncio.run(main())
