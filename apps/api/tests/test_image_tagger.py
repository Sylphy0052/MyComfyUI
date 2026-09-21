import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from mycomfyui_api.adapters.image_tagger import ImageTaggerError, QwenImageTagger, normalize_tags
from mycomfyui_api import routers, schemas
from mycomfyui_api.errors import ApiError
from mycomfyui_api.settings import Settings


class ImageTaggerTest(unittest.IsolatedAsyncioTestCase):
    async def test_extract_sends_image_and_removes_duplicate_tags(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/v1/chat/completions")
            body = json.loads(request.content)
            image = body["messages"][1]["content"][1]["image_url"]["url"]
            self.assertEqual(image, "data:image/png;base64,aGVsbG8=")
            self.assertEqual(body["response_format"]["type"], "json_schema")
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": '{"tags": ["Cat", "cat", "sunlight"]}'
                            }
                        }
                    ]
                },
            )

        tagger = QwenImageTagger(
            Settings(agent_qwen_base_url="http://tagger.test/v1"),
            transport=httpx.MockTransport(handler),
        )

        self.assertEqual(
            await tagger.extract("aGVsbG8=", "image/png"), ["Cat", "sunlight"]
        )

    def test_normalize_tags_rejects_non_json_output(self) -> None:
        with self.assertRaises(ImageTaggerError):
            normalize_tags("not json")

    def test_normalize_tags_rejects_missing_tags(self) -> None:
        with self.assertRaises(ImageTaggerError):
            normalize_tags('{"other": []}')

    def test_normalize_tags_drops_invalid_values_and_limits_count(self) -> None:
        values: list[object] = [" first ", "FIRST", "x" * 201, None]
        values.extend(f"tag-{index}" for index in range(60))

        tags = normalize_tags(json.dumps({"tags": values}))

        self.assertEqual(tags[0], "first")
        self.assertEqual(len(tags), 50)

    async def test_extract_reports_timeout(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("timed out", request=request)

        tagger = QwenImageTagger(
            Settings(agent_qwen_base_url="http://tagger.test/v1"),
            transport=httpx.MockTransport(handler),
        )

        with self.assertRaisesRegex(ImageTaggerError, "終わりませんでした"):
            await tagger.extract("aGVsbG8=", "image/png")

    async def test_extract_rejects_invalid_envelope(self) -> None:
        tagger = QwenImageTagger(
            Settings(agent_qwen_base_url="http://tagger.test/v1"),
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, json={"choices": []})
            ),
        )

        with self.assertRaisesRegex(ImageTaggerError, "応答を解釈できません"):
            await tagger.extract("aGVsbG8=", "image/png")

    async def test_endpoint_rejects_invalid_base64(self) -> None:
        with self.assertRaises(ApiError) as raised:
            await routers.extract_image_tags(
                schemas.ImageTagExtractRequest(
                    content_base64="not base64", media_type="image/png"
                )
            )
        self.assertEqual(raised.exception.code, "VALIDATION_ERROR")
        self.assertEqual(raised.exception.status_code, 422)

    async def test_endpoint_rejects_oversized_image(self) -> None:
        with patch.object(routers, "get_settings", return_value=Settings(max_image_bytes=1)):
            with self.assertRaises(ApiError) as raised:
                await routers.extract_image_tags(
                    schemas.ImageTagExtractRequest(
                        content_base64="aGk=", media_type="image/png"
                    )
                )
        self.assertEqual(raised.exception.code, "VALIDATION_ERROR")
        self.assertEqual(raised.exception.status_code, 422)

    async def test_endpoint_returns_tagger_error(self) -> None:
        tagger = AsyncMock()
        tagger.extract.side_effect = ImageTaggerError("画像タグ抽出AIへ接続できません。")
        with patch.object(routers, "QwenImageTagger", return_value=tagger):
            with self.assertRaises(ApiError) as raised:
                await routers.extract_image_tags(
                    schemas.ImageTagExtractRequest(
                        content_base64="aA==", media_type="image/png"
                    )
                )
        self.assertEqual(raised.exception.code, "IMAGE_TAGGER_ERROR")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.message, "画像タグ抽出AIへ接続できません。")
