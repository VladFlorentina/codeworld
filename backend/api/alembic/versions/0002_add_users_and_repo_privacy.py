"""add users and repo privacy

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-21

Creates the users table for GitHub App authenticated users and
adds is_private column to the repositories table.
"""
from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

# revision identifiers, used by Alembic
revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # ── users ───────────────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("github_user_id", sa.BigInteger(), nullable=False),
        sa.Column("github_login", sa.String(255), nullable=False),
        sa.Column("avatar_url", sa.String(1024), nullable=True),
        sa.Column("encrypted_user_access_token", sa.Text(), nullable=False),
        sa.Column("encrypted_refresh_token", sa.Text(), nullable=True),
        sa.Column("user_token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("refresh_token_expires_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.UniqueConstraint("github_user_id", name="uq_users_github_user_id"),
    )
    op.create_index("ix_users_github_user_id", "users", ["github_user_id"])
    op.create_index("ix_users_github_login", "users", ["github_login"])

    # ── repositories.is_private ──────────────────────────────────
    op.add_column(
        "repositories",
        sa.Column("is_private", sa.Boolean(), server_default=sa.false(), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("repositories", "is_private")
    op.drop_index("ix_users_github_login", table_name="users")
    op.drop_index("ix_users_github_user_id", table_name="users")
    op.drop_table("users")
