"""Web UIから変更できる設定の保存と反映 (#337)。

環境変数の値を既定値とし、DBの`app_setting`に保存した値があればそちらを優先する。
`get_settings()`はプロセスの間固定のため手を加えず、保存値を上に重ねた実効設定を使う。
保存値は`app.state.setting_overrides`へ置き、保存した時点で差し替える。Qwen Providerは
接続先を`httpx.AsyncClient`へ閉じ込めるため、保存のたびに作り直す。これでAPIを再起動
しなくても、次の要求から新しい値が効く。
"""

import asyncio
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI, Request
from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from mycomfyui_api import schemas
from mycomfyui_api.adapters.agent import QwenProvider
from mycomfyui_api.db import get_session
from mycomfyui_api.models import AppSetting
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/settings", tags=["settings"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]

#: APIの項目名と、`Settings`の属性名の対応。属性名をそのまま`app_setting.key`に使う。
QWEN_FIELDS = {
    "base_url": "agent_qwen_base_url",
    "model": "agent_qwen_model",
    "status_url": "agent_qwen_status_url",
    "supports_images": "agent_qwen_supports_images",
}


async def load_overrides(session: AsyncSession) -> dict[str, Any]:
    """保存値を`Settings`の属性名で返す。UIから変えられない項目のkeyは読まない。

    `effective_settings`の`model_copy`は値を検証しないため、読み込む時点で1項目ずつ
    PUTと同じ規則で検証する。通らない値は捨てて環境変数の値を使い、起動は止めない。
    """
    fields = {key: field for field, key in QWEN_FIELDS.items()}
    rows = await session.scalars(
        select(AppSetting).where(AppSetting.key.in_(QWEN_FIELDS.values()))
    )
    overrides: dict[str, Any] = {}
    for row in rows:
        field = fields[row.key]
        try:
            checked = schemas.QwenSettingsUpdate.model_validate({field: row.value})
        except ValidationError:
            logger.warning(
                "app_settingの%sが不正なため無視する: %r", row.key, row.value
            )
            continue
        value = getattr(checked, field)
        if value is not None:
            overrides[row.key] = value
    return overrides


def effective_settings(overrides: dict[str, Any]) -> Settings:
    """環境変数の設定に保存値を重ねる。保存値はPUTと読み込みの時点で検証済みとする。"""
    if not overrides:
        return get_settings()
    return get_settings().model_copy(update=overrides)


def current_overrides(app: FastAPI) -> dict[str, Any]:
    # lifespanを通さないテスト用のappでは保存値を持たない。
    return getattr(app.state, "setting_overrides", {})


def get_effective_settings(request: Request) -> Settings:
    return effective_settings(current_overrides(request.app))


def _qwen_values(settings: Settings) -> schemas.QwenSettingsValues:
    return schemas.QwenSettingsValues(
        **{field: getattr(settings, key) for field, key in QWEN_FIELDS.items()}
    )


def _describe_qwen(overrides: dict[str, Any]) -> schemas.QwenSettingsRead:
    return schemas.QwenSettingsRead(
        effective=_qwen_values(effective_settings(overrides)),
        defaults=_qwen_values(get_settings()),
        saved=schemas.QwenSettingsUpdate(
            **{field: overrides.get(key) for field, key in QWEN_FIELDS.items()}
        ),
    )


async def _replace_qwen_provider(app: FastAPI, settings: Settings) -> None:
    """Qwen Providerを新しい設定で作り直す。

    古いProviderはすぐには閉じない。実行中の補完要求が古いProviderを掴んだままawait
    しており、閉じるとその要求の接続が切れる。退役リストへ移し、API終了時に閉じる。
    保存は手作業で稀なため、残るclientの数は問題にならない。
    """
    providers = getattr(app.state, "agent_providers", None)
    if providers is None:
        return
    previous = providers.get("qwen")
    providers["qwen"] = QwenProvider(settings)
    if previous is None:
        return
    retired = getattr(app.state, "retired_agent_providers", None)
    if retired is None:
        # lifespanを通さないappでは終了時の後始末が無いため、ここで閉じる。
        await previous.aclose()
        return
    retired.append(previous)


def _settings_lock(app: FastAPI) -> asyncio.Lock:
    # 同時のPUTでDBの保存値と`app.state`の実効値が食い違わないよう、保存を直列にする。
    # 取得と設定の間にawaitが無いため、遅延生成でも2つ作られない。
    lock = getattr(app.state, "settings_lock", None)
    if lock is None:
        lock = asyncio.Lock()
        app.state.settings_lock = lock
    return lock


@router.get("/qwen", response_model=schemas.QwenSettingsRead)
async def read_qwen_settings(request: Request):
    """Qwenの接続設定を、実効値・環境変数の値・保存値に分けて返す。"""
    return _describe_qwen(current_overrides(request.app))


@router.put("/qwen", response_model=schemas.QwenSettingsRead)
async def update_qwen_settings(
    payload: schemas.QwenSettingsUpdate, request: Request, session: SessionDep
):
    """Qwenの保存値を丸ごと置き換える。nullの項目は保存値を消し、環境変数の値へ戻す。"""
    async with _settings_lock(request.app):
        return await _save_qwen_settings(payload, request.app, session)


async def _save_qwen_settings(
    payload: schemas.QwenSettingsUpdate, app: FastAPI, session: AsyncSession
) -> schemas.QwenSettingsRead:
    saved = {
        QWEN_FIELDS[field]: value
        for field, value in payload.model_dump().items()
        if value is not None
    }
    await session.execute(
        delete(AppSetting).where(AppSetting.key.in_(QWEN_FIELDS.values()))
    )
    updated_at = schemas.now_iso()
    session.add_all(
        AppSetting(key=key, value=value, updated_at=updated_at)
        for key, value in saved.items()
    )
    await session.commit()
    overrides = {
        key: value
        for key, value in current_overrides(app).items()
        if key not in QWEN_FIELDS.values()
    }
    overrides.update(saved)
    app.state.setting_overrides = overrides
    # Providerはcommitの後で作る。今のコンストラクタは接続しないため失敗しない。接続の
    # 検証を足すときは、失敗で保存値と動いているProviderが食い違わないよう、commitより
    # 前に作って失敗したら保存しない順序へ変える。
    await _replace_qwen_provider(app, effective_settings(overrides))
    return _describe_qwen(overrides)
