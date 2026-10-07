"""タグ辞書によるprompt案の正規化 (#395) の単体テスト。"""

import copy
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

from mycomfyui_api import routers
from mycomfyui_api.adapters.agent import proposals
from mycomfyui_api.adapters.agent.proposals import (
    NATURAL_TEXT_MAX_SENTENCES,
    NATURAL_TEXT_MAX_WORDS,
    _canonicalize_body_tags,
    normalize_prompt_tags,
)

LOGGER_NAME = "mycomfyui_api.adapters.agent.proposals"
ROUTERS_LOGGER_NAME = "mycomfyui_api.routers"

CANONICAL = {"alone": "solo", "solo": "solo", "smile": "smile"}


def _body(**fields: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "quality_tags": ["masterpiece", "safe"],
        "subject_tags": ["1girl"],
        "character_tags": [],
        "artist_tags": [],
        "general_tags": ["smile"],
        "natural_text": "She stands in the rain. The light is soft.",
    }
    body.update(fields)
    return body


def _words(count: int, last: str = "end.") -> str:
    """`count`語で、最後の語が`last`の1文を作る。"""
    return " ".join(["word"] * (count - 1) + [last])


class NormalizePromptTagsTest(unittest.TestCase):
    def test_alias_is_renamed(self) -> None:
        output = normalize_prompt_tags(
            "image_prompt", _body(general_tags=["alone"]), CANONICAL, None
        )

        self.assertEqual(output["general_tags"], ["solo"])
        self.assertIn("solo", output["positive_prompt"])

    def test_empty_dictionary_returns_output_as_is(self) -> None:
        output = _body(general_tags=["glowing_sword"])

        self.assertIs(normalize_prompt_tags("image_prompt", output, {}, None), output)
        self.assertIs(normalize_prompt_tags("image_prompt", output, None, None), output)

    def test_unassemblable_image_prompt_keeps_original(self) -> None:
        # 短い別名が長い正規名へ直ると、連結後のpositive promptが上限を超える。
        names = {f"a{i}": f"{'x' * 90}{i}" for i in range(50)}
        body = _body(general_tags=list(names))
        original = copy.deepcopy(body)

        with self.assertLogs(LOGGER_NAME, level="WARNING"):
            output = normalize_prompt_tags("image_prompt", body, names, None)

        self.assertEqual(output, original)
        self.assertEqual(body, original)
        self.assertNotIn("positive_prompt", output)

    def test_unassemblable_batch_item_keeps_only_that_item_original(self) -> None:
        names = {f"a{i}": f"{'x' * 90}{i}" for i in range(50)}
        too_long = _body(general_tags=list(names))
        normal = _body(general_tags=["alone"])
        original_too_long = copy.deepcopy(too_long)
        plan = {"rationale": "計画", "items": [too_long, normal]}

        with self.assertLogs(LOGGER_NAME, level="WARNING"):
            output = normalize_prompt_tags(
                "batch_generation_plan", plan, {**names, **CANONICAL}, None
            )

        self.assertEqual(output["items"][0], original_too_long)
        self.assertEqual(too_long, original_too_long)
        self.assertEqual(output["items"][1]["general_tags"], ["solo"])
        self.assertIn("solo", output["rationale"])

    def test_unknown_tag_is_moved_to_last_sentence(self) -> None:
        body = _body(general_tags=["glowing_sword"])

        output = normalize_prompt_tags("image_prompt", body, CANONICAL, None)

        self.assertNotIn("glowing sword", output["general_tags"])
        self.assertEqual(
            output["natural_text"],
            "She stands in the rain. The light is soft, glowing sword.",
        )

    def test_unknown_tag_is_removed_when_style_is_tags(self) -> None:
        output = normalize_prompt_tags(
            "image_prompt", _body(general_tags=["glowing_sword"]), CANONICAL, "tags"
        )

        self.assertNotIn("glowing sword", output["natural_text"])

    def test_keep_tags_are_not_removed(self) -> None:
        output = normalize_prompt_tags(
            "image_prompt",
            _body(general_tags=["glowing_sword"]),
            CANONICAL,
            None,
            keep_tags={"glowing sword"},
        )

        self.assertEqual(output["general_tags"], ["glowing_sword"])

    def _natural_text_after_move(self, natural_text: str) -> str:
        output = normalize_prompt_tags(
            "image_prompt",
            _body(general_tags=["glowing_sword"], natural_text=natural_text),
            CANONICAL,
            None,
        )
        return output["natural_text"]

    def _canonicalize_unknown(
        self, natural_text: str, style: str | None = None, tag: str = "glowing_sword"
    ) -> tuple[dict[str, Any], list[str], list[str]]:
        """未知タグ1件を含む案を正規化し、案と、移したタグ、外したタグを返す。"""
        result, (_, moved, removed) = _canonicalize_body_tags(
            _body(general_tags=[tag], natural_text=natural_text),
            CANONICAL,
            style,
            frozenset(),
        )
        return result, moved, removed

    def _assert_removed(
        self, natural_text: str, style: str | None = None, tag: str = "glowing_sword"
    ) -> None:
        """未知タグが自然文へ移らず、`general_tags`から外れて`removed`に載る。"""
        result, moved, removed = self._canonicalize_unknown(natural_text, style, tag)

        self.assertEqual(result["natural_text"], natural_text)
        self.assertEqual(result["general_tags"], [])
        self.assertEqual(moved, [])
        self.assertEqual(removed, [tag.replace("_", " ")])

    def test_unknown_tag_is_recorded_as_removed_when_style_is_tags(self) -> None:
        self._assert_removed(_words(10), style="tags")

    def test_move_switches_to_removal_at_word_limit(self) -> None:
        # 移す句`glowing sword`は2語。60語ちょうどなら移し、61語になるなら外す。
        fits = _words(NATURAL_TEXT_MAX_WORDS - 2)
        over = _words(NATURAL_TEXT_MAX_WORDS - 1)

        moved = self._natural_text_after_move(fits)

        self.assertEqual(len(moved.split()), NATURAL_TEXT_MAX_WORDS)
        self.assertTrue(moved.endswith("glowing sword."))
        self._assert_removed(over)

    def test_move_switches_to_removal_at_sentence_limit(self) -> None:
        three = " ".join(["She runs."] * NATURAL_TEXT_MAX_SENTENCES)
        four = " ".join(["She runs."] * (NATURAL_TEXT_MAX_SENTENCES + 1))

        # 足しても文は増えない。3文なら移し、既に4文なら外す。
        self.assertTrue(
            self._natural_text_after_move(three).endswith(", glowing sword.")
        )
        self._assert_removed(four)

    def test_move_switches_to_removal_at_schema_length(self) -> None:
        # 2000字の上限は、60語の判定とは別に残している。足した後が2000字ちょうどなら移す。
        # 足す部分は`, glowing sword`の15字。
        phrase_length = len(", glowing sword")
        fits = "w" * (proposals.MAX_NATURAL_TEXT_LENGTH - phrase_length - 1) + "."
        over = "w" * (proposals.MAX_NATURAL_TEXT_LENGTH - phrase_length) + "."

        moved = self._natural_text_after_move(fits)

        self.assertEqual(len(moved), proposals.MAX_NATURAL_TEXT_LENGTH)
        self.assertTrue(moved.endswith(", glowing sword."))
        self._assert_removed(over)

    def test_empty_natural_text_becomes_a_single_sentence_of_the_tag(self) -> None:
        # 移す前から最小2文を満たさない案は、移したあとも`natural_length`違反のまま。
        result, moved, removed = self._canonicalize_unknown("")

        self.assertEqual(result["natural_text"], "glowing sword.")
        self.assertEqual(moved, ["glowing sword"])
        self.assertEqual(removed, [])
        self.assertLess(
            len(proposals.split_natural_sentences(result["natural_text"])),
            proposals.NATURAL_TEXT_MIN_SENTENCES,
        )

    def test_tag_with_period_is_never_moved_or_removed(self) -> None:
        # 終止符を含むタグ(`mr. x`)は`tag_preflight.is_excluded`が自然文とみなして
        # 実在確認の対象外にする。そのため移す経路へ入らず、移して文数が増える
        # ことは起こらない。タグ行へそのまま残る。
        three = " ".join(["She runs."] * NATURAL_TEXT_MAX_SENTENCES)

        result, moved, removed = self._canonicalize_unknown(three, tag="mr. x")

        self.assertEqual(result["general_tags"], ["mr. x"])
        self.assertEqual(result["natural_text"], three)
        self.assertEqual((moved, removed), ([], []))



