"""
World generator: transforms repository analysis results into CityDTO.

Responsibilities:
  - Construct a hierarchical district tree (DistrictDTO) matching repository directories.
  - Map files to buildings (BuildingDTO) with 1:1 raw metrics preserved.
  - Map internal dependency edges to connections (ConnectionDTO) between building IDs.
  - Generate deterministic, collision-proof identifiers using UUID5 derived from paths.
  - Aggregate repository-level summary metrics (CitySummaryDTO).
  - Do NOT calculate 3D layout, spatial coordinates, or visual dimensions.
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from analyzer.deps import GraphAnalysis
from analyzer.language import get_language_color
from analyzer.models import FileAnalysis, FileInfo

# Fixed DNS namespace for CodeWorld deterministic UUID5 generation
CODEWORLD_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_DNS, "codeworld.dev")


# ─────────────────────────────────────────────────────────────
# Deterministic ID Helpers
# ─────────────────────────────────────────────────────────────

def make_district_id(dir_path: str, scope: str = "") -> str:
    """Deterministic UUID5 for a directory path, optionally scoped to a run/city."""
    norm = dir_path.strip("/").replace("\\", "/")
    token = f"district:{scope}:{norm}" if scope else f"district:{norm}"
    return str(uuid.uuid5(CODEWORLD_NAMESPACE, token))


def make_building_id(file_path: str, scope: str = "") -> str:
    """Deterministic UUID5 for a file path, optionally scoped to a run/city."""
    norm = file_path.strip("/").replace("\\", "/")
    token = f"building:{scope}:{norm}" if scope else f"building:{norm}"
    return str(uuid.uuid5(CODEWORLD_NAMESPACE, token))


def make_connection_id(source_path: str, target_path: str, scope: str = "") -> str:
    """Deterministic UUID5 for a dependency edge, optionally scoped to a run/city."""
    src = source_path.strip("/").replace("\\", "/")
    dst = target_path.strip("/").replace("\\", "/")
    token = f"connection:{scope}:{src}->{dst}" if scope else f"connection:{src}->{dst}"
    return str(uuid.uuid5(CODEWORLD_NAMESPACE, token))


# ─────────────────────────────────────────────────────────────
# DTO Definitions
# ─────────────────────────────────────────────────────────────

@dataclass
class BuildingMetricsDTO:
    loc_total: int
    loc_code: int
    loc_blank: int
    complexity: int
    function_count: int
    class_count: int
    interface_count: int
    in_degree: int
    out_degree: int
    is_in_cycle: bool


@dataclass
class BuildingDTO:
    id: str                   # Deterministic uuid5
    district_id: str          # Deterministic uuid5 of parent district
    name: str                 # Filename, e.g. "routing.py"
    path: str                 # Full relative path, e.g. "fastapi/routing.py"
    language: str | None      # "Python", "TypeScript", etc.
    color_hex: str            # Linguist color, e.g. "#3572A5"
    metrics: BuildingMetricsDTO


@dataclass
class DistrictDTO:
    id: str                   # Deterministic uuid5
    path: str                 # Directory path, "" for root, "fastapi/routing"
    name: str                 # Directory name, "root", "routing"
    parent_id: str | None     # None for root, parent district uuid5 otherwise
    depth: int                # 0 for root, 1, 2, ...


@dataclass
class ConnectionDTO:
    id: str                   # Deterministic uuid5
    source_building_id: str   # UUID5 of importing building
    target_building_id: str   # UUID5 of imported building
    connection_type: str      # "import"
    is_circular: bool         # True if part of a strongly connected cycle


@dataclass
class CitySummaryDTO:
    total_files: int
    total_loc_code: int
    total_complexity: int
    languages: dict[str, int]
    circular_dependency_count: int  # Strict count of circular groups (SCC > 1)


@dataclass
class CityDTO:
    repository_name: str
    commit_sha: str | None
    summary: CitySummaryDTO
    districts: list[DistrictDTO]
    buildings: list[BuildingDTO]
    connections: list[ConnectionDTO]


# ─────────────────────────────────────────────────────────────
# District Hierarchy Builder
# ─────────────────────────────────────────────────────────────

def _build_district_hierarchy(file_paths: list[str], scope: str = "") -> list[DistrictDTO]:
    """
    Given all relative file paths, deduce all required unique directory paths
    from root down to leaf folders, and build DistrictDTOs with parent_id and depth.
    """
    all_dirs: set[str] = {""}

    for fp in file_paths:
        parts = PurePosixPath(fp).parts[:-1]  # drop filename
        cur = ""
        for part in parts:
            cur = f"{cur}/{part}" if cur else part
            all_dirs.add(cur)

    districts: list[DistrictDTO] = []

    for d in sorted(all_dirs):
        dist_id = make_district_id(d, scope=scope)
        if not d:
            # Root district
            districts.append(
                DistrictDTO(
                    id=dist_id,
                    path="",
                    name="root",
                    parent_id=None,
                    depth=0,
                )
            )
        else:
            posix_d = PurePosixPath(d)
            parent_d = str(posix_d.parent)
            if parent_d == ".":
                parent_d = ""

            districts.append(
                DistrictDTO(
                    id=dist_id,
                    path=d,
                    name=posix_d.name,
                    parent_id=make_district_id(parent_d, scope=scope),
                    depth=len(posix_d.parts),
                )
            )

    return sorted(districts, key=lambda d: (d.depth, d.path))


# ─────────────────────────────────────────────────────────────
# Main Generator
# ─────────────────────────────────────────────────────────────

def generate_city_dto(
    files: list[FileInfo],
    file_analyses: list[FileAnalysis],
    graph_analysis: GraphAnalysis,
    repository_name: str,
    commit_sha: str | None = None,
    scope: str = "",
) -> CityDTO:
    """
    Generate a normalized CityDTO from analysis results.

    Args:
        files: All discovered repository files.
        file_analyses: Analyzed file details with extracted metrics and AST info.
        graph_analysis: NetworkX graph analysis result with degrees and cycles.
        repository_name: Repository name/slug (e.g. "tiangolo/fastapi").
        commit_sha: Commit hash analyzed.
        scope: Optional scope identifier (e.g. run_id) to ensure globally unique
               deterministic IDs across different runs and repositories.

    Returns:
        CityDTO containing districts tree, buildings with raw metrics,
        and building-to-building connections.
    """
    # Quick lookup: path -> FileAnalysis
    analysis_by_path: dict[str, FileAnalysis] = {
        fa.file_info.path: fa for fa in file_analyses
    }

    # Set of files belonging to any circular group (SCC > 1)
    cycle_nodes: set[str] = set()
    for group in graph_analysis.circular_groups:
        cycle_nodes.update(group)

    # ── 1. Districts ──────────────────────────────────────────
    file_paths = [f.path for f in files]
    districts = _build_district_hierarchy(file_paths, scope=scope)

    # ── 2. Buildings ──────────────────────────────────────────
    buildings: list[BuildingDTO] = []
    languages_count: dict[str, int] = {}
    total_loc_code = 0
    total_complexity = 0

    for f in files:
        fa = analysis_by_path.get(f.path)

        # Parent district
        parent_dir = str(PurePosixPath(f.path).parent)
        if parent_dir == ".":
            parent_dir = ""
        district_id = make_district_id(parent_dir, scope=scope)

        # Raw metrics
        if fa is not None:
            loc_total = fa.loc_total
            loc_code = fa.loc_code
            loc_blank = fa.loc_blank
            complexity = fa.complexity
            function_count = fa.function_count
            class_count = fa.class_count
            interface_count = fa.interface_count
        else:
            loc_total = 0
            loc_code = 0
            loc_blank = 0
            complexity = 0
            function_count = 0
            class_count = 0
            interface_count = 0

        total_loc_code += loc_code
        total_complexity += complexity

        lang_label = f.language or "Unknown"
        languages_count[lang_label] = languages_count.get(lang_label, 0) + 1

        in_deg = graph_analysis.in_degree.get(f.path, 0)
        out_deg = graph_analysis.out_degree.get(f.path, 0)
        is_in_cycle = f.path in cycle_nodes

        metrics = BuildingMetricsDTO(
            loc_total=loc_total,
            loc_code=loc_code,
            loc_blank=loc_blank,
            complexity=complexity,
            function_count=function_count,
            class_count=class_count,
            interface_count=interface_count,
            in_degree=in_deg,
            out_degree=out_deg,
            is_in_cycle=is_in_cycle,
        )

        buildings.append(
            BuildingDTO(
                id=make_building_id(f.path, scope=scope),
                district_id=district_id,
                name=PurePosixPath(f.path).name,
                path=f.path,
                language=f.language,
                color_hex=get_language_color(f.language),
                metrics=metrics,
            )
        )

    buildings.sort(key=lambda b: b.path)

    # ── 3. Connections ────────────────────────────────────────
    connections: list[ConnectionDTO] = []
    for edge in graph_analysis.edges:
        # An edge is circular if both endpoints belong to the SAME circular group
        edge_is_circular = any(
            edge.source_path in g and edge.target in g
            for g in graph_analysis.circular_groups
        )

        connections.append(
            ConnectionDTO(
                id=make_connection_id(edge.source_path, edge.target, scope=scope),
                source_building_id=make_building_id(edge.source_path, scope=scope),
                target_building_id=make_building_id(edge.target, scope=scope),
                connection_type=edge.edge_type,
                is_circular=edge_is_circular,
            )
        )

    connections.sort(key=lambda c: (c.source_building_id, c.target_building_id))

    # ── 4. Summary ────────────────────────────────────────────
    summary = CitySummaryDTO(
        total_files=len(buildings),
        total_loc_code=total_loc_code,
        total_complexity=total_complexity,
        languages=dict(sorted(languages_count.items(), key=lambda x: -x[1])),
        circular_dependency_count=len(graph_analysis.circular_groups),
    )

    return CityDTO(
        repository_name=repository_name,
        commit_sha=commit_sha,
        summary=summary,
        districts=districts,
        buildings=buildings,
        connections=connections,
    )
