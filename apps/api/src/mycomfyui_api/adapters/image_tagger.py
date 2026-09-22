"""OpenAI互換の推論サーバーで、抽出済みのタグを整理・拡張する。

画像そのものの解析はComfyUIのWD14 Taggerが担う(`adapters/comfyui/tagger.py`)。本モジュール
はその出力を受け取ってプロンプトへ入れやすい形へ整えるだけで、視覚言語モデルを必要と
しない。
"""

import json
import logging
from collections.abc import Iterable
from typing import Any

import httpx

from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

MAX_TAGS = 50
MAX_TAG_LENGTH = 200


class ImageTaggerError(Exception):
    """利用者へ安全に伝えられる画像解析エラー。"""


class QwenTagRefiner:
    """QwenなどOpenAI互換のテキストモデルでタグ列を整える。"""

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._base_url = self._settings.agent_qwen_base_url.rstrip("/")
        self._timeout = self._settings.agent_qwen_timeout_seconds
        self._transport = transport

    async def refine(self, tags: Iterable[str]) -> list[str]:
        """タグ列を整理・拡張して返す。失敗はImageTaggerErrorで伝える。"""
        source = ", ".join(tags)
        if not source:
            raise ImageTaggerError("整理するタグがありません。")
        body = {
            "model": self._settings.agent_qwen_model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You organize tags for image generation. "
                        'Return only a JSON object with an English string array named "tags". '
                        "Keep the given tags that describe the image, merge duplicates, and "
                        "order them from subject to appearance, setting, composition, "
                        "lighting, and style. Do not invent content the tags do not imply."
                    ),
                },
                {
                    "role": "user",
                    "content": f"Organize these image tags: {source}",
                },
            ],
            "stream": False,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "image_tags",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "tags": {
                                "type": "array",
                                "items": {"type": "string"},
                                "maxItems": MAX_TAGS,
                            }
                        },
                        "required": ["tags"],
                        "additionalProperties": False,
                    },
                },
            },
        }
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                timeout=httpx.Timeout(self._timeout),
                transport=self._transport,
            ) as client:
                response = await client.post("/chat/completions", json=body)
        except httpx.TimeoutException as error:
            raise ImageTaggerError(
                f"タグの整理が{self._timeout}秒で終わりませんでした。"
            ) from error
        except httpx.HTTPError as error:
            raise ImageTaggerError("タグ整理AIへ接続できません。") from error
        if not response.is_success:
            logger.warning(
                "タグ整理AIがエラーを返しました。status=%s", response.status_code
            )
            if 400 <= response.status_code < 500:
                raise ImageTaggerError(
                    f"タグ整理AIが要求を拒否しました(HTTP {response.status_code})。"
                    "推論サーバーの設定を確認してください。"
                )
            raise ImageTaggerError(
                f"タグ整理AIがエラーを返しました(HTTP {response.status_code})。"
            )
        try:
            envelope = response.json()
            content = envelope["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise ImageTaggerError("タグ整理AIの応答を解釈できません。") from error
        if not isinstance(content, str):
            raise ImageTaggerError("タグ整理AIの応答にタグがありません。")
        return normalize_tags(content)


def normalize_tags(content: str) -> list[str]:
    """AIのJSON object内のtags配列を安全なプロンプト用タグ列へ正規化する。"""
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as error:
        raise ImageTaggerError("タグ整理AIがタグ配列を返しませんでした。") from error
    if not isinstance(payload, dict):
        raise ImageTaggerError("タグ整理AIがタグ配列を返しませんでした。")
    values = payload.get("tags")
    if not isinstance(values, list):
        raise ImageTaggerError("タグ整理AIがタグ配列を返しませんでした。")
    return normalize_tag_values(values)


def normalize_tag_values(values: Iterable[Any]) -> list[str]:
    """タグ列から空白と重複を落とし、件数と長さの上限を課す。

    WD14 Taggerの出力とAIの応答の双方が通るため、文字列以外の要素は捨てる。
    """
    tags: list[str] = []
    normalized_tags: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        tag = " ".join(value.split()).strip(" ,")
        normalized = tag.casefold()
        if not tag or len(tag) > MAX_TAG_LENGTH or normalized in normalized_tags:
            continue
        tags.append(tag)
        normalized_tags.add(normalized)
        if len(tags) == MAX_TAGS:
            break
    if not tags:
        raise ImageTaggerError("有効なタグを取得できませんでした。")
    return tags
