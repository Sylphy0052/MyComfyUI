"""Projectの永続化、外部同期、ライフサイクルAPI。"""

import asyncio
import hashlib
import json
import logging
from typing import Annotated, Any, Awaitable, Callable
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import schemas, storage
from mycomfyui_api.adapters.aimedia.client import (
    AiMediaNotFound,
    AiMediaUnavailable,
    ReferenceSource,
)
from mycomfyui_api.db import get_session
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import (
    Artifact,
    GenerationJob,
    Project,
    Recipe,
    WorkflowVersion,
)

router = APIRouter(prefix="/api/v1/projects", tags=["projects"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]
logger = logging.getLogger(__name__)

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
        generation_defaults=schemas.ProjectGenerationDefaults.model_validate(
            project.generation_defaults or {}
        ),
        source_type=project.source_type,
        source=schemas.ProjectSource(source_locator=locator, revision=revision),
        external_id=project.external_id,
        source_snapshot_sha256=project.source_snapshot_sha256,
        sync_state=project.sync_state,
        auto_sync=project.auto_sync,
        last_synced_at=project.last_synced_at,
        sync_error=project.sync_error,
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
        generation_defaults=schemas.ProjectGenerationDefaults().model_dump(),
        local_overrides=schemas.ProjectLocalOverrides().model_dump(),
        source_type="local",
        source_locator=None,
        source_revision=None,
        external_id=None,
        source_snapshot={},
        source_snapshot_sha256=None,
        sync_state="never",
        auto_sync=False,
        last_synced_at=None,
        sync_error=None,
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


def _reference_source(request: Request) -> ReferenceSource:
    return request.app.state.reference_source


def _items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    items = payload.get("items")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


async def _source_call(
    call: Callable[[], Awaitable[dict[str, Any]]],
) -> dict[str, Any]:
    try:
        return await call()
    except AiMediaNotFound as error:
        raise ApiError(
            "EXTERNAL_PROJECT_NOT_FOUND",
            str(error),
            status_code=status.HTTP_404_NOT_FOUND,
        ) from error
    except AiMediaUnavailable as error:
        raise ApiError(
            "EXTERNAL_PROJECT_UNAVAILABLE",
            "外部Projectへ接続できませんでした。",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error


async def _fetch_snapshot(
    source: ReferenceSource, external_id: str
) -> dict[str, Any]:
    project = await _source_call(lambda: source.get_project(external_id))
    scene_list = await _source_call(lambda: source.list_scenes(external_id))
    scene_envelopes: dict[str, dict[str, Any]] = {}
    shot_lists: dict[str, dict[str, Any]] = {}
    shot_envelopes: dict[str, dict[str, Any]] = {}
    for scene in _items(scene_list):
        scene_id = scene.get("id")
        if not isinstance(scene_id, str):
            continue
        scene_envelopes[scene_id] = await _source_call(
            lambda scene_id=scene_id: source.get_scene(external_id, scene_id)
        )
        shots = await _source_call(
            lambda scene_id=scene_id: source.list_shots(external_id, scene_id)
        )
        shot_lists[scene_id] = shots
        for shot in _items(shots):
            shot_id = shot.get("id")
            if isinstance(shot_id, str):
                shot_envelopes[shot_id] = await _source_call(
                    lambda scene_id=scene_id, shot_id=shot_id: source.get_shot(
                        external_id, scene_id, shot_id
                    )
                )
    canon = await _source_call(lambda: source.list_canon(external_id))
    return {
        "project": project,
        "scenes": scene_list,
        "scene_envelopes": scene_envelopes,
        "shots": shot_lists,
        "shot_envelopes": shot_envelopes,
        "canon": canon,
    }


def _snapshot_sha256(snapshot: dict[str, Any]) -> str:
    content = json.dumps(
        snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(content).hexdigest()


def _revision(snapshot: dict[str, Any]) -> str:
    project = snapshot.get("project", {})
    source = project.get("source", {}) if isinstance(project, dict) else {}
    revision = source.get("revision") if isinstance(source, dict) else None
    return revision if isinstance(revision, str) and revision else "unknown"


def _resource_map(snapshot: dict[str, Any]) -> dict[str, Any]:
    resources: dict[str, Any] = {}
    project = snapshot.get("project")
    if isinstance(project, dict):
        resources["project"] = project
    scenes = snapshot.get("scene_envelopes")
    if isinstance(scenes, dict):
        resources.update({f"scenes/{key}": value for key, value in scenes.items()})
    shots = snapshot.get("shot_envelopes")
    if isinstance(shots, dict):
        resources.update({f"shots/{key}": value for key, value in shots.items()})
    canon = snapshot.get("canon")
    if isinstance(canon, dict):
        for item in _items(canon):
            key = item.get("canon_id")
            if isinstance(key, str):
                resources[f"canon/{key}"] = item
    return resources


def _sync_changes(
    project: Project, incoming: dict[str, Any]
) -> list[schemas.ProjectSyncChange]:
    previous = _resource_map(project.source_snapshot or {})
    current = _resource_map(incoming)
    changes: list[schemas.ProjectSyncChange] = []
    for path in sorted(previous.keys() | current.keys()):
        before = previous.get(path)
        after = current.get(path)
        if before == after:
            continue
        action = "added" if before is None else "deleted" if after is None else "changed"
        conflict = False
        if path == "project" and isinstance(before, dict) and isinstance(after, dict):
            previous_title = before.get("title")
            incoming_title = after.get("title")
            conflict = (
                isinstance(previous_title, str)
                and project.name != previous_title
                and incoming_title != previous_title
            )
        changes.append(
            schemas.ProjectSyncChange(
                path=path,
                action=action,
                conflict=conflict,
                local_value=before,
                external_value=after,
            )
        )
    return changes


def _preview(project: Project, snapshot: dict[str, Any]) -> schemas.ProjectSyncPreview:
    changes = _sync_changes(project, snapshot)
    return schemas.ProjectSyncPreview(
        project_id=project.id,
        source_revision=_revision(snapshot),
        snapshot_sha256=_snapshot_sha256(snapshot),
        changes=changes,
        has_conflicts=any(change.conflict for change in changes),
    )


async def _mark_sync_failure(
    session: AsyncSession, project: Project, error: ApiError
) -> None:
    project.sync_state = "failed"
    project.sync_error = error.message
    project.updated_at = schemas.now_iso()
    await session.commit()


async def _external_snapshot(
    session: AsyncSession, project: Project, source: ReferenceSource
) -> dict[str, Any]:
    try:
        return await _fetch_snapshot(source, project.external_id or project.id)
    except ApiError as error:
        await _mark_sync_failure(session, project, error)
        raise


@router.get(
    "/external-candidates", response_model=schemas.ExternalProjectCandidateList
)
async def list_external_candidates(request: Request, session: SessionDep):
    source = _reference_source(request)
    payload = await _source_call(source.list_projects)
    imported = {
        external_id: project_id
        for external_id, project_id in (
            await session.execute(
                select(Project.external_id, Project.id).where(
                    Project.source_type == "external"
                )
            )
        ).all()
        if external_id is not None
    }
    candidates: list[schemas.ExternalProjectCandidate] = []
    for item in _items(payload):
        source_info = item.get("source")
        if not isinstance(source_info, dict):
            source_info = {}
        external_id = item.get("id")
        if not isinstance(external_id, str):
            continue
        candidates.append(
            schemas.ExternalProjectCandidate(
                id=external_id,
                title=str(item.get("title") or external_id),
                source_locator=str(source_info.get("source_locator") or "external"),
                revision=str(source_info.get("revision") or "unknown"),
                imported_project_id=imported.get(external_id),
            )
        )
    return schemas.ExternalProjectCandidateList(items=candidates)


@router.post(
    "/import", response_model=schemas.ProjectRead, status_code=status.HTTP_201_CREATED
)
async def import_external_project(
    payload: schemas.ExternalProjectImport, request: Request, session: SessionDep
):
    source = _reference_source(request)
    snapshot = await _fetch_snapshot(source, payload.external_id)
    source_project = snapshot["project"]
    project_id = payload.project_id or payload.external_id
    name = str(source_project.get("title") or payload.external_id)
    repository = ProjectRepository(session)
    await _ensure_unique(repository, project_id=project_id, name=name)
    source_info = source_project.get("source")
    if not isinstance(source_info, dict):
        source_info = {}
    scenes = _items(snapshot["scenes"])
    shot_count = sum(len(_items(item)) for item in snapshot["shots"].values())
    now = schemas.now_iso()
    project = Project(
        id=project_id,
        name=name,
        description=None,
        status="active",
        lifecycle="active",
        tags=[],
        favorite=False,
        thumbnail_artifact_id=None,
        generation_defaults=schemas.ProjectGenerationDefaults().model_dump(),
        local_overrides=schemas.ProjectLocalOverrides().model_dump(),
        source_type="external",
        source_locator=str(source_info.get("source_locator") or "external"),
        source_revision=_revision(snapshot),
        external_id=payload.external_id,
        source_snapshot=snapshot,
        source_snapshot_sha256=_snapshot_sha256(snapshot),
        sync_state="synced",
        auto_sync=payload.auto_sync,
        last_synced_at=now,
        sync_error=None,
        scene_count=len(scenes),
        shot_count=shot_count,
        canon_count=len(_items(snapshot["canon"])),
        created_at=now,
        updated_at=now,
        last_used_at=None,
        archived_at=None,
        deleted_at=None,
    )
    session.add(project)
    await _commit(session)
    return _read(project)


@router.post("/{project_id}/sync/preview", response_model=schemas.ProjectSyncPreview)
async def preview_external_sync(
    project_id: schemas.AiMediaId, request: Request, session: SessionDep
):
    project = await _require_project(session, project_id)
    if project.source_type != "external":
        raise ApiError(
            "PROJECT_HAS_NO_EXTERNAL_SOURCE",
            "ローカルProjectは同期できません。",
            status_code=status.HTTP_409_CONFLICT,
        )
    snapshot = await _external_snapshot(session, project, _reference_source(request))
    preview = _preview(project, snapshot)
    project.sync_state = "conflicted" if preview.has_conflicts else (
        "outdated" if preview.changes else "synced"
    )
    project.sync_error = None
    await _commit(session)
    return preview


@router.post("/{project_id}/sync", response_model=schemas.ProjectRead)
async def sync_external_project(
    project_id: schemas.AiMediaId,
    payload: schemas.ProjectSyncApply,
    request: Request,
    session: SessionDep,
):
    project = await _require_project(session, project_id)
    if project.source_type != "external":
        raise ApiError(
            "PROJECT_HAS_NO_EXTERNAL_SOURCE",
            "ローカルProjectは同期できません。",
            status_code=status.HTTP_409_CONFLICT,
        )
    snapshot = await _external_snapshot(session, project, _reference_source(request))
    preview = _preview(project, snapshot)
    resolutions = {item.path: item.choice for item in payload.resolutions}
    unresolved = [
        item.path for item in preview.changes if item.conflict and item.path not in resolutions
    ]
    if unresolved:
        project.sync_state = "conflicted"
        project.sync_error = "ローカル変更と外部変更が競合しています。"
        await _commit(session)
        raise ApiError(
            "PROJECT_SYNC_CONFLICT",
            project.sync_error,
            status_code=status.HTTP_409_CONFLICT,
            details={"paths": unresolved},
        )
    source_project = snapshot["project"]
    if resolutions.get("project") == "external":
        incoming_name = str(source_project.get("title") or project.name)
        await _ensure_unique(
            ProjectRepository(session),
            project_id=project.id,
            name=incoming_name,
            current_id=project.id,
        )
        project.name = incoming_name
    source_info = source_project.get("source")
    if not isinstance(source_info, dict):
        source_info = {}
    now = schemas.now_iso()
    project.source_locator = str(source_info.get("source_locator") or project.source_locator)
    project.source_revision = _revision(snapshot)
    project.source_snapshot = snapshot
    project.source_snapshot_sha256 = preview.snapshot_sha256
    project.sync_state = "synced"
    project.sync_error = None
    project.last_synced_at = now
    project.updated_at = now
    project.scene_count = len(_items(snapshot["scenes"]))
    project.shot_count = sum(len(_items(item)) for item in snapshot["shots"].values())
    project.canon_count = len(_items(snapshot["canon"]))
    await _commit(session)
    return _read(project)


@router.patch("/{project_id}/sync-settings", response_model=schemas.ProjectRead)
async def update_sync_settings(
    project_id: schemas.AiMediaId,
    payload: schemas.ProjectSyncSettings,
    session: SessionDep,
):
    project = await _require_project(session, project_id)
    if project.source_type != "external":
        raise ApiError(
            "PROJECT_HAS_NO_EXTERNAL_SOURCE",
            "ローカルProjectには同期設定がありません。",
            status_code=status.HTTP_409_CONFLICT,
        )
    project.auto_sync = payload.auto_sync
    project.updated_at = schemas.now_iso()
    await _commit(session)
    return _read(project)


@router.get(
    "/{project_id}/local-overrides", response_model=schemas.ProjectLocalOverrides
)
async def get_local_overrides(project_id: schemas.AiMediaId, session: SessionDep):
    project = await _require_project(session, project_id)
    return schemas.ProjectLocalOverrides.model_validate(project.local_overrides or {})


@router.put(
    "/{project_id}/local-overrides", response_model=schemas.ProjectLocalOverrides
)
async def update_local_overrides(
    project_id: schemas.AiMediaId,
    payload: schemas.ProjectLocalOverrides,
    session: SessionDep,
):
    project = await _require_project(session, project_id)
    if project.lifecycle != "active":
        raise ApiError(
            "PROJECT_NOT_ACTIVE",
            "ローカル設定を変更するにはProjectを復元してください。",
            status_code=status.HTTP_409_CONFLICT,
            details={"project_id": project_id, "lifecycle": project.lifecycle},
        )
    await asyncio.to_thread(_validate_local_reference_images, payload)
    payload = _stamp_character_updates(
        schemas.ProjectLocalOverrides.model_validate(project.local_overrides or {}),
        payload,
    )
    project.local_overrides = payload.model_dump(mode="json")
    project.updated_at = schemas.now_iso()
    await _commit(session)
    return payload


def _stamp_character_updates(
    current: schemas.ProjectLocalOverrides, payload: schemas.ProjectLocalOverrides
) -> schemas.ProjectLocalOverrides:
    """定義が変わったキャラクターだけ`updated_at`を今の時刻にし、他は保存済みの値を残す。"""
    previous = {character.id: character for character in current.characters}
    now = schemas.now_iso()
    characters: list[schemas.ProjectCharacterProfile] = []
    for character in payload.characters:
        before = previous.get(character.id)
        unchanged = before is not None and before.model_dump(
            exclude={"updated_at", "reference_sets"}
        ) == character.model_dump(exclude={"updated_at", "reference_sets"})
        characters.append(
            character.model_copy(
                update={"updated_at": before.updated_at if unchanged else now}
            )
        )
    return payload.model_copy(update={"characters": characters})


def _validate_local_reference_images(payload: schemas.ProjectLocalOverrides) -> None:
    verified: dict[str, tuple[int, str, str | None]] = {}
    for character in payload.characters:
        references = list(character.reference_images)
        references.extend(
            outfit.image for outfit in character.outfits if outfit.image is not None
        )
        for reference_set in character.reference_sets:
            references.extend(
                slot.image
                for slot in reference_set.slots.values()
                if slot.image is not None
            )
        for reference in references:
            actual = verified.get(reference.relative_path)
            if actual is None:
                try:
                    path = storage.resolve_input(reference.relative_path)
                    byte_size = path.stat().st_size
                    digest = hashlib.sha256()
                    with path.open("rb") as stream:
                        header = stream.read(32)
                        digest.update(header)
                        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                            digest.update(chunk)
                except (OSError, storage.StorageError) as error:
                    raise ApiError(
                        "PROJECT_REFERENCE_IMAGE_INVALID",
                        "登録する参照画像を入力cacheから確認できません。",
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        details={"relative_path": reference.relative_path},
                    ) from error
                actual = (
                    byte_size,
                    digest.hexdigest(),
                    storage.detect_image_media_type(header),
                )
                verified[reference.relative_path] = actual
            if actual[:2] != (reference.byte_size, reference.sha256):
                raise ApiError(
                    "PROJECT_REFERENCE_IMAGE_MISMATCH",
                    "参照画像のサイズまたはSHA-256が入力cacheと一致しません。",
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    details={"relative_path": reference.relative_path},
                )
            if actual[2] != reference.media_type:
                raise ApiError(
                    "PROJECT_REFERENCE_IMAGE_MEDIA_TYPE_MISMATCH",
                    "参照画像の実形式とmedia_typeが一致しません。",
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    details={
                        "relative_path": reference.relative_path,
                        "declared": reference.media_type,
                        "detected": actual[2],
                    },
                )


@router.get("/{project_id}", response_model=schemas.ProjectRead)
async def get_project(project_id: schemas.AiMediaId, session: SessionDep):
    return _read(await _require_project(session, project_id))


async def _generation_default_warnings(
    session: AsyncSession, defaults: schemas.ProjectGenerationDefaults
) -> list[schemas.ProjectGenerationDefaultWarning]:
    warnings: list[schemas.ProjectGenerationDefaultWarning] = []
    for kind in ("image", "video", "music", "voice", "compose"):
        profile = getattr(defaults, kind)
        if profile.recipe_id is None:
            continue
        recipe = await session.get(Recipe, profile.recipe_id)
        if recipe is None:
            warnings.append(
                schemas.ProjectGenerationDefaultWarning(
                    kind=kind,
                    code="RECIPE_NOT_FOUND",
                    message="設定されたRecipeがありません。",
                    field="recipe_id",
                )
            )
            continue
        if recipe.kind != kind:
            warnings.append(
                schemas.ProjectGenerationDefaultWarning(
                    kind=kind,
                    code="RECIPE_KIND_MISMATCH",
                    message=f"{kind}用ではないRecipeが設定されています。",
                    field="recipe_id",
                )
            )
        if recipe.workflow_version_id is not None and await session.get(
            WorkflowVersion, recipe.workflow_version_id
        ) is None:
            warnings.append(
                schemas.ProjectGenerationDefaultWarning(
                    kind=kind,
                    code="WORKFLOW_NOT_FOUND",
                    message="Recipeが参照するWorkflow版がありません。",
                    field="recipe_id",
                )
            )
        schema = recipe.input_schema if isinstance(recipe.input_schema, dict) else {}
        nested = schema.get("properties")
        properties = nested if isinstance(nested, dict) else schema
        for name, value in profile.inputs.items():
            definition = properties.get(name)
            if not isinstance(definition, dict):
                warnings.append(
                    schemas.ProjectGenerationDefaultWarning(
                        kind=kind,
                        code="INPUT_NOT_SUPPORTED",
                        message=f"Recipeが入力{name}を受け付けません。",
                        field=name,
                    )
                )
                continue
            choices = definition.get("enum")
            if isinstance(choices, list) and value not in choices:
                warnings.append(
                    schemas.ProjectGenerationDefaultWarning(
                        kind=kind,
                        code="INPUT_VALUE_UNAVAILABLE",
                        message=f"入力{name}の値を現在のRecipeで利用できません。",
                        field=name,
                    )
                )
    return warnings


@router.get(
    "/{project_id}/generation-defaults",
    response_model=schemas.ProjectGenerationDefaultsRead,
)
async def get_generation_defaults(
    project_id: schemas.AiMediaId, session: SessionDep
):
    project = await _require_project(session, project_id)
    defaults = schemas.ProjectGenerationDefaults.model_validate(
        project.generation_defaults or {}
    )
    return schemas.ProjectGenerationDefaultsRead(
        defaults=defaults,
        warnings=await _generation_default_warnings(session, defaults),
    )


@router.put(
    "/{project_id}/generation-defaults",
    response_model=schemas.ProjectGenerationDefaultsRead,
)
async def update_generation_defaults(
    project_id: schemas.AiMediaId,
    payload: schemas.ProjectGenerationDefaults,
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
    project.generation_defaults = payload.model_dump(mode="json")
    project.updated_at = schemas.now_iso()
    await _commit(session)
    return schemas.ProjectGenerationDefaultsRead(
        defaults=payload,
        warnings=await _generation_default_warnings(session, payload),
    )


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
