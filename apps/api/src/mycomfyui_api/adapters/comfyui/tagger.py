"""ComfyUIのWD14 Taggerで画像からDanbooruタグを抽出する。

視覚言語モデルへ画像を直接渡す経路とは異なり、抽出はComfyUI上のWorkflowとして走る。
ComfyUIのエンドポイントの知識は`client`へ閉じ込め、本モジュールはWorkflowの組み立てと
`outputs`の解釈だけを持つ。
"""

import asyncio
import base64
import binascii
import json
import logging
import uuid
from pathlib import Path
from typing import Any

import httpx

from mycomfyui_api.adapters.comfyui.client import (
    ComfyUIClient,
    ComfyUIError,
    WaitResult,
)
from mycomfyui_api.adapters.image_tagger import ImageTaggerError, normalize_tag_values
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

TEMPLATE_PATH = Path(__file__).resolve().parent / "templates" / "wd14_tagger.json"

#: Workflow内でのノードの役割。テンプレートと対応する。
LOAD_IMAGE_NODE = "1"
TAGGER_NODE = "2"

#: 取り込んだ画像に付ける拡張子。ComfyUIは内容から形式を判定するため、
#: media typeとの対応が無い場合もこの名前で受け付けられる。
MEDIA_TYPE_SUFFIXES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
DEFAULT_SUFFIX = ".png"


class ComfyUITagger:
    """ComfyUIのWD14 Taggerノードを呼び出す。"""

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._transport = transport

    async def extract(self, content_base64: str, media_type: str) -> list[str]:
        """画像をComfyUIへ預け、WD14が出したタグ列を返す。"""
        try:
            data = base64.b64decode(content_base64, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ImageTaggerError("画像のbase64を解釈できません。") from error
        if not data:
            raise ImageTaggerError("空の画像は解析できません。")
        file_name = _unique_file_name(media_type)
        client = ComfyUIClient(self._settings, transport=self._transport)
        try:
            async with client:
                uploaded = await client.upload_input(file_name, data)
                workflow = self._build_workflow(uploaded)
                prompt_id = await client.submit(workflow)
                result = await client.wait_for_completion(
                    prompt_id,
                    cancel_event=asyncio.Event(),
                    timeout=self._settings.image_tagger_timeout_seconds,
                )
                if result is not WaitResult.COMPLETED:
                    raise ImageTaggerError("画像タグ抽出が完了しませんでした。")
                entry = await client.history_entry(prompt_id)
        except ComfyUIError as error:
            raise ImageTaggerError(f"画像タグ抽出に失敗しました: {error}") from error
        if entry is None:
            raise ImageTaggerError("画像タグ抽出の結果を取得できませんでした。")
        return normalize_tag_values(_tag_values(entry))

    def _build_workflow(self, uploaded_name: str) -> dict[str, Any]:
        workflow = json.loads(TEMPLATE_PATH.read_text(encoding="utf-8"))
        workflow[LOAD_IMAGE_NODE]["inputs"]["image"] = uploaded_name
        tagger_inputs = workflow[TAGGER_NODE]["inputs"]
        tagger_inputs["model"] = self._settings.image_tagger_model
        tagger_inputs["threshold"] = self._settings.image_tagger_threshold
        tagger_inputs["character_threshold"] = (
            self._settings.image_tagger_character_threshold
        )
        tagger_inputs["replace_underscore"] = (
            self._settings.image_tagger_replace_underscore
        )
        tagger_inputs["exclude_tags"] = self._settings.image_tagger_exclude_tags
        return workflow


def _unique_file_name(media_type: str) -> str:
    """ComfyUIのinputで衝突しない名前を作る。

    ComfyUIは同名を採番して退避するが、抽出のたびにファイルが残り続けるため、
    採番に頼らず毎回別名で置く。
    """
    suffix = MEDIA_TYPE_SUFFIXES.get(media_type, DEFAULT_SUFFIX)
    return f"mycomfyui-tagger-{uuid.uuid4().hex}{suffix}"


def _tag_values(entry: dict[str, Any]) -> list[str]:
    """historyの`outputs`からタグ列を取り出す。

    WD14 Taggerはカンマ区切りの1文字列を`tags`へ入れて返す。配列で返す版もあるため、
    要素ごとにカンマで割ってから正規化へ渡す。
    """
    outputs = entry.get("outputs")
    if not isinstance(outputs, dict):
        raise ImageTaggerError("画像タグ抽出の結果を解釈できません。")
    node = outputs.get(TAGGER_NODE)
    raw = node.get("tags") if isinstance(node, dict) else None
    if not isinstance(raw, list):
        raise ImageTaggerError("画像タグ抽出がタグを返しませんでした。")
    values: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        values.extend(item.split(","))
    return values
