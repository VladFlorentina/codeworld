from __future__ import annotations

import logging
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.schemas.world import WorldMapResponse
from app.services.explore_service import get_world_map_cities

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/explore/world", response_model=WorldMapResponse)
async def get_explore_world(
    db: AsyncSession = Depends(get_db),
) -> WorldMapResponse:
    """
    Public, anonymous endpoint returning all analyzed public repositories
    for the 2D World Map.

    Guarantees:
      - Anonymous access (HTTP 200 without cookies or tokens).
      - Zero live GitHub API calls.
      - Exactly one latest completed AnalysisRun per repository.
      - Strictly excludes private repositories and non-ready repositories.
    """
    cities = await get_world_map_cities(db)
    return WorldMapResponse(
        cities=cities,
        total_cities=len(cities),
    )
