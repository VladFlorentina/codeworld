from __future__ import annotations

import logging
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.services.repository_service import authorize_repository_access
from codeworld_db import (
    AnalysisRun,
    AnalysisRunStatus,
    Building,
    City,
    Connection,
    District,
    FileRecord,
    Repository,
    RepositoryStatus,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/cities/{repository_id}")
async def get_city(
    repository_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Get the completed CityDTO for a repository.

    Reconstructs the hierarchical city representation (districts, buildings
    with raw metrics, connections, and summary) directly from PostgreSQL.

    Security:
      - Public repositories (is_private=False) are accessible anonymously.
      - Private repositories (is_private=True) require an active CodeWorld session
        and live verification via GitHub App that the user has access to the
        numeric github_repository_id.
    """
    # 1. Fetch Repository
    repo = await db.get(Repository, repository_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")

    # 2. Authorization check for private repositories
    await authorize_repository_access(repo, request, db)

    if repo.status in (RepositoryStatus.pending, RepositoryStatus.analyzing):
        raise HTTPException(status_code=409, detail="Analysis is still in progress")
    if repo.status == RepositoryStatus.failed:
        raise HTTPException(status_code=400, detail="Repository analysis failed")

    # 2. Fetch latest completed City
    stmt_city = (
        select(City)
        .join(AnalysisRun, City.run_id == AnalysisRun.id)
        .where(City.repository_id == repository_id)
        .where(AnalysisRun.status == AnalysisRunStatus.complete)
        .order_by(City.generated_at.desc())
        .limit(1)
    )
    res_city = await db.execute(stmt_city)
    city = res_city.scalar_one_or_none()

    if not city:
        raise HTTPException(status_code=404, detail="No completed city found for this repository")

    # 3. Fetch AnalysisRun for summary metadata
    run = await db.get(AnalysisRun, city.run_id)
    summary_data = run.analysis_meta.get("summary") if run and run.analysis_meta else {}

    # 4. Fetch Districts
    stmt_d = select(District).where(District.city_id == city.id).order_by(District.depth, District.path)
    res_d = await db.execute(stmt_d)
    districts = [
        {
            "id": d.id,
            "path": d.path,
            "name": d.name,
            "parent_id": d.parent_id,
            "depth": d.depth,
        }
        for d in res_d.scalars().all()
    ]

    # 5. Fetch Buildings joined with FileRecords for raw metrics
    stmt_b = (
        select(Building, FileRecord)
        .join(FileRecord, Building.file_record_id == FileRecord.id)
        .where(Building.city_id == city.id)
        .order_by(Building.path)
    )
    res_b = await db.execute(stmt_b)
    buildings = []
    for b, fr in res_b.all():
        extra = fr.metrics or {}
        buildings.append({
            "id": b.id,
            "district_id": b.district_id,
            "name": b.name,
            "path": b.path,
            "language": fr.language,
            "color_hex": b.color_hex,
            "metrics": {
                "loc_total": extra.get("loc_total", fr.loc),
                "loc_code": fr.loc,
                "loc_blank": extra.get("loc_blank", 0),
                "complexity": fr.complexity,
                "function_count": fr.function_count,
                "class_count": fr.class_count,
                "interface_count": extra.get("interface_count", 0),
                "in_degree": extra.get("in_degree", 0),
                "out_degree": extra.get("out_degree", 0),
                "is_in_cycle": extra.get("is_in_cycle", False),
            },
        })

    # 6. Fetch Connections
    stmt_c = select(Connection).where(Connection.city_id == city.id)
    res_c = await db.execute(stmt_c)
    connections = [
        {
            "id": c.id,
            "source_building_id": c.source_building_id,
            "target_building_id": c.target_building_id,
            "connection_type": c.connection_type,
            "is_circular": False,
        }
        for c in res_c.scalars().all()
    ]

    return {
        "repository_name": repo.full_name,
        "commit_sha": run.commit_sha if run else None,
        "summary": summary_data,
        "districts": districts,
        "buildings": buildings,
        "connections": connections,
    }
