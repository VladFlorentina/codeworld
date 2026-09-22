"""Dependency graph construction and cycle detection using NetworkX."""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import PurePosixPath

import networkx as nx

from analyzer.models import DependencyEdge, FileAnalysis, ImportedSymbol

logger = logging.getLogger(__name__)


@dataclass
class GraphAnalysis:
    """Complete output of the dependency graph analysis step."""

    graph: nx.DiGraph
    external_deps: dict[str, list[str]] = field(default_factory=dict)
    unresolved_imports: dict[str, list[str]] = field(default_factory=dict)
    edges: list[DependencyEdge] = field(default_factory=list)
    in_degree: dict[str, int] = field(default_factory=dict)
    out_degree: dict[str, int] = field(default_factory=dict)
    circular_groups: list[list[str]] = field(default_factory=list)
    isolated_files: list[str] = field(default_factory=list)


class PythonResolver:
    """
    Conservative import resolver for Python source files.
    Only resolves to an internal edge if the target matches a file in file_set.
    """

    @staticmethod
    def resolve(
        sym: ImportedSymbol,
        source_path: str,
        file_set: set[str],
    ) -> tuple[str | None, str]:
        """
        Returns (resolved_path_or_pkg_name, status)
        where status is one of: "internal", "external", "unresolved".
        """
        raw = sym.raw.strip()
        if not raw:
            return None, "unresolved"

        source_posix = PurePosixPath(source_path)
        source_dir = source_posix.parent

        # ── 1. Relative Import (.submodule or ..submodule) ────
        if raw.startswith("."):
            dots = len(raw) - len(raw.lstrip("."))
            submodule = raw[dots:].strip()

            # Navigate directory levels
            # 1 dot  = same directory (source_dir)
            # 2 dots = parent directory
            # 3 dots = grandparent directory
            cur_dir = source_dir
            for _ in range(dots - 1):
                if str(cur_dir) == "." or not cur_dir.parts:
                    # Escaping root directory
                    return None, "unresolved"
                cur_dir = cur_dir.parent

            base_prefix = "" if str(cur_dir) == "." else f"{cur_dir}/"

            if submodule:
                sub_path = submodule.replace(".", "/")
                candidates = [
                    f"{base_prefix}{sub_path}.py",
                    f"{base_prefix}{sub_path}/__init__.py",
                ]
            else:
                candidates = [
                    f"{base_prefix}__init__.py",
                ]

            for cand in candidates:
                cand_clean = cand.lstrip("/")
                if cand_clean in file_set:
                    return cand_clean, "internal"

            return raw, "unresolved"

        # ── 2. Absolute Import (e.g. "app.models" or "fastapi") ─
        candidate_rel = raw.replace(".", "/")
        candidates = [
            f"{candidate_rel}.py",
            f"{candidate_rel}/__init__.py",
        ]
        for cand in candidates:
            if cand in file_set:
                return cand, "internal"

        # If not found internally, top-level package name is external
        top_pkg = raw.split(".")[0]
        return top_pkg, "external"


# ─────────────────────────────────────────────────────────────
# TypeScript / JavaScript Import Resolver
# ─────────────────────────────────────────────────────────────

class TypeScriptResolver:
    """
    Conservative import resolver for TypeScript and JavaScript.
    Supports relative imports (./, ../) and convention @/ -> src/.
    External packages are identified without guesswork.
    """

    EXTENSIONS = (".ts", ".tsx", ".js", ".jsx")
    INDEX_FILES = ("/index.ts", "/index.tsx", "/index.js", "/index.jsx")

    @classmethod
    def _find_matching_target(cls, base_path: str, file_set: set[str]) -> str | None:
        """Check direct match, extensions, and directory index files."""
        # 1. Exact match (e.g. import './styles.css')
        if base_path in file_set:
            return base_path

        # 2. Extension match (.ts, .tsx, .js, .jsx)
        for ext in cls.EXTENSIONS:
            cand = f"{base_path}{ext}"
            if cand in file_set:
                return cand

        # 3. Directory index match (/index.ts, etc.)
        for idx in cls.INDEX_FILES:
            cand = f"{base_path}{idx}"
            if cand in file_set:
                return cand

        return None

    @classmethod
    def resolve(
        cls,
        sym: ImportedSymbol,
        source_path: str,
        file_set: set[str],
    ) -> tuple[str | None, str]:
        """
        Returns (resolved_path_or_pkg_name, status)
        where status is one of: "internal", "external", "unresolved".
        """
        raw = sym.raw.strip()
        if not raw:
            return None, "unresolved"

        # ── 1. Relative Import (./ or ../) ───────────────────
        if raw.startswith("./") or raw.startswith("../"):
            source_dir = os.path.dirname(source_path)
            combined = os.path.normpath(os.path.join(source_dir, raw)).replace("\\", "/")
            if combined.startswith(".."):
                # Escapes repository root
                return None, "unresolved"

            matched = cls._find_matching_target(combined, file_set)
            if matched:
                return matched, "internal"
            return raw, "unresolved"

        # ── 2. Path Alias Convention (@/ -> src/) ────────────
        if raw.startswith("@/"):
            subpath = raw.removeprefix("@/")
            candidate = os.path.normpath(os.path.join("src", subpath)).replace("\\", "/")
            matched = cls._find_matching_target(candidate, file_set)
            if matched:
                return matched, "internal"
            return raw, "unresolved"

        # ── 3. External npm package ──────────────────────────
        return raw, "external"


