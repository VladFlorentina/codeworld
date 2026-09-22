from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.schemas.world import WorldCityDTO
from codeworld_db import (
    AnalysisRun,
    AnalysisRunStatus,
    Repository,
    RepositoryStatus,
)

logger = logging.getLogger(__name__)

# Categories excluded from primary source language determination
NON_SOURCE_LANGUAGES: set[str] = {
    "Markdown",
    "reStructuredText",
    "Text",
    "JSON",
    "YAML",
    "TOML",
    "XML",
    "Unknown",
}


def determine_primary_language(analysis_meta: dict[str, Any] | None) -> str:
    """
    Deterministically extracts the dominant source programming language by file count.

    Rules:
      - Reads analysis_meta['summary']['languages'] (dict[str, int]).
      - Excludes non-source/documentation/config categories (Markdown, JSON, YAML, etc.).
      - Ignores languages with count <= 0 or empty/None keys.
      - If no valid source language candidates remain, returns "Unknown".
      - Tie-breaker: sorts candidates by (-count, language_name), ensuring deterministic
        alphabetical resolution if counts are identical.
    """
    if not analysis_meta or not isinstance(analysis_meta, dict):
        return "Unknown"

    summary = analysis_meta.get("summary")
    if not summary or not isinstance(summary, dict):
        return "Unknown"

    languages = summary.get("languages")
    if not languages or not isinstance(languages, dict):
        return "Unknown"

    source_candidates: list[tuple[str, int]] = []
    for lang, count in languages.items():
        if not lang or lang in NON_SOURCE_LANGUAGES:
            continue
        try:
            cnt = int(count)
        except (ValueError, TypeError):
            continue
        if cnt > 0:
            source_candidates.append((str(lang), cnt))

    if not source_candidates:
        return "Unknown"

    # Deterministic sorting: highest file count first (-count), then alphabetical by name
    source_candidates.sort(key=lambda item: (-item[1], item[0]))
    return source_candidates[0][0]


async def get_world_map_cities(db: AsyncSession) -> list[WorldCityDTO]:
    """
    Query all public, ready repositories and their single latest completed AnalysisRun.

    Selection rules:
      - Repository must have is_private = False and status = 'ready'.
      - Uses ROW_NUMBER() partitioned by repository_id over complete runs ordered by:
          1. completed_at DESC NULLS LAST
          2. id DESC (deterministic tie-breaker)
      - Returns exactly one city record per repository.
      - Fallbacks defensively for missing/legacy metadata to prevent HTTP 500 errors.
    """
    ranked_runs = (
        select(
            AnalysisRun,
            func.row_number().over(
                partition_by=AnalysisRun.repository_id,
                order_by=(
                    AnalysisRun.completed_at.desc().nulls_last(),
                    AnalysisRun.id.desc(),
                ),
            ).label("rn"),
        )
        .where(AnalysisRun.status == AnalysisRunStatus.complete)
        .subquery()
    )

    aliased_run = aliased(AnalysisRun, ranked_runs)

    stmt = (
        select(Repository, aliased_run)
        .join(ranked_runs, Repository.id == ranked_runs.c.repository_id)
        .where(ranked_runs.c.rn == 1)
        .where(Repository.is_private.is_(False))
        .where(Repository.status == RepositoryStatus.ready)
        .order_by(Repository.full_name.asc())
    )

    result = await db.execute(stmt)
    rows = result.all()

    cities: list[WorldCityDTO] = []
    for repo, run in rows:
        meta = run.analysis_meta if isinstance(run.analysis_meta, dict) else {}
        summary = meta.get("summary") if isinstance(meta.get("summary"), dict) else {}

        primary_lang = determine_primary_language(meta)

        try:
            total_files = int(summary.get("total_files") or 0)
        except (ValueError, TypeError):
            total_files = 0

        try:
            total_loc = int(summary.get("total_loc_code") or 0)
        except (ValueError, TypeError):
            total_loc = 0

        try:
            complexity = int(summary.get("total_complexity") or 0)
        except (ValueError, TypeError):
            complexity = 0

        cities.append(
            WorldCityDTO(
                repository_id=UUID(str(repo.id)),
                owner=repo.github_owner,
                name=repo.github_name,
                full_name=repo.full_name,
                description=repo.description,
                primary_language=primary_lang,
                total_files=total_files,
                total_loc=total_loc,
                complexity=complexity,
                commit_sha=run.commit_sha or "",
                analyzed_at=run.completed_at,
            )
        )

    return cities
