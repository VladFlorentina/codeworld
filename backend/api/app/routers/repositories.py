import logging
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.schemas import SubmitRepositoryRequest, SubmitRepositoryResponse
from app.services.repository_service import (
    authorize_repository_access,
    ensure_repository_analysis,
    get_remote_head_commit,
    parse_github_parts,
)
from codeworld_db import Repository

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/repositories", response_model=SubmitRepositoryResponse)
async def submit_repository(
    body: SubmitRepositoryRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> SubmitRepositoryResponse:
    owner, name, full_name = parse_github_parts(body.url)

    current_head_sha = await get_remote_head_commit(body.url)
    if not current_head_sha:
        raise HTTPException(
            status_code=404,
            detail=f"GitHub repository not found or is inaccessible: {body.url}. Please verify the URL or ensure the repository is public.",
        )

    resp_code, result = await ensure_repository_analysis(
        db=db,
        owner=owner,
        name=name,
        full_name=full_name,
        clone_url=body.url,
        current_head_sha=current_head_sha,
        is_private=False,
    )
    response.status_code = resp_code
    return result


@router.get("/repositories/{repository_id}")
async def get_repository(
    repository_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Repository).where(Repository.id == repository_id)
    res = await db.execute(stmt)
    repo = res.scalar_one_or_none()

    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")

    await authorize_repository_access(repo, request, db)

    return {
        "id": repo.id,
        "owner": repo.github_owner,
        "name": repo.github_name,
        "full_name": repo.full_name,
        "status": repo.status,
        "clone_url": repo.clone_url,
        "created_at": repo.created_at.isoformat() if repo.created_at else None,
        "updated_at": repo.updated_at.isoformat() if repo.updated_at else None,
    }
