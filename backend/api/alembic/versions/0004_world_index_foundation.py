"""Add the public World Index data foundation.

Revision ID: 0004
Revises: 0003

This revision creates a separate catalog table. It does not alter or backfill
Repository, AnalysisRun, City, or any existing World Map data.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.create_table(
        "world_index_repositories",
        sa.Column("github_repository_id", sa.BigInteger(), primary_key=True),
        sa.Column("github_owner_id", sa.BigInteger(), nullable=False),
        sa.Column("owner_login", sa.String(255), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(512), nullable=False),
        sa.Column("canonical_url", sa.String(1024), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("default_branch", sa.String(255), nullable=True),
        sa.Column("visibility", sa.String(16), nullable=False),
        sa.Column("is_fork", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("is_archived", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("github_created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("github_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("github_pushed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("discovery_source", sa.String(64), nullable=False),
        sa.Column(
            "first_discovered_at", sa.DateTime(timezone=True),
            server_default=sa.text("now()"), nullable=False,
        ),
        sa.Column("last_refreshed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_public_verified_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "language_bytes", postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"), nullable=False,
        ),
        sa.Column("language_observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("observed_head_sha", sa.String(64), nullable=True),
        sa.Column("taxonomy_version", sa.String(32), server_default="wi1a.1", nullable=False),
        sa.Column("classification_version", sa.String(32), nullable=True),
        sa.Column(
            "classification_state", sa.String(16),
            server_default="unclassified", nullable=False,
        ),
        sa.Column("home_ecosystem", sa.String(64), nullable=True),
        sa.Column("confidence", sa.String(16), server_default="unassessed", nullable=False),
        sa.Column("reason_code", sa.String(64), server_default="not_evaluated", nullable=False),
        sa.Column("classification_evidence", postgresql.JSONB(), nullable=True),
        sa.Column("classified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "repository_id", postgresql.UUID(as_uuid=False),
            sa.ForeignKey("repositories.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.CheckConstraint(
            "github_repository_id > 0", name="ck_world_index_github_repository_id_positive"
        ),
        sa.CheckConstraint("github_owner_id > 0", name="ck_world_index_github_owner_id_positive"),
        sa.CheckConstraint("visibility = 'public'", name="ck_world_index_public_only"),
        sa.CheckConstraint("btrim(reason_code) <> ''", name="ck_world_index_reason_present"),
        sa.CheckConstraint(
            "(classification_state = 'home' AND home_ecosystem IS NOT NULL "
            "AND btrim(home_ecosystem) <> '') OR "
            "(classification_state IN ('confluence', 'unclassified') AND home_ecosystem IS NULL)",
            name="ck_world_index_classification_home",
        ),
        sa.CheckConstraint(
            "confidence IN ('unassessed', 'low', 'medium', 'high')",
            name="ck_world_index_confidence",
        ),
        sa.CheckConstraint(
            "jsonb_typeof(language_bytes) = 'object'",
            name="ck_world_index_language_bytes_object",
        ),
        sa.CheckConstraint(
            "classification_evidence IS NULL OR jsonb_typeof(classification_evidence) = 'object'",
            name="ck_world_index_classification_evidence_object",
        ),
        sa.CheckConstraint(
            "classification_state = 'unclassified' OR COALESCE(("
            "classification_version IS NOT NULL AND classified_at IS NOT NULL "
            "AND reason_code <> 'not_evaluated' "
            "AND jsonb_typeof(classification_evidence->'language_bytes_snapshot') = 'object' "
            "AND classification_evidence->'language_bytes_snapshot' <> '{}'::jsonb "
            "AND jsonb_typeof(classification_evidence->'ecosystem_bytes') = 'object' "
            "AND classification_evidence->'ecosystem_bytes' <> '{}'::jsonb "
            "AND btrim(classification_evidence->>'language_observed_at') <> '' "
            "AND jsonb_typeof(classification_evidence->'observed_head_sha') IN ('string', 'null') "
            "AND classification_evidence->>'taxonomy_version' = taxonomy_version "
            "AND classification_evidence->>'classification_version' = classification_version "
            "AND btrim(classification_evidence->>'share_basis') <> '' "
            "AND btrim(classification_evidence->>'decision_method') <> '' "
            "AND btrim(classification_evidence->>'decision_reason') <> '' "
            "AND jsonb_typeof(classification_evidence->'leader'->'ecosystem') = 'string' "
            "AND jsonb_typeof(classification_evidence->'leader'->'share') = 'number' "
            "AND (classification_evidence->'leader'->>'share')::numeric BETWEEN 0 AND 1 "
            "AND (classification_evidence->'ecosystem_bytes' ? "
            "(classification_evidence->'leader'->>'ecosystem')) "
            "AND ("
            "(jsonb_typeof(classification_evidence->'runner_up') = 'null' "
            "AND classification_state = 'home') OR "
            "(jsonb_typeof(classification_evidence->'runner_up'->'ecosystem') = 'string' "
            "AND jsonb_typeof(classification_evidence->'runner_up'->'share') = 'number' "
            "AND (classification_evidence->'runner_up'->>'share')::numeric BETWEEN 0 AND 1 "
            "AND (classification_evidence->'ecosystem_bytes' ? "
            "(classification_evidence->'runner_up'->>'ecosystem')))"
            ")), FALSE)",
            name="ck_world_index_reviewed_evidence",
        ),
        sa.UniqueConstraint("repository_id", name="uq_world_index_repository_id"),
    )
    op.create_index(
        "ix_world_index_owner_repo", "world_index_repositories",
        ["github_owner_id", "github_repository_id"],
    )
    op.create_index(
        "ix_world_index_classification", "world_index_repositories",
        ["classification_state", "home_ecosystem", "github_repository_id"],
    )
    op.create_index(
        "ix_world_index_last_refreshed", "world_index_repositories", ["last_refreshed_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_world_index_last_refreshed", table_name="world_index_repositories")
    op.drop_index("ix_world_index_classification", table_name="world_index_repositories")
    op.drop_index("ix_world_index_owner_repo", table_name="world_index_repositories")
    op.drop_table("world_index_repositories")
