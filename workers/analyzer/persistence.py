from __future__ import annotations

import dataclasses
import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from analyzer.deps import GraphAnalysis
from analyzer.models import FileAnalysis
from analyzer.world_generator import CityDTO
from codeworld_db import (
    AnalysisRun,
    AnalysisRunStatus,
    Building,
    City,
    Connection,
    DependencyEdge,
    District,
    EdgeType,
    FileRecord,
    Repository,
    RepositoryStatus,
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def persist_analysis_result(
    session: AsyncSession,
    repo: Repository,
    run: AnalysisRun,
    *,
    file_analyses: list[FileAnalysis],
    graph_analysis: GraphAnalysis,
    city_dto: CityDTO,
    commit_sha: str,
) -> str:
    """
    Persist completed analysis entities and update run/repository records.

    Inserts FileRecord, City, District, Building, Connection, DependencyEdge rows.
    Updates AnalysisRun (status=complete, meta summary, commit_sha, completed_at)
    and Repository (status=ready).

    Flushes all changes to the provided session without committing, allowing
    the calling orchestrator to own transaction commit/rollback.

    Returns:
        The generated city_id (UUID string).
    """
    file_rec_map: dict[str, str] = {}
    file_records_to_insert: list[FileRecord] = []
    cycle_nodes = {n for g in graph_analysis.circular_groups for n in g}

    for fa in file_analyses:
        f_id = str(uuid.uuid4())
        file_rec_map[fa.file_info.path] = f_id
        extra_metrics = {
            "loc_total": fa.loc_total,
            "loc_blank": fa.loc_blank,
            "interface_count": fa.interface_count,
            "in_degree": graph_analysis.in_degree.get(fa.file_info.path, 0),
            "out_degree": graph_analysis.out_degree.get(fa.file_info.path, 0),
            "is_in_cycle": fa.file_info.path in cycle_nodes,
        }
        file_records_to_insert.append(
            FileRecord(
                id=f_id,
                run_id=run.id,
                path=fa.file_info.path,
                language=fa.file_info.language,
                loc=fa.loc_code,
                complexity=fa.complexity,
                function_count=fa.function_count,
                class_count=fa.class_count,
                import_count=len(fa.imports),
                metrics=extra_metrics,
            )
        )

    session.add_all(file_records_to_insert)
    await session.flush()

    city_id = str(uuid.uuid4())
    city_row = City(
        id=city_id,
        run_id=run.id,
        repository_id=repo.id,
        generated_at=utcnow(),
    )
    session.add(city_row)
    await session.flush()

    districts_to_insert = [
        District(
            id=d.id,
            city_id=city_id,
            parent_id=d.parent_id,
            path=d.path,
            name=d.name,
            depth=d.depth,
        )
        for d in city_dto.districts
    ]
    session.add_all(districts_to_insert)
    await session.flush()

    buildings_to_insert = []
    for b in city_dto.buildings:
        fr_id = file_rec_map.get(b.path)
        if not fr_id:
            fr_id = str(uuid.uuid4())
            session.add(
                FileRecord(
                    id=fr_id,
                    run_id=run.id,
                    path=b.path,
                    language=b.language,
                    loc=0,
                    metrics={},
                )
            )
            await session.flush()

        buildings_to_insert.append(
            Building(
                id=b.id,
                city_id=city_id,
                district_id=b.district_id,
                file_record_id=fr_id,
                name=b.name,
                path=b.path,
                color_hex=b.color_hex,
                height=1.0,
                width=1.0,
                depth=1.0,
                position_x=0.0,
                position_z=0.0,
            )
        )
    session.add_all(buildings_to_insert)
    await session.flush()

    valid_bld_ids = {b.id for b in buildings_to_insert}
    connections_to_insert = [
        Connection(
            id=c.id,
            city_id=city_id,
            source_building_id=c.source_building_id,
            target_building_id=c.target_building_id,
            connection_type=c.connection_type,
        )
        for c in city_dto.connections
        if c.source_building_id in valid_bld_ids and c.target_building_id in valid_bld_ids
    ]
    session.add_all(connections_to_insert)
    await session.flush()

    dep_edges_to_insert = [
        DependencyEdge(
            id=str(uuid.uuid4()),
            run_id=run.id,
            source_file=e.source_path,
            target_file=e.target,
            edge_type=EdgeType.import_ if e.edge_type == "import" else EdgeType.package,
        )
        for e in graph_analysis.edges
    ]
    session.add_all(dep_edges_to_insert)
    await session.flush()

    current_meta = dict(run.analysis_meta or {})
    current_meta["summary"] = dataclasses.asdict(city_dto.summary)
    run.analysis_meta = current_meta
    run.commit_sha = commit_sha
    run.status = AnalysisRunStatus.complete
    run.completed_at = utcnow()
    repo.status = RepositoryStatus.ready

    return city_id
