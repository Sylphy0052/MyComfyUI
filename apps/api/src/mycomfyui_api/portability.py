"""Projectのテンプレート、複製、可搬package、backup。"""

import base64
import binascii
import hashlib
import json
import shutil
from pathlib import PurePosixPath
from typing import Annotated, Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from fastapi import APIRouter, Depends
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from mycomfyui_api import image_imports, schemas, storage
from mycomfyui_api.adapters.comfyui.client import ComfyUIError
from mycomfyui_api.adapters.comfyui.factory import create_comfyui_client
from mycomfyui_api.db import get_session
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import (
    Artifact,
    ArtifactImport,
    Project,
    ProjectScene,
    ProjectShot,
    ProjectTemplate,
    Recipe,
    WorkflowVersion,
)
from mycomfyui_api.settings import Settings, get_settings

router = APIRouter(prefix="/api/v1/project-portability", tags=["project-portability"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
FORMAT = "mycomfyui.project"
VERSION = 2
SENSITIVE_KEYS = {
    "api_key",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "password",
    "refresh_token",
    "secret",
    "token",
}


def _error(code: str, message: str, *, details: Any = None, http_status: int = 400) -> ApiError:
    return ApiError(code, message, details=details, status_code=http_status)


async def _project(session: AsyncSession, project_id: str) -> Project:
    project = await session.get(Project, project_id)
    if project is None or project.lifecycle == "trashed":
        raise _error("PROJECT_NOT_FOUND", "Projectがありません。", http_status=404)
    return project


def _safe_locator(value: str | None) -> str | None:
    """URLに埋め込まれた認証情報、query、fragmentをpackageへ持ち出さない。"""
    if not value:
        return value
    parsed = urlsplit(value)
    if not parsed.scheme or not parsed.netloc:
        return value
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path, "", ""))


def _without_secrets(value: Any) -> Any:
    """外部認証情報として使われる名前の値を可搬packageから除外する。"""
    if isinstance(value, dict):
        return {
            key: _without_secrets(item)
            for key, item in value.items()
            if key.lower().replace("-", "_") not in SENSITIVE_KEYS
        }
    if isinstance(value, list):
        return [_without_secrets(item) for item in value]
    return value


def _template_read(template: ProjectTemplate) -> schemas.ProjectTemplateRead:
    return schemas.ProjectTemplateRead.model_validate(template)


def _project_settings(project: Project) -> dict[str, Any]:
    local_overrides = schemas.ProjectLocalOverrides.model_validate(
        project.local_overrides or {}
    )
    return {
        "description": project.description,
        "status": project.status,
        "tags": list(project.tags),
        "favorite": project.favorite,
        "generation_defaults": schemas.ProjectGenerationDefaults.model_validate(
            project.generation_defaults or {}
        ).model_dump(),
        "local_overrides": local_overrides.model_copy(
            update={"scene_prompts": {}, "shot_prompts": {}, "scene_outfits": {}}
        ).model_dump(),
    }


