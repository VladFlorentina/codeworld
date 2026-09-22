from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class WorldCityDTO(BaseModel):
    repository_id: UUID
    owner: str
    name: str
    full_name: str
    description: str | None = None
    primary_language: str
    total_files: int
    total_loc: int
    complexity: int
    commit_sha: str
    analyzed_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class WorldMapResponse(BaseModel):
    cities: list[WorldCityDTO]
    total_cities: int
