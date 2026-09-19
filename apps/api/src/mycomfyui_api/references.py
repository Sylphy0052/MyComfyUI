"""ai-media参照APIの中継Endpoint。

読取りだけを提供する。`novel-writer`側のデータを変更する経路は持たない。応答は上流の
契約(`contracts/ai-media/v1/openapi.yaml`)の本文をそのまま返し、MyComfyUI側で形を
変えない。上流が未稼働の間は同梱fixtureが同じ形で応答する。
"""

import logging
from collections.abc import Awaitable, Callable
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Request
from starlette import status

from mycomfyui_api.adapters.aimedia.client import (
    AiMediaNotFound,
    AiMediaUnavailable,
    ReferenceSource,
)
from mycomfyui_api.errors import ApiError
from mycomfyui_api.schemas import CANON_ID_PATTERN, REFERENCE_ID_PATTERN

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1")

#: 参照IDの書式は`schemas`を正本とする。上流URLのパスセグメントへ埋め込む値のため、
#: `.`や`..`が混ざらないよう、要求を受け取る時点で弾く。
ReferenceId = Annotated[str, Path(pattern=REFERENCE_ID_PATTERN)]

CanonId = Annotated[str, Path(pattern=CANON_ID_PATTERN)]


def get_reference_source(request: Request) -> ReferenceSource:
    return request.app.state.reference_source


ReferenceSourceDep = Annotated[ReferenceSource, Depends(get_reference_source)]


async def _relay(call: Callable[[], Awaitable[dict[str, Any]]]) -> dict[str, Any]:
    """参照Adapterの例外を共通Envelopeへ変換する。

    上流の不調(503)と、指定した資源が無いこと(404)を画面が区別できるようにする。
    """
    try:
        return await call()
    except AiMediaNotFound as error:
        raise ApiError(
            "REFERENCE_NOT_FOUND",
            str(error),
            status_code=status.HTTP_404_NOT_FOUND,
        ) from error
    except AiMediaUnavailable as error:
        logger.warning("ai-media参照APIを利用できません。", exc_info=error)
        raise ApiError(
            "REFERENCE_UNAVAILABLE",
            "ai-media参照APIを利用できませんでした。",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error


@router.get("/projects")
async def list_projects(source: ReferenceSourceDep) -> dict[str, Any]:
    return await _relay(source.list_projects)


@router.get("/projects/{project_id}")
async def get_project(
    project_id: ReferenceId, source: ReferenceSourceDep
) -> dict[str, Any]:
    return await _relay(lambda: source.get_project(project_id))


@router.get("/projects/{project_id}/scenes")
async def list_scenes(
    project_id: ReferenceId, source: ReferenceSourceDep
) -> dict[str, Any]:
    return await _relay(lambda: source.list_scenes(project_id))


@router.get("/projects/{project_id}/scenes/{scene_id}")
async def get_scene(
    project_id: ReferenceId, scene_id: ReferenceId, source: ReferenceSourceDep
) -> dict[str, Any]:
    return await _relay(lambda: source.get_scene(project_id, scene_id))


@router.get("/projects/{project_id}/scenes/{scene_id}/shots")
async def list_shots(
    project_id: ReferenceId, scene_id: ReferenceId, source: ReferenceSourceDep
) -> dict[str, Any]:
    return await _relay(lambda: source.list_shots(project_id, scene_id))


@router.get("/projects/{project_id}/scenes/{scene_id}/shots/{shot_id}")
async def get_shot(
    project_id: ReferenceId,
    scene_id: ReferenceId,
    shot_id: ReferenceId,
    source: ReferenceSourceDep,
) -> dict[str, Any]:
    return await _relay(lambda: source.get_shot(project_id, scene_id, shot_id))


@router.get("/projects/{project_id}/canon")
async def list_canon(
    project_id: ReferenceId, source: ReferenceSourceDep
) -> dict[str, Any]:
    return await _relay(lambda: source.list_canon(project_id))


@router.get("/projects/{project_id}/canon/{canon_id}")
async def get_canon(
    project_id: ReferenceId, canon_id: CanonId, source: ReferenceSourceDep
) -> dict[str, Any]:
    return await _relay(lambda: source.get_canon(project_id, canon_id))