def _new_project(project_id: str, name: str, settings: dict[str, Any]) -> Project:
    now = schemas.now_iso()
    return Project(
        id=project_id,
        name=name,
        description=settings.get("description"),
        status=settings.get("status", "planning"),
        lifecycle="active",
        tags=list(settings.get("tags", [])),
        favorite=bool(settings.get("favorite", False)),
        thumbnail_artifact_id=None,
        generation_defaults=schemas.ProjectGenerationDefaults.model_validate(
            settings.get("generation_defaults", {})
        ).model_dump(),
        local_overrides=schemas.ProjectLocalOverrides.model_validate(
            settings.get("local_overrides", {})
        ).model_dump(),
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


async def _ensure_project_identity(session: AsyncSession, project_id: str, name: str) -> None:
    by_id = await session.get(Project, project_id)
    by_name = await session.scalar(select(Project).where(Project.name == name))
    if by_id is not None or by_name is not None:
        raise _error(
            "PROJECT_CONFLICT",
            "同じIDまたは名前のProjectがあります。",
            details={"project_id": project_id, "name": name},
            http_status=409,
        )


def _external_structure(project: Project) -> tuple[list[schemas.PortableScene], list[schemas.PortableShot]]:
    snapshot = project.source_snapshot or {}
    scene_items = snapshot.get("scenes", {}).get("items", [])
    shot_groups = snapshot.get("shots", {})
    scenes: list[schemas.PortableScene] = []
    shots: list[schemas.PortableShot] = []
    for scene_index, raw_scene in enumerate(scene_items):
        if not isinstance(raw_scene, dict) or not isinstance(raw_scene.get("id"), str):
            continue
        scene_id = raw_scene["id"]
        scenes.append(
            schemas.PortableScene(
                id=scene_id,
                sequence=int(raw_scene.get("sequence", scene_index)),
                summary=str(raw_scene.get("summary") or raw_scene.get("title") or scene_id),
            )
        )
        group = shot_groups.get(scene_id, {}) if isinstance(shot_groups, dict) else {}
        for shot_index, raw_shot in enumerate(group.get("items", [])):
            if not isinstance(raw_shot, dict) or not isinstance(raw_shot.get("id"), str):
                continue
            duration = raw_shot.get("duration_sec", 5)
            shots.append(
                schemas.PortableShot(
                    id=raw_shot["id"],
                    scene_id=scene_id,
                    sequence=int(raw_shot.get("sequence", shot_index)),
                    duration_sec=float(duration) if isinstance(duration, (int, float)) and duration > 0 else 5,
                    summary=str(raw_shot.get("summary") or raw_shot.get("title") or raw_shot["id"]),
                )
            )
    return scenes, shots


def _reference_image_content(
    reference: schemas.ProjectReferenceImage, settings: Settings
) -> bytes:
    try:
        content = storage.resolve_input(reference.relative_path, settings).read_bytes()
    except (OSError, storage.StorageError) as error:
        raise _error(
            "PROJECT_REFERENCE_IMAGE_MISSING",
            "参照画像の実ファイルがありません。",
            details={"relative_path": reference.relative_path},
            http_status=404,
        ) from error
    if (
        len(content) != reference.byte_size
        or hashlib.sha256(content).hexdigest() != reference.sha256
    ):
        raise _error(
            "PROJECT_REFERENCE_IMAGE_MISMATCH",
            "参照画像のサイズまたはSHA-256が記録と一致しません。",
            details={"relative_path": reference.relative_path},
        )
    _validate_reference_media_type(reference, content)
    return content


def _validate_reference_media_type(
    reference: schemas.ProjectReferenceImage, content: bytes
) -> None:
    detected = storage.detect_image_media_type(content[:32])
    if detected != reference.media_type:
        raise _error(
            "PROJECT_REFERENCE_IMAGE_MEDIA_TYPE_MISMATCH",
            "参照画像の実形式とmedia_typeが一致しません。",
            details={
                "relative_path": reference.relative_path,
                "declared": reference.media_type,
                "detected": detected,
            },
        )


def _portable_local_overrides(
    project: Project,
    settings: Settings,
    *,
    include_files: bool,
    include_structure: bool,
) -> tuple[schemas.ProjectLocalOverrides, list[schemas.PortableInputFile]]:
    overrides = schemas.ProjectLocalOverrides.model_validate(project.local_overrides or {})
    input_files: list[schemas.PortableInputFile] = []
    if include_files:
        included_hashes: set[str] = set()
        total_size = 0
        for character in overrides.characters:
            for reference in character.reference_images:
                if reference.sha256 in included_hashes:
                    continue
                content = _reference_image_content(reference, settings)
                total_size += len(content)
                if total_size > settings.project_package_max_bytes:
                    raise _error(
                        "PROJECT_PACKAGE_TOO_LARGE",
                        "人物参照画像の合計がProject package上限を超えています。",
                        details={
                            "byte_size": total_size,
                            "limit": settings.project_package_max_bytes,
                        },
                        http_status=413,
                    )
                input_files.append(
                    schemas.PortableInputFile(
                        sha256=reference.sha256,
                        byte_size=reference.byte_size,
                        content_base64=base64.b64encode(content).decode("ascii"),
                    )
                )
                included_hashes.add(reference.sha256)
    return (
        overrides.model_copy(
            update={
                "scene_prompts": (
                    dict(overrides.scene_prompts) if include_structure else {}
                ),
                "shot_prompts": (
                    dict(overrides.shot_prompts) if include_structure else {}
                ),
                "scene_outfits": (
                    dict(overrides.scene_outfits) if include_structure else {}
                ),
            }
        ),
        input_files,
    )


async def _package(
    session: AsyncSession,
    project: Project,
    settings: Settings,
    *,
    include_structure: bool,
    include_artifacts: bool,
    include_artifact_files: bool,
) -> schemas.ProjectPackage:
    scenes: list[schemas.PortableScene] = []
    shots: list[schemas.PortableShot] = []
    if include_structure and project.source_type == "local":
        scene_rows = list(
            await session.scalars(
                select(ProjectScene)
                .where(ProjectScene.project_id == project.id, ProjectScene.deleted_at.is_(None))
                .order_by(ProjectScene.sequence)
            )
        )
        shot_rows = list(
            await session.scalars(
                select(ProjectShot)
                .where(ProjectShot.project_id == project.id, ProjectShot.deleted_at.is_(None))
                .order_by(ProjectShot.sequence)
            )
        )
        scenes = [schemas.PortableScene.model_validate(row) for row in scene_rows]
        shots = [schemas.PortableShot.model_validate(row) for row in shot_rows]
    elif include_structure:
        scenes, shots = _external_structure(project)

    artifacts: list[schemas.PortableArtifact] = []
    if include_artifacts:
        rows = list(
            await session.scalars(
                select(Artifact)
                .where(
                    Artifact.assigned_project_id == project.id,
                    Artifact.deleted_at.is_(None),
                )
                .order_by(Artifact.created_at)
            )
        )
        scene_ids = {item.id for item in scenes}
        shot_ids = {item.id for item in shots}
        artifact_ids = {item.id for item in rows}
        import_rows = list(
            await session.scalars(
                select(ArtifactImport).where(
                    ArtifactImport.artifact_id.in_(artifact_ids)
                )
            )
        )
        imports_by_id = {item.artifact_id: item for item in import_rows}
        for row in rows:
            content = None
            availability = row.availability
            if include_artifact_files and row.availability == "complete":
                try:
                    data = storage.resolve_artifact(row.relative_path, settings).read_bytes()
                    content = base64.b64encode(data).decode("ascii")
                except (OSError, storage.StorageError):
                    availability = "incomplete"
            artifacts.append(
                schemas.PortableArtifact(
                    id=row.id,
                    kind=row.kind,
                    relative_path=row.relative_path,
                    sha256=row.sha256,
                    byte_size=row.byte_size,
                    media_type=row.media_type,
                    availability=availability,
                    parent_artifact_id=(
                        row.parent_artifact_id
                        if row.parent_artifact_id in artifact_ids
                        else None
                    ),
                    assigned_scene_id=(
                        row.assigned_scene_id if row.assigned_scene_id in scene_ids else None
                    ),
                    assigned_shot_id=(
                        row.assigned_shot_id if row.assigned_shot_id in shot_ids else None
                    ),
                    created_at=row.created_at,
                    decision=row.decision,
                    import_info=(
                        schemas.PortableArtifactImport.model_validate(
                            imports_by_id[row.id]
                        )
                        if row.id in imports_by_id
                        else None
                    ),
                    content_base64=content,
                )
            )

    defaults = schemas.ProjectGenerationDefaults.model_validate(
        _without_secrets(project.generation_defaults or {})
    )
    local_overrides, input_files = _portable_local_overrides(
        project,
        settings,
        include_files=include_artifact_files,
        include_structure=include_structure,
    )
    recipe_ids = sorted(
        profile.recipe_id
        for profile in [defaults.image, defaults.video, defaults.music, defaults.voice, defaults.compose]
        if profile.recipe_id
    )
    recipe_rows = list(await session.scalars(select(Recipe).where(Recipe.id.in_(recipe_ids)))) if recipe_ids else []
    workflow_ids = sorted({row.workflow_version_id for row in recipe_rows if row.workflow_version_id})
    models: set[str] = set()
    model_checks: set[str] = set()
    versions = list(
        await session.scalars(select(WorkflowVersion).where(WorkflowVersion.id.in_(workflow_ids)))
    ) if workflow_ids else []
    inputs_by_recipe = {
        profile.recipe_id: profile.inputs
        for profile in [defaults.image, defaults.video, defaults.music, defaults.voice, defaults.compose]
        if profile.recipe_id
    }
    for recipe in recipe_rows:
        version = next((item for item in versions if item.id == recipe.workflow_version_id), None)
        if version is None:
            continue
        values = inputs_by_recipe.get(recipe.id, {})
        for slot in version.model_slots:
            variable = slot.get("variable") or slot.get("name")
            value = values.get(variable) if isinstance(variable, str) else None
            if isinstance(value, str) and value:
                models.add(value)
                model_checks.add(json.dumps({
                    "node_class": slot.get("node_class"),
                    "option_field": slot.get("option_field"),
                    "variable": variable,
                    "value": value,
                }, ensure_ascii=False, sort_keys=True))

    return schemas.ProjectPackage(
        exported_at=schemas.now_iso(),
        project=schemas.PortableProject(
            id=project.id,
            name=project.name,
            description=project.description,
            status=project.status,
            tags=list(project.tags),
            favorite=project.favorite,
            generation_defaults=defaults,
            local_overrides=local_overrides,
            source_type=project.source_type,
            source_locator=_safe_locator(project.source_locator),
            source_revision=project.source_revision,
            external_id=project.external_id,
        ),
        scenes=scenes,
        shots=shots,
        artifacts=artifacts,
        input_files=input_files,
        dependencies={
            "recipe_ids": recipe_ids,
            "workflow_version_ids": workflow_ids,
            "models": sorted(models),
            "model_checks": sorted(model_checks),
        },
    )


def _migrate_package(payload: dict[str, Any]) -> schemas.ProjectPackage:
    """古いversionを順番に最新版へ上げる入口。version追加時はここへ変換を足す。"""
    if payload.get("format") != FORMAT:
        raise _error("PROJECT_PACKAGE_FORMAT_INVALID", "Project package形式ではありません。")
    version = payload.get("version")
    if version == 1:
        project = payload.get("project")
        project_payload = dict(project) if isinstance(project, dict) else project
        if isinstance(project_payload, dict):
            project_payload.setdefault(
                "local_overrides",
                schemas.ProjectLocalOverrides().model_dump(mode="json"),
            )
        payload = {
            **payload,
            "version": VERSION,
            "project": project_payload,
            "input_files": [],
        }
        version = VERSION
    if version != VERSION:
        raise _error(
            "PROJECT_PACKAGE_VERSION_UNSUPPORTED",
            "対応していないProject package versionです。",
            details={"supported": [1, VERSION], "received": version},
        )
    try:
        return schemas.ProjectPackage.model_validate(payload)
    except ValidationError as error:
        raise _error(
            "PROJECT_PACKAGE_INVALID",
            "Project packageの内容が不正です。",
            details=error.errors(include_url=False),
        ) from error


def _mapped_path(path: str, mappings: dict[str, str]) -> str:
    normalized = path.replace("\\", "/")
    for source, destination in sorted(mappings.items(), key=lambda item: len(item[0]), reverse=True):
        prefix = source.replace("\\", "/").rstrip("/")
        if normalized == prefix or normalized.startswith(f"{prefix}/"):
            normalized = f"{destination.rstrip('/')}{normalized[len(prefix):]}"
            break
    parts = PurePosixPath(normalized).parts
    if not parts or parts[0] != storage.ARTIFACTS_DIR_NAME or ".." in parts:
        raise _error("PROJECT_PACKAGE_PATH_INVALID", "Artifactの移行先はartifacts/配下にしてください。")
    return PurePosixPath(*parts).as_posix()


async def _preflight(
    session: AsyncSession,
    request: schemas.ProjectPackageImport,
    settings: Settings,
) -> tuple[schemas.ProjectPackage, schemas.ProjectPackagePreflight]:
    package = _migrate_package(request.package)
    collisions: list[str] = []
    for model, values in (
        (Project, [request.project_id or package.project.id]),
        (ProjectScene, [item.id for item in package.scenes]),
        (ProjectShot, [item.id for item in package.shots]),
        (Artifact, [item.id for item in package.artifacts]),
    ):
        for value in values:
            if await session.get(model, value) is not None:
                collisions.append(value)
    dependencies = package.dependencies
    recipe_ids = dependencies.get("recipe_ids", [])
    workflow_ids = dependencies.get("workflow_version_ids", [])
    known_recipes = set(await session.scalars(select(Recipe.id).where(Recipe.id.in_(recipe_ids)))) if recipe_ids else set()
    known_workflows = set(await session.scalars(select(WorkflowVersion.id).where(WorkflowVersion.id.in_(workflow_ids)))) if workflow_ids else set()
    artifact_missing_files = [
        item.relative_path
        for item in package.artifacts
        if item.availability == "complete" and item.content_base64 is None
        and not _path_exists(_mapped_path(item.relative_path, request.path_remap), settings)
    ]
    reference_images = [
        reference
        for character in package.project.local_overrides.characters
        for reference in character.reference_images
    ]
    encoded_total = sum(len(item.content_base64) for item in package.input_files)
    encoded_total_limit = (settings.project_package_max_bytes + 2) // 3 * 4
    if encoded_total > encoded_total_limit:
        raise _error(
            "PROJECT_PACKAGE_TOO_LARGE",
            "人物参照画像のbase64合計がProject package上限を超えています。",
            http_status=413,
        )
    if sum(item.byte_size for item in package.input_files) > settings.project_package_max_bytes:
        raise _error(
            "PROJECT_PACKAGE_TOO_LARGE",
            "人物参照画像の合計がProject package上限を超えています。",
            http_status=413,
        )
    input_files = {
        item.sha256: _decode_input_file(item, settings)
        for item in package.input_files
    }
    for reference in reference_images:
        content = input_files.get(reference.sha256)
        if content is not None:
            if len(content) != reference.byte_size:
                raise _error(
                    "PROJECT_REFERENCE_IMAGE_MISMATCH",
                    "参照画像のサイズが登録内容と一致しません。",
                )
            _validate_reference_media_type(reference, content)
    missing_reference_files = [
        reference.relative_path
        for reference in reference_images
        if reference.sha256 not in input_files
        and not _reference_image_exists(reference, settings)
    ]
    model_warnings: list[str] = []
    model_checks = dependencies.get("model_checks", [])
    if model_checks:
        client = create_comfyui_client()
        try:
            for raw in model_checks:
                try:
                    check = json.loads(raw)
                    options = await client.available_options(check["node_class"], check["option_field"])
                    if check["value"] not in options:
                        model_warnings.append(f"利用できないモデル: {check['variable']}={check['value']}")
                except (KeyError, TypeError, ValueError):
                    model_warnings.append("モデル依存情報を解釈できません。")
        except ComfyUIError as error:
            model_warnings.append(f"ComfyUIへ接続できずモデル在庫を確認できません: {error}")
        finally:
            await client.aclose()
    else:
        model_warnings = [
            f"移行先で利用可否を確認してください: {item}"
            for item in dependencies.get("models", [])
        ]
    preview = schemas.ProjectPackagePreflight(
        format_version=package.version,
        id_collisions=sorted(set(collisions)),
        missing_files=[*artifact_missing_files, *missing_reference_files],
        unavailable_recipes=sorted(set(recipe_ids) - known_recipes),
        unavailable_workflows=sorted(set(workflow_ids) - known_workflows),
        model_warnings=model_warnings,
        can_import=not missing_reference_files,
    )
    return package, preview


def _path_exists(path: str, settings: Settings) -> bool:
    try:
        storage.resolve_artifact(path, settings)
        return True
    except storage.StorageError:
        return False


def _reference_image_exists(
    reference: schemas.ProjectReferenceImage, settings: Settings
) -> bool:
    try:
        _reference_image_content(reference, settings)
        return True
    except ApiError:
        return False


def _decode_input_file(
    item: schemas.PortableInputFile, settings: Settings
) -> bytes:
    encoded_limit = (settings.max_image_bytes + 2) // 3 * 4
    if len(item.content_base64) > encoded_limit:
        raise _error(
            "PROJECT_PACKAGE_TOO_LARGE",
            "参照画像が入力素材の上限を超えています。",
            http_status=413,
        )
    try:
        content = base64.b64decode(item.content_base64, validate=True)
    except (ValueError, binascii.Error) as error:
        raise _error(
            "PROJECT_REFERENCE_IMAGE_INVALID",
            "参照画像のbase64が不正です。",
        ) from error
    if len(content) > settings.max_image_bytes:
        raise _error(
            "PROJECT_PACKAGE_TOO_LARGE",
            "参照画像が入力素材の上限を超えています。",
            http_status=413,
        )
    if (
        len(content) != item.byte_size
        or hashlib.sha256(content).hexdigest() != item.sha256
    ):
        raise _error(
            "PROJECT_REFERENCE_IMAGE_MISMATCH",
            "参照画像のサイズまたはSHA-256が一致しません。",
        )
    return content


def _decode_artifact(item: schemas.PortableArtifact, settings: Settings) -> bytes:
    try:
        content = base64.b64decode(item.content_base64 or "", validate=True)
    except (ValueError, binascii.Error) as error:
        raise _error("PROJECT_PACKAGE_ARTIFACT_INVALID", "Artifactのbase64が不正です。") from error
    if len(content) > settings.project_package_max_bytes:
        raise _error("PROJECT_PACKAGE_TOO_LARGE", "ArtifactがProject package上限を超えています。", http_status=413)
    if len(content) != item.byte_size or hashlib.sha256(content).hexdigest() != item.sha256:
        raise _error("PROJECT_PACKAGE_ARTIFACT_MISMATCH", "ArtifactのサイズまたはSHA-256が一致しません。")
    return content


def _read_external_image(path, expected_size: int) -> bytes:
    """可搬packageが参照する既存画像を、取込上限を越えて読まない。"""
    try:
        with path.open("rb") as stream:
            content = stream.read(image_imports.MAX_IMAGE_BYTES + 1)
    except OSError as error:
        raise storage.StorageError("外部画像を読み出せません。") from error
    if len(content) != expected_size:
        raise _error(
            "PROJECT_PACKAGE_ARTIFACT_MISMATCH",
            "外部画像の実ファイルサイズが記録と一致しません。",
        )
    return content


def _restore_local_overrides(
    overrides: schemas.ProjectLocalOverrides,
    input_files: list[schemas.PortableInputFile],
    settings: Settings,
    scene_ids: dict[str, str],
    shot_ids: dict[str, str],
) -> schemas.ProjectLocalOverrides:
    files_by_sha256 = {item.sha256: item for item in input_files}
    characters: list[schemas.ProjectCharacterProfile] = []
    for character in overrides.characters:
        references: list[schemas.ProjectReferenceImage] = []
        for reference in character.reference_images:
            input_file = files_by_sha256.get(reference.sha256)
            if input_file is not None:
                content = _decode_input_file(input_file, settings)
                _validate_reference_media_type(reference, content)
                try:
                    stored = storage.write_input(reference.file_name, content, settings)
                except storage.StorageError as error:
                    raise _error(
                        "PROJECT_REFERENCE_IMAGE_WRITE_FAILED",
                        "参照画像を入力cacheへ復元できません。",
                        http_status=503,
                    ) from error
                relative_path = stored.relative_path
                sha256 = stored.sha256
                byte_size = stored.byte_size
                restored = schemas.ProjectReferenceImage(
                    file_name=reference.file_name,
                    relative_path=relative_path,
                    sha256=sha256,
                    byte_size=byte_size,
                    media_type=reference.media_type,
                )
                _reference_image_content(restored, settings)
            else:
                _reference_image_content(reference, settings)
                relative_path = reference.relative_path
                sha256 = reference.sha256
                byte_size = reference.byte_size
                restored = schemas.ProjectReferenceImage(
                    file_name=reference.file_name,
                    relative_path=relative_path,
                    sha256=sha256,
                    byte_size=byte_size,
                    media_type=reference.media_type,
                )
            references.append(restored)
        characters.append(character.model_copy(update={"reference_images": references}))
    return schemas.ProjectLocalOverrides(
        characters=characters,
        scene_prompts={
            scene_ids.get(resource_id, resource_id): prompt
            for resource_id, prompt in overrides.scene_prompts.items()
        },
        scene_outfits={
            scene_ids.get(resource_id, resource_id): dict(selection)
            for resource_id, selection in overrides.scene_outfits.items()
        },
        shot_prompts={
            shot_ids.get(resource_id, resource_id): prompt
            for resource_id, prompt in overrides.shot_prompts.items()
        },
    )


async def _import_package(
    session: AsyncSession,
    request: schemas.ProjectPackageImport,
    settings: Settings,
) -> Project:
    """通常取込と同じlock内でquota確認からcommitまでを完了する。"""
    async with image_imports.CONFIRM_LOCK:
        return await _import_package_locked(session, request, settings)


async def _import_package_locked(
    session: AsyncSession,
    request: schemas.ProjectPackageImport,
    settings: Settings,
) -> Project:
    package, _ = await _preflight(session, request, settings)
    decoded_contents = {
        item.id: _decode_artifact(item, settings)
        for item in package.artifacts
        if item.content_base64 is not None
    }
    existing_rows = await session.execute(
        select(Artifact.relative_path, Artifact.byte_size)
        .join(ArtifactImport, ArtifactImport.artifact_id == Artifact.id)
        .where(Artifact.availability == "complete")
    )
    existing_paths = dict(existing_rows.all())
    incoming_paths: dict[str, int] = {}
    for item in package.artifacts:
        if item.import_info is None:
            continue
        if item.id in decoded_contents:
            incoming_paths.setdefault(f"embedded:{item.sha256}", item.byte_size)
            continue
        mapped = _mapped_path(item.relative_path, request.path_remap)
        if _path_exists(mapped, settings) and mapped not in existing_paths:
            incoming_paths.setdefault(f"existing:{mapped}", item.byte_size)
    existing_import_bytes = sum(existing_paths.values())
    incoming_import_bytes = sum(incoming_paths.values())
    if (
        existing_import_bytes + incoming_import_bytes
        > settings.external_image_import_quota_bytes
    ):
        raise _error(
            "IMAGE_IMPORT_QUOTA_EXCEEDED",
            "外部画像の保存上限を超えます。",
            details={
                "used_bytes": existing_import_bytes,
                "incoming_bytes": incoming_import_bytes,
                "quota_bytes": settings.external_image_import_quota_bytes,
            },
            http_status=507,
        )
    embedded_import_bytes = sum(
        size for key, size in incoming_paths.items() if key.startswith("embedded:")
    )
    if embedded_import_bytes:
        free_bytes = (
            await run_in_threadpool(shutil.disk_usage, settings.data_root)
        ).free
        if free_bytes - embedded_import_bytes < 512 * 1024 * 1024:
            raise _error(
                "INSUFFICIENT_STORAGE",
                "Artifact storeの空き容量が不足しています。",
                http_status=507,
            )
    external_paths_by_sha: dict[str, str] = {}
    for item in package.artifacts:
        if item.import_info is None:
            continue
        if item.byte_size > image_imports.MAX_IMAGE_BYTES:
            raise _error(
                "PROJECT_PACKAGE_ARTIFACT_INVALID",
                "外部画像が取込上限を超えています。",
            )
        data = decoded_contents.get(item.id)
        if data is None:
            mapped = _mapped_path(item.relative_path, request.path_remap)
            try:
                path = storage.resolve_artifact(mapped, settings)
                data = await run_in_threadpool(
                    _read_external_image, path, item.byte_size
                )
            except (OSError, storage.StorageError):
                # 実体を含まないincomplete Artifactは来歴だけを復元できる。
                continue
        if len(data) != item.byte_size or hashlib.sha256(data).hexdigest() != item.sha256:
            raise _error(
                "PROJECT_PACKAGE_ARTIFACT_MISMATCH",
                "外部画像のサイズまたはSHA-256が一致しません。",
            )
        try:
            async with image_imports.PARSE_SEMAPHORE:
                parsed = await run_in_threadpool(
                    image_imports.parse_image_bytes,
                    item.import_info.original_file_name,
                    data,
                    item.media_type,
                )
        except image_imports.ImageImportError as error:
            raise _error(
                "PROJECT_PACKAGE_ARTIFACT_INVALID",
                "外部画像を正常にデコードできません。",
            ) from error
        if parsed.source_format != item.import_info.source_format:
            raise _error(
                "PROJECT_PACKAGE_ARTIFACT_INVALID",
                "外部画像の形式と来歴が一致しません。",
            )
        if (
            parsed.metadata != item.import_info.raw_metadata
            or parsed.recipe_draft != item.import_info.recipe_draft
        ):
            raise _error(
                "PROJECT_PACKAGE_ARTIFACT_INVALID",
                "外部画像の埋込情報と来歴が一致しません。",
            )
    project_id = request.project_id or str(uuid4())
    name = request.name or package.project.name
    await _ensure_project_identity(session, project_id, name)
    scene_ids = {item.id: str(uuid4()) for item in package.scenes}
    shot_ids = {item.id: str(uuid4()) for item in package.shots}
    local_overrides = _restore_local_overrides(
        package.project.local_overrides,
        package.input_files,
        settings,
        scene_ids,
        shot_ids,
    )
    project = _new_project(
        project_id,
        name,
        {
            "description": package.project.description,
            "status": package.project.status,
            "tags": package.project.tags,
            "favorite": package.project.favorite,
            "generation_defaults": package.project.generation_defaults.model_dump(),
            "local_overrides": local_overrides.model_dump(),
        },
    )
    session.add(project)
    now = schemas.now_iso()
    artifact_ids = {item.id: str(uuid4()) for item in package.artifacts}
    for item in package.scenes:
        session.add(ProjectScene(
            id=scene_ids[item.id], project_id=project_id, sequence=item.sequence,
            summary=item.summary, notes=item.notes, tags=list(item.tags),
            production_status=item.production_status, created_at=now, updated_at=now, deleted_at=None,
            todo=item.todo, due_date=item.due_date, priority=item.priority,
        ))
    for item in package.shots:
        if item.scene_id not in scene_ids:
            raise _error("PROJECT_PACKAGE_STRUCTURE_INVALID", "Shotがpackage内にないSceneを参照しています。")
        session.add(ProjectShot(
            id=shot_ids[item.id], project_id=project_id, scene_id=scene_ids[item.scene_id],
            sequence=item.sequence, duration_sec=item.duration_sec, summary=item.summary,
            notes=item.notes, tags=list(item.tags), production_status=item.production_status,
            todo=item.todo, due_date=item.due_date, priority=item.priority,
            created_at=now, updated_at=now, deleted_at=None,
        ))
    project.scene_count = len(package.scenes)
    project.shot_count = len(package.shots)

    for item in package.artifacts:
        relative_path = _mapped_path(item.relative_path, request.path_remap)
        availability = item.availability
        if item.content_base64 is not None:
            content = decoded_contents[item.id]
            shared_path = (
                external_paths_by_sha.get(item.sha256)
                if item.import_info is not None
                else None
            )
            if shared_path is not None:
                relative_path = shared_path
            else:
                suffix = PurePosixPath(relative_path).name
                relative_path = f"artifacts/imported/{project_id}/{artifact_ids[item.id]}-{suffix}"
                target = settings.data_root / relative_path
                target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    with target.open("xb") as stream:
                        stream.write(content)
                except FileExistsError as error:
                    raise _error("PROJECT_PACKAGE_FILE_CONFLICT", "Artifactの移行先に同名ファイルがあります。", http_status=409) from error
                if item.import_info is not None:
                    external_paths_by_sha[item.sha256] = relative_path
            availability = "complete"
        elif not _path_exists(relative_path, settings):
            availability = "incomplete"
        new_artifact_id = artifact_ids[item.id]
        session.add(Artifact(
            id=new_artifact_id, job_id=None, kind=item.kind, relative_path=relative_path,
            sha256=item.sha256, byte_size=item.byte_size, media_type=item.media_type,
            availability=availability,
            parent_artifact_id=artifact_ids.get(item.parent_artifact_id) if item.parent_artifact_id else None,
            assigned_project_id=project_id,
            assigned_scene_id=scene_ids.get(item.assigned_scene_id) if item.assigned_scene_id else None,
            assigned_shot_id=shot_ids.get(item.assigned_shot_id) if item.assigned_shot_id else None,
            created_at=item.created_at, decision=item.decision, decision_at=None,
        ))
        if item.import_info is not None:
            session.add(
                ArtifactImport(
                    artifact_id=new_artifact_id,
                    original_file_name=item.import_info.original_file_name,
                    source_format=item.import_info.source_format,
                    raw_metadata=item.import_info.raw_metadata,
                    recipe_draft=item.import_info.recipe_draft,
                    created_at=item.import_info.created_at,
                )
            )
    await session.commit()
    return project


@router.get("/templates", response_model=list[schemas.ProjectTemplateRead])
async def list_templates(session: SessionDep):
    rows = await session.scalars(select(ProjectTemplate).order_by(ProjectTemplate.name))
    return [_template_read(item) for item in rows]


@router.post("/projects/{project_id}/templates", response_model=schemas.ProjectTemplateRead, status_code=201)
async def create_template(project_id: str, payload: schemas.ProjectTemplateCreate, session: SessionDep):
    project = await _project(session, project_id)
    if await session.scalar(select(ProjectTemplate).where(ProjectTemplate.name == payload.name)):
        raise _error("PROJECT_TEMPLATE_CONFLICT", "同名のテンプレートがあります。", http_status=409)
    now = schemas.now_iso()
    template = ProjectTemplate(id=str(uuid4()), name=payload.name, description=payload.description, settings=_project_settings(project), created_at=now, updated_at=now)
    session.add(template)
    await session.commit()
    return _template_read(template)


@router.post("/templates/{template_id}/instantiate", response_model=schemas.ProjectRead, status_code=201)
async def instantiate_template(template_id: str, payload: schemas.ProjectTemplateInstantiate, session: SessionDep):
    template = await session.get(ProjectTemplate, template_id)
    if template is None:
        raise _error("PROJECT_TEMPLATE_NOT_FOUND", "テンプレートがありません。", http_status=404)
    project_id = payload.project_id or str(uuid4())
    await _ensure_project_identity(session, project_id, payload.name)
    project = _new_project(project_id, payload.name, template.settings)
    session.add(project)
    await session.commit()
    from mycomfyui_api.projects import _read
    return _read(project)


@router.get("/projects/{project_id}/export", response_model=schemas.ProjectPackage)
async def export_project(
    project_id: str,
    session: SessionDep,
    settings: SettingsDep,
    include_structure: bool = True,
    include_artifacts: bool = True,
    include_artifact_files: bool = False,
):
    return await _package(session, await _project(session, project_id), settings, include_structure=include_structure, include_artifacts=include_artifacts, include_artifact_files=include_artifact_files)


@router.get("/projects/{project_id}/backup", response_model=schemas.ProjectPackage)
async def backup_project(project_id: str, session: SessionDep, settings: SettingsDep):
    return await _package(session, await _project(session, project_id), settings, include_structure=True, include_artifacts=True, include_artifact_files=True)


@router.post("/projects/{project_id}/clone", response_model=schemas.ProjectRead, status_code=201)
async def clone_project(project_id: str, payload: schemas.ProjectCloneRequest, session: SessionDep, settings: SettingsDep):
    package = await _package(session, await _project(session, project_id), settings, include_structure=payload.include_structure, include_artifacts=payload.include_artifact_references, include_artifact_files=False)
    project = await _import_package(session, schemas.ProjectPackageImport(package=package.model_dump(mode="json"), name=payload.name, project_id=payload.project_id), settings)
    from mycomfyui_api.projects import _read
    return _read(project)


@router.post("/import/preview", response_model=schemas.ProjectPackagePreflight)
async def preview_import(
    payload: schemas.ProjectPackageImport,
    session: SessionDep,
    settings: SettingsDep,
):
    _, preview = await _preflight(session, payload, settings)
    return preview


@router.post("/import", response_model=schemas.ProjectRead, status_code=201)
async def import_project(payload: schemas.ProjectPackageImport, session: SessionDep, settings: SettingsDep):
    project = await _import_package(session, payload, settings)
    from mycomfyui_api.projects import _read
    return _read(project)


@router.post("/restore", response_model=schemas.ProjectRead, status_code=201)
async def restore_backup(payload: schemas.ProjectPackageImport, session: SessionDep, settings: SettingsDep):
    project = await _import_package(session, payload, settings)
    from mycomfyui_api.projects import _read
    return _read(project)
