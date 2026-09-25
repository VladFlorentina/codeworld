"""Versioned language-to-ecosystem vocabulary for the World Index.

Published versions are immutable. Add a new version when changing a mapping;
stored observations keep their original taxonomy_version.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping


@dataclass(frozen=True)
class WorldTaxonomy:
    version: str
    ecosystems: frozenset[str]
    language_to_ecosystem: Mapping[str, str]
    cross_cutting_tags: frozenset[str]

    def ecosystem_for_language(self, language: str) -> str | None:
        return self.language_to_ecosystem.get(language.strip().casefold())

    def aggregate_bytes(self, language_bytes: Mapping[str, int]) -> tuple[dict[str, int], int]:
        """Return mapped ecosystem bytes and unmapped bytes; never discard raw input."""
        ecosystem_bytes: dict[str, int] = {}
        unmapped_bytes = 0
        for language, byte_count in language_bytes.items():
            if isinstance(byte_count, bool) or not isinstance(byte_count, int) or byte_count < 0:
                raise ValueError(f"Invalid byte count for {language!r}")
            ecosystem = self.ecosystem_for_language(language)
            if ecosystem is None:
                unmapped_bytes += byte_count
            else:
                ecosystem_bytes[ecosystem] = ecosystem_bytes.get(ecosystem, 0) + byte_count
        return dict(sorted(ecosystem_bytes.items())), unmapped_bytes


_ECOSYSTEMS_V1 = frozenset({
    "python", "web", "rust", "go", "jvm", "native", "dotnet", "ruby",
    "php", "apple", "dart", "beam", "vim", "tcl",
})

# Exact GitHub/Linguist labels are normalized with casefold() at lookup time.
# Vim and Tcl are named specialist ecosystems; neither is silently folded into
# the old frontend's "frontier" group. No map geography is implied by this file.
_LANGUAGE_TO_ECOSYSTEM_V1 = MappingProxyType({
    "python": "python",
    "cython": "python",
    "javascript": "web",
    "typescript": "web",
    "html": "web",
    "css": "web",
    "scss": "web",
    "sass": "web",
    "less": "web",
    "vue": "web",
    "svelte": "web",
    "astro": "web",
    "rust": "rust",
    "go": "go",
    "java": "jvm",
    "kotlin": "jvm",
    "scala": "jvm",
    "groovy": "jvm",
    "clojure": "jvm",
    "c": "native",
    "c++": "native",
    "assembly": "native",
    "cuda": "native",
    "c#": "dotnet",
    "f#": "dotnet",
    "visual basic .net": "dotnet",
    "ruby": "ruby",
    "php": "php",
    "hack": "php",
    "swift": "apple",
    "objective-c": "apple",
    "objective-c++": "apple",
    "dart": "dart",
    "erlang": "beam",
    "elixir": "beam",
    "gleam": "beam",
    "vim script": "vim",
    "viml": "vim",
    "tcl": "tcl",
})

TAXONOMY_V1 = WorldTaxonomy(
    version="wi1a.1",
    ecosystems=_ECOSYSTEMS_V1,
    language_to_ecosystem=_LANGUAGE_TO_ECOSYSTEM_V1,
    cross_cutting_tags=frozenset({"mobile", "scientific"}),
)

TAXONOMIES: Mapping[str, WorldTaxonomy] = MappingProxyType({TAXONOMY_V1.version: TAXONOMY_V1})
CURRENT_TAXONOMY_VERSION = TAXONOMY_V1.version


def get_world_taxonomy(version: str) -> WorldTaxonomy:
    """Return a historical mapping by its persisted version."""
    return TAXONOMIES[version]
