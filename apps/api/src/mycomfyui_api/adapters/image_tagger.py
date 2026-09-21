"""OpenAI互換の視覚言語モデルで画像をタグ化する。"""

import json
import logging
from typing import Any

import httpx

from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

MAX_TAGS = 50
MAX_TAG_LENGTH = 200


class ImageTaggerError(Exception):
    """利用者へ安全に伝えられる画像解析エラー。"""


class QwenImageTagger:
    """Qwen VLなどOpenAI互換の視覚言語モデルを呼び出す。"""

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

    async def extract(self, content_base64: str, media_type: str) -> list[str]:
        body = {
            "model": self._settings.agent_qwen_model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You extract concise image-generation tags. "
                        'Return only a JSON object with an English string array named "tags". '
                        "Include subjects, "
                        "appearance, setting, composition, lighting, and style when visible."
                    ),
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Extract image-generation tags from this image."},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{media_type};base64,{content_base64}"},
                        },
                    ],
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
                f"画像タグ抽出が{self._timeout}秒で終わりませんでした。"
            ) from error
        except httpx.HTTPError as error:
            raise ImageTaggerError("画像タグ抽出AIへ接続できません。") from error
        if not response.is_success:
            logger.warning("画像タグ抽出AIがエラーを返しました。status=%s", response.status_code)
            if 400 <= response.status_code < 500:
                raise ImageTaggerError(
                    f"画像タグ抽出AIが要求を拒否しました(HTTP {response.status_code})。"
                    "視覚言語モデルの設定を確認してください。"
                )
            raise ImageTaggerError(
                f"画像タグ抽出AIがエラーを返しました(HTTP {response.status_code})。"
            )
        try:
            envelope = response.json()
            content = envelope["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise ImageTaggerError("画像タグ抽出AIの応答を解釈できません。") from error
        if not isinstance(content, str):
            raise ImageTaggerError("画像タグ抽出AIの応答にタグがありません。")
        return normalize_tags(content)


def normalize_tags(content: str) -> list[str]:
    """AIのJSON object内のtags配列を安全なプロンプト用タグ列へ正規化する。"""
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as error:
        raise ImageTaggerError("画像タグ抽出AIがタグ配列を返しませんでした。") from error
    if not isinstance(payload, dict):
        raise ImageTaggerError("画像タグ抽出AIがタグ配列を返しませんでした。")
    values = payload.get("tags")
    if not isinstance(values, list):
        raise ImageTaggerError("画像タグ抽出AIがタグ配列を返しませんでした。")
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
        raise ImageTaggerError("画像タグ抽出AIから有効なタグを取得できませんでした。")
    return tags
