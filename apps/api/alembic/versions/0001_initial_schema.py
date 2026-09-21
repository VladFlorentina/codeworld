"""initial schema

Revision ID: 0001
Revises: 
Create Date: 2026-09-21

Creates the initial CodeWorld schema:
  - repositories
  - analysis_runs
  - file_records
  - dependency_edges
  - cities
  - districts
  - buildings
  - connections
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

# revision identifiers, used by Alembic
revision: str = "0001"
down_revision: str | None = None
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # ── Enums ────────────────────────────────────────────────
    repository_status = postgresql.ENUM(
        "pending", "analyzing", "ready", "failed",
        name="repositorystatus", create_type=True
    )
    sync_type = postgresql.ENUM(
        "public", "live",
        name="synctype", create_type=True
    )
    analysis_run_status = postgresql.ENUM(
        "queued", "running", "complete", "failed",
        name="analysisrunstatus", create_type=True
    )
    edge_type = postgresql.ENUM(
        "import", "package",
        name="edgetype", create_type=True
    )

    # ── repositories ─────────────────────────────────────────
    op.create_table(
        "repositories",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("github_owner", sa.String(255), nullable=False),
        sa.Column("github_name", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(512), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("default_branch", sa.String(255), server_default="main"),
        sa.Column("clone_url", sa.String(1024), nullable=False),
        sa.Column("status", repository_status, nullable=False, server_default="pending"),
        sa.Column("sync_type", sync_type, nullable=False, server_default="public"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint("github_owner", "github_name", name="uq_repository_full_name"),
    )
    op.create_index("ix_repositories_full_name", "repositories", ["full_name"])

    # ── analysis_runs ─────────────────────────────────────────
    op.create_table(
        "analysis_runs",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "repository_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("repositories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("commit_sha", sa.String(40)),
        sa.Column("status", analysis_run_status, nullable=False, server_default="queued"),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("error_message", sa.Text()),
        sa.Column("analysis_meta", postgresql.JSONB()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_analysis_runs_repository_id", "analysis_runs", ["repository_id"])

    # ── file_records ──────────────────────────────────────────
    op.create_table(
        "file_records",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "run_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("analysis_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("path", sa.String(2048), nullable=False),
        sa.Column("language", sa.String(64)),
        sa.Column("loc", sa.Integer(), server_default="0"),
        sa.Column("complexity", sa.Integer(), server_default="0"),
        sa.Column("function_count", sa.Integer(), server_default="0"),
        sa.Column("class_count", sa.Integer(), server_default="0"),
        sa.Column("import_count", sa.Integer(), server_default="0"),
        sa.Column("metrics", postgresql.JSONB()),
    )
    op.create_index("ix_file_records_run_id", "file_records", ["run_id"])

    # ── dependency_edges ──────────────────────────────────────
    op.create_table(
        "dependency_edges",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "run_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("analysis_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_file", sa.String(2048), nullable=False),
        sa.Column("target_file", sa.String(2048), nullable=False),
        sa.Column("edge_type", edge_type, nullable=False),
    )
    op.create_index("ix_dependency_edges_run_id", "dependency_edges", ["run_id"])

    # ── cities ────────────────────────────────────────────────
    op.create_table(
        "cities",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "run_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("analysis_runs.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "repository_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("repositories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "generated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    # ── districts ─────────────────────────────────────────────
    op.create_table(
        "districts",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "city_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("cities.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "parent_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("districts.id", ondelete="CASCADE"),
        ),
        sa.Column("path", sa.String(2048), nullable=False),
        sa.Column("name", sa.String(512), nullable=False),
        sa.Column("depth", sa.Integer(), server_default="0"),
    )
    op.create_index("ix_districts_city_id", "districts", ["city_id"])

    # ── buildings ─────────────────────────────────────────────
    op.create_table(
        "buildings",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "city_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("cities.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "district_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("districts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "file_record_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("file_records.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(512), nullable=False),
        sa.Column("path", sa.String(2048), nullable=False),
        sa.Column("height", sa.Float(), server_default="1.0"),
        sa.Column("width", sa.Float(), server_default="1.0"),
        sa.Column("depth", sa.Float(), server_default="1.0"),
        sa.Column("color_hex", sa.String(7), server_default="#888888"),
        sa.Column("position_x", sa.Float(), server_default="0.0"),
        sa.Column("position_z", sa.Float(), server_default="0.0"),
    )
    op.create_index("ix_buildings_city_id", "buildings", ["city_id"])
    op.create_index("ix_buildings_district_id", "buildings", ["district_id"])

    # ── connections ───────────────────────────────────────────
    op.create_table(
        "connections",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "city_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("cities.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "source_building_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("buildings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "target_building_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("buildings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("connection_type", sa.String(32), server_default="import"),
    )
    op.create_index("ix_connections_city_id", "connections", ["city_id"])


def downgrade() -> None:
    """Drop all tables and enums in reverse dependency order."""
    op.drop_table("connections")
    op.drop_table("buildings")
    op.drop_table("districts")
    op.drop_table("cities")
    op.drop_table("dependency_edges")
    op.drop_table("file_records")
    op.drop_table("analysis_runs")
    op.drop_table("repositories")

    # Drop enums
    for enum_name in ("edgetype", "analysisrunstatus", "synctype", "repositorystatus"):
        op.execute(f"DROP TYPE IF EXISTS {enum_name}")
