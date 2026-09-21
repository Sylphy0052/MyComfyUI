"""Projectの永続化とライフサイクルAPI。"""

from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import schemas
from mycomfyui_api.db import get_session
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import Artifact, GenerationJob, Project

router = APIRouter(prefix="/api/v1/projects", tags=["projects"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]

STATUS_TRANSITIONS: dict[str, frozenset[str]] = {
    "planning": frozenset({"active", "on_hold"}),
    "active": frozenset({"on_hold", "completed"}),
    "on_hold": frozenset({"active", "completed"}),
    "completed": frozenset({"active"}),
}
ACTIVE_JOB_STATES = ("queued", "running", "cancelling")


class ProjectRepository:
    """Project表への読取りを集約する。"""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, project_id: str) -> Project | None:
        return await self.session.get(Project, project_id)

    async def find_by_name(self, name: str) -> Project | None:
        return await self.session.scalar(
            select(Project).where(func.lower(Project.name) == name.lower())
        )

    async def list(
        self,
        *,
        lifecycle: str,
        query: str | None,
        source_type: str | None,
        favorite_only: bool,
        sort: str,
        limit: int,
        offset: int,
    ) -> list[Project]:
        statement = select(Project).where(Project.lifecycle == lifecycle)
        if query:
            needle = query.strip().lower()
            statement = statement.where(
                or_(
                    func.lower(Project.name).contains(needle),
                    func.lower(func.coalesce(Project.description, "")).contains(needle),
                )
            )
        if source_type:
            statement = statement.where(Project.source_type == source_type)
        if favorite_only:
            statement = statement.where(Project.favorite.is_(True))
        sort_columns = {
            "name": (Project.name.asc(),),
            "created": (Project.created_at.desc(),),
            "updated": (Project.updated_at.desc(),),
            "last_used": (Project.last_used_at.desc(), Project.updated_at.desc()),
        }
        statement = statement.order_by(
            Project.favorite.desc(), *sort_columns[sort], Project.id.asc()
        )
        result = await self.session.scalars(statement.limit(limit).offset(offset))
        return list(result)


def _not_found(project_id: str) -> ApiError:
    return ApiError(
        "PROJECT_NOT_FOUND",
        "Projectがありません。",
        status_code=status.HTTP_404_NOT_FOUND,
        details={"project_id": project_id},
    )


async def _require_project(session: AsyncSession, project_id: str) -> Project:
    project = await ProjectRepository(session).get(project_id)
    if project is None:
        raise _not_found(project_id)
    return project


def _read(project: Project) -> schemas.ProjectRead:
    locator = project.source_locator or f"mycomfyui://projects/{project.id}"
    revision = project.source_revision or project.updated_at
    return schemas.ProjectRead(
        id=project.id,
        name=project.name,
        title=project.name,
        description=project.description,
        status=project.status,
        lifecycle=project.lifecycle,
        tags=list(project.tags or []),
        favorite=project.favorite,
        thumbnail_artifact_id=project.thumbnail_artifact_id,
        source_type=project.source_type,
        source=schemas.ProjectSource(source_locator=locator, revision=revision),
        external_id=project.external_id,
        scene_count=project.scene_count,
        shot_count=project.shot_count,
        canon_count=project.canon_count,
        created_at=project.created_at,
        updated_at=project.updated_at,
        last_used_at=project.last_used_at,
        archived_at=project.archived_at,
        deleted_at=project.deleted_at,
    )


async def _ensure_unique(
    repository: ProjectRepository,
    *,
    project_id: str,
    name: str,
    current_id: str | None = None,
) -> None:
    existing_id = await repository.get(project_id)
    if existing_id is not None and existing_id.id != current_id:
        raise ApiError(
            "PROJECT_ID_EXISTS",
            "同じProject IDが既に存在します。",
            status_code=status.HTTP_409_CONFLICT,
            details={"project_id": project_id},
        )
    existing_name = await repository.find_by_name(name)
    if existing_name is not None and existing_name.id != current_id:
        raise ApiError(
            "PROJECT_NAME_EXISTS",
            "同じProject名が既に存在します。",
            status_code=status.HTTP_409_CONFLICT,
            details={"name": name, "project_id": existing_name.id},
        )


async def _ensure_thumbnail(session: AsyncSession, artifact_id: str | None) -> None:
    if artifact_id is not None and await session.get(Artifact, artifact_id) is None:
        raise ApiError(
            "THUMBNAIL_ARTIFACT_NOT_FOUND",
            "サムネイルに指定したArtifactがありません。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"artifact_id": artifact_id},
        )