class CanonicalizeBodyTagsTest(unittest.TestCase):
    def test_does_not_mutate_body(self) -> None:
        body = _body(general_tags=["alone", "glowing_sword", "smile"])
        original = copy.deepcopy(body)

        result, (renamed, moved, removed) = _canonicalize_body_tags(
            body, CANONICAL, None, frozenset()
        )

        self.assertEqual(body, original)
        self.assertEqual(result["general_tags"], ["solo", "smile"])
        self.assertEqual(
            (renamed, moved, removed), (["alone → solo"], ["glowing sword"], [])
        )
        self.assertIsNot(result["general_tags"], body["general_tags"])

    def test_unknown_tag_outside_general_tags_is_kept(self) -> None:
        body = _body(
            character_tags=["unknown chara (new work)"],
            artist_tags=["@new_artist"],
            general_tags=[],
        )

        result, (renamed, moved, removed) = _canonicalize_body_tags(
            body, CANONICAL, None, frozenset()
        )

        self.assertEqual(result["character_tags"], ["unknown chara (new work)"])
        self.assertEqual(result["artist_tags"], ["@new_artist"])
        self.assertEqual((renamed, moved, removed), ([], [], []))


class CanonicalTagNamesTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._dictionaries = mock.patch.object(routers, "_tag_dictionaries", {})
        self._dictionaries.start()
        self.addCleanup(self._dictionaries.stop)

    def _settings(self, path: Path | None) -> Any:
        return mock.patch.object(
            routers,
            "get_settings",
            return_value=SimpleNamespace(tag_dictionary_path=path),
        )

    async def test_unset_path_returns_empty(self) -> None:
        with self._settings(None):
            self.assertEqual(await routers._canonical_tag_names(), {})

    async def test_unreadable_dictionary_returns_empty_and_warns(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing.csv"
            with (
                self._settings(missing),
                self.assertLogs(ROUTERS_LOGGER_NAME, level="WARNING"),
            ):
                self.assertEqual(await routers._canonical_tag_names(), {})

    async def test_broken_dictionary_returns_empty_and_warns(self) -> None:
        # 行の形が壊れたCSVと、UTF-8として読めないバイト列は、どちらも
        # `TagDictionaryError`に包まれて`{}`へ戻る。
        for name, content in (
            ("short_row.csv", b"smile,0\n"),
            ("bad_count.csv", b"smile,0,many\n"),
            ("not_utf8.csv", b"smile,0,500\n\xff\xfe\n"),
        ):
            with self.subTest(name), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / name
                path.write_bytes(content)
                with (
                    self._settings(path),
                    self.assertLogs(ROUTERS_LOGGER_NAME, level="WARNING"),
                ):
                    self.assertEqual(await routers._canonical_tag_names(), {})

    async def test_fixed_dictionary_is_reloaded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "danbooru.csv"
            path.write_text("smile,0\n", encoding="utf-8")
            with self._settings(path):
                with self.assertLogs(ROUTERS_LOGGER_NAME, level="WARNING"):
                    self.assertEqual(await routers._canonical_tag_names(), {})
                path.write_text("smile,0,500,smiling\n", encoding="utf-8")
                names = await routers._canonical_tag_names()

        self.assertEqual(names["smiling"], "smile")

    async def test_readable_dictionary_maps_alias_to_canonical_name(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "danbooru.csv"
            path.write_text(
                'hatsune_miku,4,100,"miku"\nsmile,0,500,smiling\n', encoding="utf-8"
            )
            with self._settings(path):
                names = await routers._canonical_tag_names()

        self.assertEqual(names["miku"], "hatsune miku")
        self.assertEqual(names["smiling"], "smile")
        self.assertEqual(names["smile"], "smile")


if __name__ == "__main__":
    unittest.main()
