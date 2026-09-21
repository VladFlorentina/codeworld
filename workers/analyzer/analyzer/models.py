"""
Internal data models for the CodeWorld analysis pipeline.

These are plain Python dataclasses — not SQLAlchemy ORM models,
not Pydantic schemas. They are the pipeline's internal language.

Data flows like this:
  FileInfo         → produced by discovery.py
  FileAnalysis     → produced by ast/ analyzers (one per FileInfo)
  DependencyEdge   → produced by deps.py
  AnalysisResult   → aggregated by pipeline.py, consumed by world_generator.py

The world_generator converts AnalysisResult → CityDTO dict,
which is then persisted to PostgreSQL and served to the frontend.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


# ─────────────────────────────────────────────────────────────
# Step 1 output — file discovery
# ─────────────────────────────────────────────────────────────

@dataclass
class FileInfo:
    """
    Basic metadata about a single file discovered in the repository.
    Produced by discovery.py, enriched by later pipeline steps.
    """
    # Path relative to the repository root (e.g. "src/api/users.py")
    path: str
    # Absolute path on the local filesystem (inside the clone directory)
    absolute_path: str
    # Language label (e.g. "Python", "TypeScript", None for unknown)
    language: str | None
    # Raw file size in bytes
    size_bytes: int
    # File extension including dot (e.g. ".py", ".ts")
    extension: str


# ─────────────────────────────────────────────────────────────
# Step 2 output — AST analysis (one per FileInfo)
# ─────────────────────────────────────────────────────────────

@dataclass
class ImportedSymbol:
    """A single import statement found in a file."""
    # The raw import path as written in the source
    # e.g. "os", "..auth.login", "@/components/Button"
    raw: str
    # Resolved absolute path within the repo, if we could determine it.
    # None for external packages or unresolvable relative imports.
    resolved_path: str | None = None
    # Whether this is an external package (True) or an intra-repo import (False)
    is_external: bool = False


@dataclass
class FileAnalysis:
    """
    Result of AST analysis for a single file.

    If the analyzer could not parse the file (unsupported language,
    syntax error, etc.) the counts stay at 0 and parse_error is set.
    The pipeline continues — one failed file never aborts the run.
    """
    file_info: FileInfo
    # Source line count: total, blank, and code-only
    loc_total: int = 0
    loc_blank: int = 0
    loc_code: int = 0
    # Structural counts from AST
    function_count: int = 0
    class_count: int = 0
    # interface_count is only populated by language analyzers where the concept
    # exists (currently: TypeScript). For Python and all other languages it
    # remains 0. Separated from class_count because TypeScript interfaces are
    # erased at runtime and carry different architectural meaning than classes.
    interface_count: int = 0
    # Cyclomatic complexity estimate (sum over all functions in the file)
    complexity: int = 0
    # Imports found in this file
    imports: list[ImportedSymbol] = field(default_factory=list)
    # If parsing failed, the error message is recorded here.
    # The analysis still proceeds with whatever counts are available.
    parse_error: str | None = None


# ─────────────────────────────────────────────────────────────
# Step 3 output — dependency edges
# ─────────────────────────────────────────────────────────────

@dataclass
class DependencyEdge:
    """
    A directed dependency between two entities.

    source_path → target_path (intra-repo) or external package name.

    These edges form the dependency graph analyzed by deps.py
    and rendered as connections between buildings in the 3D city.
    """
    # Relative path of the file that contains the import
    source_path: str
    # For intra-repo imports: relative path of the imported file
    # For external imports: package name (e.g. "fastapi", "react")
    target: str
    # "import" = resolved to another file in this repo
    # "package" = external dependency (npm/pip/etc.)
    edge_type: str  # Literal["import", "package"]


# ─────────────────────────────────────────────────────────────
# Aggregate — the complete output of the analysis pipeline
# ─────────────────────────────────────────────────────────────

@dataclass
class AnalysisResult:
    """
    The complete output of one analysis run.

    Produced by pipeline.py, consumed by world_generator.py.
    Persisted to PostgreSQL by the worker after world generation.
    """
    # The GitHub URL that was analyzed
    repository_url: str
    # Owner and repo name parsed from the URL (e.g. "tiangolo", "fastapi")
    owner: str
    repo_name: str
    # The HEAD commit SHA at the time of analysis
    commit_sha: str | None
    # Local path where the repository was cloned
    clone_path: str
    # All files discovered (after .gitignore filtering, binary skipping, etc.)
    files: list[FileInfo] = field(default_factory=list)
    # AST analysis results (one per file; may be a subset if some files failed)
    file_analyses: list[FileAnalysis] = field(default_factory=list)
    # All dependency edges extracted from imports
    dependency_edges: list[DependencyEdge] = field(default_factory=list)
    # Files that were skipped and why (for debugging / progress reporting)
    skipped_files: list[tuple[str, str]] = field(default_factory=list)

    @property
    def analysis_by_path(self) -> dict[str, FileAnalysis]:
        """Quick lookup: file path → FileAnalysis."""
        return {fa.file_info.path: fa for fa in self.file_analyses}

    @property
    def total_loc(self) -> int:
        return sum(fa.loc_code for fa in self.file_analyses)

    @property
    def languages(self) -> set[str]:
        return {f.language for f in self.files if f.language}
