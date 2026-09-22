import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from mycomfyui_api import routers, schemas
from mycomfyui_api.adapters.comfyui.tagger import ComfyUITagger
from mycomfyui_api.adapters.image_tagger import (
    ImageTaggerError,
    QwenTagRefiner,
    normalize_tags,
)
from mycomfyui_api.errors import ApiError
from mycomfyui_api.settings import Settings

TAGGER_SETTINGS = Settings(
    comfyui_base_url="http://comfy.test",
    agent_qwen_base_url="http://tagger.test/v1",
    image_tagger_timeout_seconds=5.0,
)


def _comfyui_transport(
    test: unittest.TestCase, outputs: dict[str, object]
) -> httpx.MockTransport:
    """upload、prompt、historyの3経路を持つComfyUIの代役を返す。"""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/upload/image":
            test.assertIn(b"mycomfyui-tagger-", request.content)
            return httpx.Response(200, json={"name": "uploaded.png", "subfolder": ""})
        if request.url.path == "/prompt":
            workflow = json.loads(request.content)["prompt"]
            test.assertEqual(workflow["1"]["inputs"]["image"], "uploaded.png")
            test.assertEqual(workflow["2"]["class_type"], "WD14Tagger|pysssss")
            return httpx.Response(200, json={"prompt_id": "pid"})
        if request.url.path == "/history/pid":
            return httpx.Response(
                200,
                json={"pid": {"status": {"completed": True}, "outputs": outputs}},
            )
        raise AssertionError(f"想定外の経路: {request.url.path}")

    return httpx.MockTransport(handler)


class ComfyUITaggerTest(unittest.IsolatedAsyncioTestCase):
    async def test_extract_splits_comma_separated_tags(self) -> None:
        tagger = ComfyUITagger(
            TAGGER_SETTINGS,
            transport=_comfyui_transport(self, {"2": {"tags": ["cat, sitting, Cat"]}}),
        )

        self.assertEqual(
            await tagger.extract("aGVsbG8=", "image/png"), ["cat", "sitting"]
        )

    async def test_extract_rejects_invalid_base64(self) -> None:
        tagger = ComfyUITagger(TAGGER_SETTINGS)

        with self.assertRaisesRegex(ImageTaggerError, "base64"):
            await tagger.extract("not base64", "image/png")

    async def test_extract_reports_missing_tags(self) -> None:
        tagger = ComfyUITagger(
            TAGGER_SETTINGS,
            transport=_comfyui_transport(self, {"2": {"other": []}}),
        )

        with self.assertRaisesRegex(ImageTaggerError, "タグを返しませんでした"):
            await tagger.extract("aGVsbG8=", "image/png")


class QwenTagRefinerTest(unittest.IsolatedAsyncioTestCase):
    async def test_refine_sends_tags_and_removes_duplicates(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/v1/chat/completions")
            body = json.loads(request.content)
            self.assertIn("cat, sitting", body["messages"][1]["content"])
            self.assertEqual(body["response_format"]["type"], "json_schema")
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {"message": {"content": '{"tags": ["Cat", "cat", "sunlight"]}'}}
                    ]
                },
            )

        refiner = QwenTagRefiner(
            TAGGER_SETTINGS, transport=httpx.MockTransport(handler)
        )

        self.assertEqual(await refiner.refine(["cat", "sitting"]), ["Cat", "sunlight"])

    async def test_refine_reports_timeout(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("timed out", request=request)

        refiner = QwenTagRefiner(
            TAGGER_SETTINGS, transport=httpx.MockTransport(handler)
        )

        with self.assertRaisesRegex(ImageTaggerError, "終わりませんでした"):
            await refiner.refine(["cat"])

    async def test_refine_rejects_invalid_envelope(self) -> None:
        refiner = QwenTagRefiner(
            TAGGER_SETTINGS,
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, json={"choices": []})
            ),
        )

        with self.assertRaisesRegex(ImageTaggerError, "応答を解釈できません"):
            await refiner.refine(["cat"])

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


class ImageTagEndpointTest(unittest.IsolatedAsyncioTestCase):
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
        with (
            patch.object(
                routers, "get_settings", return_value=Settings(max_image_bytes=1)
            ),
            self.assertRaises(ApiError) as raised,
        ):
            await routers.extract_image_tags(
                schemas.ImageTagExtractRequest(
                    content_base64="aGk=", media_type="image/png"
                )
            )
        self.assertEqual(raised.exception.code, "VALIDATION_ERROR")
        self.assertEqual(raised.exception.status_code, 422)

    async def test_endpoint_returns_tagger_error(self) -> None:
        tagger = AsyncMock()
        tagger.extract.side_effect = ImageTaggerError("ComfyUIへ接続できません。")
        with (
            patch.object(routers, "ComfyUITagger", return_value=tagger),
            self.assertRaises(ApiError) as raised,
        ):
            await routers.extract_image_tags(
                schemas.ImageTagExtractRequest(
                    content_base64="aA==", media_type="image/png"
                )
            )
        self.assertEqual(raised.exception.code, "IMAGE_TAGGER_ERROR")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.message, "ComfyUIへ接続できません。")

    async def test_endpoint_keeps_tags_when_refine_fails(self) -> None:
        """整理に失敗しても抽出結果を返す。生成中は推論サーバーへ繋がらないため。"""
        tagger = AsyncMock()
        tagger.extract.return_value = ["cat", "sitting"]
        refiner = AsyncMock()
        refiner.refine.side_effect = ImageTaggerError("タグ整理AIへ接続できません。")
        with (
            patch.object(routers, "ComfyUITagger", return_value=tagger),
            patch.object(routers, "QwenTagRefiner", return_value=refiner),
        ):
            result = await routers.extract_image_tags(
                schemas.ImageTagExtractRequest(
                    content_base64="aA==", media_type="image/png"
                )
            )
        self.assertEqual(result.tags, ["cat", "sitting"])
