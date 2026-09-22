from __future__ import annotations

import enum


class RepositoryStatus(str, enum.Enum):
    pending = "pending"
    analyzing = "analyzing"
    ready = "ready"
    failed = "failed"


class SyncType(str, enum.Enum):
    public = "public"   # Discovered via GitHub API — periodic sync
    live = "live"       # Connected via GitHub App — near-real-time webhooks


class AnalysisRunStatus(str, enum.Enum):
    queued = "queued"
    running = "running"
    complete = "complete"
    failed = "failed"


class EdgeType(str, enum.Enum):
    import_ = "import"      # import from another file in the same repo
    package = "package"     # import from an external package