async def _commit(session: AsyncSession) -> None:
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise ApiError(
            "PROJECT_CONFLICT",
            "ProjectのIDまたは名前が既存Projectと重複しました。",
            status_code=status.HTTP_409_CONFLICT,
        ) from error


async def _impact(
    session: AsyncSession, project: Project
) -> schemas.ProjectDeletionImpact:
    project_jobs = GenerationJob.assigned_project_id == project.id
    job_count = int(
        await session.scalar(
            select(func.count()).select_from(GenerationJob).where(project_jobs)
        )
        or 0
    )
    active_job_count = int(
        await session.scalar(
            select(func.count())
            .select_from(GenerationJob)
            .where(project_jobs, GenerationJob.state.in_(ACTIVE_JOB_STATES))
        )
        or 0
    )
    artifact_count = int(
        await session.scalar(
            select(func.count())
            .select_from(Artifact)
            .where(Artifact.assigned_project_id == project.id)
        )
        or 0
    )
    blockers = (
        ["実行中または待機中のJobがあるため、ライフサイクルを変更できません。"]
        if active_job_count
        else []
    )
    related = job_count + artifact_count + project.scene_count + project.shot_count
    return schemas.ProjectDeletionImpact(
        project_id=project.id,
        job_count=job_count,
        artifact_count=artifact_count,
        active_job_count=active_job_count,
        scene_count=project.scene_count,
        shot_count=project.shot_count,
        requires_confirmation=related > 0,
        blockers=blockers,
    )


def _ensure_lifecycle(project: Project, expected: str, action: str) -> None:
    if project.lifecycle != expected:
        raise ApiError(
            "INVALID_PROJECT_TRANSITION",
            f"{project.lifecycle}のProjectは{action}できません。",
            status_code=status.HTTP_409_CONFLICT,
            details={"project_id": project.id, "lifecycle": project.lifecycle},
        )


@router.post("", response_model=schemas.ProjectRead, status_code=status.HTTP_201_CREATED)
async def create_project(payload: schemas.ProjectCreate, session: SessionDep):
    repository = ProjectRepository(session)
    project_id = payload.id or str(uuid4())
    await _ensure_unique(repository, project_id=project_id, name=payload.name)
    await _ensure_thumbnail(session, payload.thumbnail_artifact_id)
    now = schemas.now_iso()
    project = Project(
        id=project_id,
        name=payload.name,
        description=payload.description,
        status=payload.status,
        lifecycle="active",
        tags=list(payload.tags),
        favorite=payload.favorite,
        thumbnail_artifact_id=payload.thumbnail_artifact_id,
        source_type="local",
        source_locator=None,
        source_revision=None,
        external_id=None,
        scene_count=0,
        shot_count=0,
        canon_count=0,
        created_at=now,
        updated_at=now,
        last_used_at=None,
        archived_at=None,
        deleted_at=None,
    )
    session.add(project)
    await _commit(session)
    return _read(project)


