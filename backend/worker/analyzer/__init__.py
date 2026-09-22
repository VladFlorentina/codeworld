"""
CodeWorld Analysis Pipeline.

Public interface — import from here, not from submodules directly.
"""
from analyzer.cloner import clone_repository, cleanup_clone, CloneError
from analyzer.discovery import discover_files, summarize_discovery
from analyzer.language import detect_language, get_language_color, is_binary_extension
from analyzer.models import FileInfo, FileAnalysis, DependencyEdge, AnalysisResult
from analyzer.ast import analyze_file, get_analyzer
from analyzer.deps import GraphAnalysis, build_dependency_graph
from analyzer.world_generator import (
    CityDTO,
    DistrictDTO,
    BuildingDTO,
    BuildingMetricsDTO,
    ConnectionDTO,
    CitySummaryDTO,
    generate_city_dto,
)

__all__ = [
    # Cloner
    "clone_repository",
    "cleanup_clone",
    "CloneError",
    # Discovery
    "discover_files",
    "summarize_discovery",
    # Language
    "detect_language",
    "get_language_color",
    "is_binary_extension",
    # Models
    "FileInfo",
    "FileAnalysis",
    "DependencyEdge",
    "AnalysisResult",
    # AST analysis
    "analyze_file",
    "get_analyzer",
    # Dependency Graph
    "GraphAnalysis",
    "build_dependency_graph",
    # World Generator
    "CityDTO",
    "DistrictDTO",
    "BuildingDTO",
    "BuildingMetricsDTO",
    "ConnectionDTO",
    "CitySummaryDTO",
    "generate_city_dto",
]
