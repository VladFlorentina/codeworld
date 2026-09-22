"""add github_repository_id to repositories

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-22

Adds github_repository_id (BIGINT NULL UNIQUE) to repositories table
for stable GitHub identity and authorization.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic
revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.add_column(
        "repositories",
        sa.Column("github_repository_id", sa.BigInteger(), nullable=True),
    )
    op.create_unique_constraint(
        "uq_repositories_github_repository_id",
        "repositories",
        ["github_repository_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_repositories_github_repository_id",
        "repositories",
        type_="unique",
    )
    op.drop_column("repositories", "github_repository_id")