@router.get("", response_model=schemas.ProjectList)
async def list_projects(
    session: SessionDep,
    lifecycle: schemas.ProjectLifecycle = "active",
    q: Annotated[str | None, Query(max_length=200)] = None,
    source_type: schemas.ProjectSourceType | None = None,
    favorite_only: bool = False,
    sort: schemas.ProjectSort = "last_used",
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    projects = await ProjectRepository(session).list(
        lifecycle=lifecycle,
        query=q,
        source_type=source_type,
        favorite_only=favorite_only,
        sort=sort,
        limit=limit,
        offset=offset,
    )
    return schemas.ProjectList(items=[_read(project) for project in projects])


@router.get("/{project_id}", response_model=schemas.ProjectRead)
async def get_project(project_id: schemas.AiMediaId, session: SessionDep):
    return _read(await _require_project(session, project_id))


@router.patch("/{project_id}", response_model=schemas.ProjectRead)
async def update_project(
    project_id: schemas.AiMediaId,
    payload: schemas.ProjectUpdate,
    session: SessionDep,
):
    project = await _require_project(session, project_id)
    if project.lifecycle == "trashed":
        raise ApiError(
            "PROJECT_TRASHED",
            "ゴミ箱のProjectは復元してから更新してください。",
            status_code=status.HTTP_409_CONFLICT,
            details={"project_id": project_id},
        )
    fields = payload.model_fields_set
    if "name" in fields:
        if payload.name is None:
            raise ApiError(
                "PROJECT_NAME_REQUIRED",
                "Project名をnullにできません。",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        await _ensure_unique(
            ProjectRepository(session),
            project_id=project.id,
            name=payload.name,
            current_id=project.id,
        )
        project.name = payload.name
    if "description" in fields:
        project.description = payload.description
    if "tags" in fields:
        if payload.tags is None:
            raise ApiError(
                "PROJECT_TAGS_REQUIRED",
                "tagsをnullにできません。",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        project.tags = list(payload.tags)
    if "favorite" in fields:
        if payload.favorite is None:
            raise ApiError(
                "PROJECT_FAVORITE_REQUIRED",
                "favoriteをnullにできません。",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        project.favorite = payload.favorite
    if "thumbnail_artifact_id" in fields:
        await _ensure_thumbnail(session, payload.thumbnail_artifact_id)
        project.thumbnail_artifact_id = payload.thumbnail_artifact_id
    if "status" in fields:
        if payload.status is None:
            raise ApiError(
                "PROJECT_STATUS_REQUIRED",
                "Project状態をnullにできません。",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if payload.status != project.status and payload.status not in STATUS_TRANSITIONS[
            project.status
        ]:
            raise ApiError(
                "INVALID_PROJECT_STATUS_TRANSITION",
                f"Project状態を{project.status}から{payload.status}へ変更できません。",
                status_code=status.HTTP_409_CONFLICT,
                details={"from": project.status, "to": payload.status},
            )
        if payload.status != project.status:
            project.status = payload.status
    project.updated_at = schemas.now_iso()
    await _commit(session)
    return _read(project)


@router.get(
    "/{project_id}/deletion-impact", response_model=schemas.ProjectDeletionImpact
)
async def get_deletion_impact(project_id: schemas.AiMediaId, session: SessionDep):
    return await _impact(session, await _require_project(session, project_id))


@router.post("/{project_id}/archive", response_model=schemas.ProjectRead)
async def archive_project(project_id: schemas.AiMediaId, session: SessionDep):
    project = await _require_project(session, project_id)
    _ensure_lifecycle(project, "active", "アーカイブ")
    impact = await _impact(session, project)
    if impact.blockers:
        raise ApiError(
            "PROJECT_HAS_ACTIVE_JOBS",
            impact.blockers[0],
            status_code=status.HTTP_409_CONFLICT,
            details=impact.model_dump(),
        )
    now = schemas.now_iso()
    project.lifecycle = "archived"
    project.archived_at = now
    project.updated_at = now
    await _commit(session)
    return _read(project)


@router.post("/{project_id}/restore", response_model=schemas.ProjectRead)
async def restore_project(project_id: schemas.AiMediaId, session: SessionDep):
    project = await _require_project(session, project_id)
    if project.lifecycle not in ("archived", "trashed"):
        raise ApiError(
            "INVALID_PROJECT_TRANSITION",
            "activeのProjectは復元できません。",
            status_code=status.HTTP_409_CONFLICT,
            details={"project_id": project.id, "lifecycle": project.lifecycle},
        )
    project.lifecycle = "active"
    project.archived_at = None
    project.deleted_at = None
    project.updated_at = schemas.now_iso()
    await _commit(session)
    return _read(project)


@router.post("/{project_id}/touch", response_model=schemas.ProjectRead)
async def touch_project(project_id: schemas.AiMediaId, session: SessionDep):
    project = await _require_project(session, project_id)
    _ensure_lifecycle(project, "active", "使用")
    now = schemas.now_iso()
    project.last_used_at = now
    project.updated_at = now
    await _commit(session)
    return _read(project)


@router.delete("/{project_id}", response_model=schemas.ProjectRead)
async def trash_project(
    project_id: schemas.AiMediaId,
    session: SessionDep,
    confirm: bool = False,
):
    project = await _require_project(session, project_id)
    if project.lifecycle == "trashed":
        raise ApiError(
            "INVALID_PROJECT_TRANSITION",
            "Projectは既にゴミ箱にあります。",
            status_code=status.HTTP_409_CONFLICT,
            details={"project_id": project.id},
        )
    impact = await _impact(session, project)
    if impact.blockers:
        raise ApiError(
            "PROJECT_HAS_ACTIVE_JOBS",
            impact.blockers[0],
            status_code=status.HTTP_409_CONFLICT,
            details=impact.model_dump(),
        )
    if impact.requires_confirmation and not confirm:
        raise ApiError(
            "PROJECT_DELETE_CONFIRMATION_REQUIRED",
            "関連データを残したままProjectをゴミ箱へ移すには確認が必要です。",
            status_code=status.HTTP_409_CONFLICT,
            details=impact.model_dump(),
        )
    now = schemas.now_iso()
    project.lifecycle = "trashed"
    project.deleted_at = now
    project.updated_at = now
    await _commit(session)
    return _read(project)