# ─────────────────────────────────────────────────────────────
# Main Graph Builder Function
# ─────────────────────────────────────────────────────────────

def build_dependency_graph(
    file_analyses: list[FileAnalysis],
    file_set: set[str],
) -> GraphAnalysis:
    """
    Construct the repository dependency graph from file analysis results.

    Args:
        file_analyses: List of analyzed files with extracted AST imports.
        file_set: Set of all known file paths discovered in the repository.

    Returns:
        GraphAnalysis containing the NetworkX DiGraph, edge lists,
        external/unresolved mappings, and cycle/degree metrics.
    """
    graph = nx.DiGraph()

    # Pre-populate all known repository files as nodes
    # This guarantees that isolated files exist in the graph with degree 0
    for file_path in file_set:
        graph.add_node(file_path)

    external_deps: dict[str, list[str]] = {}
    unresolved_imports: dict[str, list[str]] = {}
    edges_set: set[tuple[str, str]] = set()

    for fa in file_analyses:
        source_path = fa.file_info.path
        lang = fa.file_info.language

        ext_list: list[str] = []
        unresolved_list: list[str] = []

        for sym in fa.imports:
            if lang == "Python":
                target, status = PythonResolver.resolve(sym, source_path, file_set)
            elif lang in ("TypeScript", "JavaScript"):
                target, status = TypeScriptResolver.resolve(sym, source_path, file_set)
            else:
                # Generic fallback
                if sym.raw.startswith("."):
                    source_dir = os.path.dirname(source_path)
                    combined = os.path.normpath(os.path.join(source_dir, sym.raw)).replace("\\", "/")
                    if combined in file_set:
                        target, status = combined, "internal"
                    else:
                        target, status = sym.raw, "unresolved"
                else:
                    target, status = sym.raw, "external"

            if status == "internal" and target:
                if target != source_path:  # Avoid self-loops
                    graph.add_edge(source_path, target)
                    edges_set.add((source_path, target))
            elif status == "external" and target:
                if target not in ext_list:
                    ext_list.append(target)
            elif status == "unresolved":
                unresolved_item = target or sym.raw
                if unresolved_item not in unresolved_list:
                    unresolved_list.append(unresolved_item)

        if ext_list:
            external_deps[source_path] = ext_list
        if unresolved_list:
            unresolved_imports[source_path] = unresolved_list

    # ── Convert deduplicated internal edges to DependencyEdge models ──
    edges = [
        DependencyEdge(source_path=src, target=dst, edge_type="import")
        for src, dst in sorted(edges_set)
    ]

    # ── Calculate Graph Metrics ──────────────────────────────
    in_degree = dict(graph.in_degree())
    out_degree = dict(graph.out_degree())

    # Detect Strongly Connected Components with size > 1 (circular dependencies)
    circular_groups = [
        sorted(list(scc))
        for scc in nx.strongly_connected_components(graph)
        if len(scc) > 1
    ]
    # Sort groups deterministically
    circular_groups.sort(key=lambda g: (-len(g), g[0] if g else ""))

    # Detect isolated files (0 in-degree and 0 out-degree)
    isolated_files = sorted(
        node for node in graph.nodes()
        if in_degree[node] == 0 and out_degree[node] == 0
    )

    logger.info(
        "Dependency graph constructed",
        extra={
            "total_nodes": graph.number_of_nodes(),
            "total_edges": graph.number_of_edges(),
            "circular_groups": len(circular_groups),
            "isolated_files": len(isolated_files),
        },
    )

    return GraphAnalysis(
        graph=graph,
        external_deps=external_deps,
        unresolved_imports=unresolved_imports,
        edges=edges,
        in_degree=in_degree,
        out_degree=out_degree,
        circular_groups=circular_groups,
        isolated_files=isolated_files,
    )
