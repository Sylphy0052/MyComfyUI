import unittest

from mycomfyui_api.adapters.agent.base import AgentInvalidResponse
from mycomfyui_api.adapters.agent.proposals import (
    MAX_CURRENT_TAG_WORDS,
    MAX_PROMPT_TAGS,
    _current_tags,
    _warn_untranslated_rationale,
    describe_prompt_changes,
    revise_current_prompt,
)

LOGGER_NAME = "mycomfyui_api.adapters.agent.proposals"


class WarnUntranslatedRationaleTest(unittest.TestCase):
    def test_english_rationale_warns_and_is_kept(self) -> None:
        body = {"rationale": "Added lighting tags to match the scene."}

        with self.assertLogs(LOGGER_NAME, level="WARNING") as logs:
            _warn_untranslated_rationale(body)

        self.assertEqual(
            logs.output,
            [f"WARNING:{LOGGER_NAME}:prompt案の説明が日本語になっていません。"],
        )
        self.assertEqual(body["rationale"], "Added lighting tags to match the scene.")

    def test_japanese_rationale_does_not_warn(self) -> None:
        body = {"rationale": "場面に合わせて照明のタグを足した。"}

        with self.assertNoLogs(LOGGER_NAME, level="WARNING"):
            _warn_untranslated_rationale(body)

        self.assertEqual(body["rationale"], "場面に合わせて照明のタグを足した。")

    def test_empty_or_blank_rationale_does_not_warn(self) -> None:
        for rationale in ("", "  \n\t"):
            with self.subTest(rationale=rationale):
                body = {"rationale": rationale}

                with self.assertNoLogs(LOGGER_NAME, level="WARNING"):
                    _warn_untranslated_rationale(body)

                self.assertEqual(body["rationale"], rationale)


SENTENCE = "a girl standing in the rain at night"


def _revision(**fields: object) -> dict[str, object]:
    """全ブロックを空にしたレビュー案。指定したフィールドだけ上書きする。"""
    output: dict[str, object] = {
        "quality_tags": [],
        "subject_tags": [],
        "character_tags": [],
        "artist_tags": [],
        "general_tags": [],
        "tag_changes": [],
        "natural_text_change": {"change": "unchanged", "reason": ""},
        "natural_text": "",
        "tag_glosses": [],
        "rationale": "",
    }
    output.update(fields)
    return output


class CurrentTagsTest(unittest.TestCase):
    def test_long_or_period_ended_segments_are_sentences(self) -> None:
        longest_tag = " ".join(["word"] * MAX_CURRENT_TAG_WORDS)
        shortest_sentence = " ".join(["word"] * (MAX_CURRENT_TAG_WORDS + 1))

        tags, sentences = _current_tags(
            f"1girl, {longest_tag}, {shortest_sentence}, she smiles."
        )

        self.assertEqual(tags, ["1girl", longest_tag])
        self.assertEqual(sentences, [shortest_sentence, "she smiles."])


class ReviseCurrentPromptTest(unittest.TestCase):
    def test_restored_tags_over_limit_are_rejected(self) -> None:
        current = ", ".join(f"item{i}" for i in range(MAX_PROMPT_TAGS + 1))

        with (
            self.assertLogs(LOGGER_NAME, level="WARNING"),
            self.assertRaises(AgentInvalidResponse) as raised,
        ):
            revise_current_prompt(_revision(), current, "")

        message = str(raised.exception)
        self.assertIn(f"general_tagsが{MAX_PROMPT_TAGS + 1}件", message)
        self.assertIn(f"上限の{MAX_PROMPT_TAGS}件", message)
        self.assertIn(f"戻したタグ: {MAX_PROMPT_TAGS + 1}件", message)

    def test_all_blocks_over_limit_are_reported(self) -> None:
        current = ", ".join(f"@artist{i}" for i in range(MAX_PROMPT_TAGS + 1))
        output = _revision(
            general_tags=[f"item{i}" for i in range(MAX_PROMPT_TAGS + 2)]
        )

        with (
            self.assertLogs(LOGGER_NAME, level="WARNING"),
            self.assertRaises(AgentInvalidResponse) as raised,
        ):
            revise_current_prompt(output, current, "")

        # ブロックは`TAG_BLOCK_FIELDS`の順に並ぶ。並び順も含めて全文で比べる。
        self.assertEqual(
            str(raised.exception),
            f"レビュー案のタグが多すぎます。上限の{MAX_PROMPT_TAGS}件を超えるブロック: "
            f"artist_tagsが{MAX_PROMPT_TAGS + 1}件 (うち現在のpromptから戻したタグ: "
            f"{MAX_PROMPT_TAGS + 1}件)、"
            f"general_tagsが{MAX_PROMPT_TAGS + 2}件 (うち現在のpromptから戻したタグ: 0件)。",
        )

    def test_restored_tags_at_limit_are_kept(self) -> None:
        tags = [f"item{i}" for i in range(MAX_PROMPT_TAGS)]

        with self.assertLogs(LOGGER_NAME, level="WARNING"):
            revised = revise_current_prompt(_revision(), ", ".join(tags), "")

        self.assertEqual(revised["general_tags"], tags)

    def test_dropped_sentence_is_reported_and_not_restored(self) -> None:
        current = f"1girl, smile, {SENTENCE}"
        output = _revision(subject_tags=["1girl"], general_tags=["smile"])

        with self.assertLogs(LOGGER_NAME, level="WARNING") as logs:
            revised = revise_current_prompt(output, current, "")

        self.assertEqual(len(logs.output), 1)
        self.assertIn(f"文とみなして戻さなかった区切り: {SENTENCE}", logs.output[0])
        self.assertNotIn(SENTENCE, revised["general_tags"])

    def test_sentence_listed_as_removed_is_not_reported(self) -> None:
        current = f"1girl, smile, {SENTENCE}"
        output = _revision(
            subject_tags=["1girl"],
            general_tags=["smile"],
            tag_changes=[
                {"tag": SENTENCE, "change": "removed", "field": "general_tags"}
            ],
        )

        with self.assertNoLogs(LOGGER_NAME, level="WARNING"):
            revise_current_prompt(output, current, "")

    def test_character_tag_without_instruction_spelling_is_restored(self) -> None:
        current = "hatsune miku"
        output = _revision(
            tag_changes=[
                {"tag": "hatsune miku", "change": "removed", "field": "character_tags"}
            ]
        )

        with self.assertLogs(LOGGER_NAME, level="WARNING") as logs:
            revised = revise_current_prompt(output, current, "")

        self.assertIn("hatsune miku", revised["character_tags"])
        self.assertIn("指示に綴りが無く消さなかったタグ: hatsune miku", logs.output[0])

    def test_artist_and_quality_tags_are_restored_regardless_of_declared_field(
        self,
    ) -> None:
        current = "masterpiece, @wlop"
        output = _revision(
            tag_changes=[
                {"tag": "masterpiece", "change": "removed", "field": "general_tags"},
                {"tag": "@wlop", "change": "removed", "field": "general_tags"},
            ]
        )

        with self.assertLogs(LOGGER_NAME, level="WARNING"):
            revised = revise_current_prompt(output, current, "")

        self.assertIn("masterpiece", revised["quality_tags"])
        self.assertIn("@wlop", revised["artist_tags"])

    def test_character_tag_with_instruction_spelling_is_removed(self) -> None:
        current = "hatsune miku"
        output = _revision(
            tag_changes=[
                {"tag": "hatsune miku", "change": "removed", "field": "character_tags"}
            ]
        )
        instruction = "hatsune mikuの要素を消してください。"

        with self.assertNoLogs(LOGGER_NAME, level="WARNING"):
            revised = revise_current_prompt(output, current, instruction)

        self.assertEqual(revised["character_tags"], [])

    def test_general_tag_removal_is_kept_even_without_instruction_spelling(
        self,
    ) -> None:
        current = "smile"
        output = _revision(
            tag_changes=[{"tag": "smile", "change": "removed", "field": "general_tags"}]
        )

        revised = revise_current_prompt(output, current, "")

        self.assertEqual(revised["general_tags"], [])

    def test_natural_text_dropped_without_reason_is_restored(self) -> None:
        current = "1girl\n\nA girl stands in the rain."
        output = _revision(subject_tags=["1girl"])

        with self.assertLogs(LOGGER_NAME, level="WARNING") as logs:
            revised = revise_current_prompt(output, current, "")

        self.assertEqual(revised["natural_text"], "A girl stands in the rain.")
        self.assertIn("自然文を戻した: はい", logs.output[0])

    def test_natural_text_marked_removed_is_dropped(self) -> None:
        current = "1girl\n\nA girl stands in the rain."
        output = _revision(
            subject_tags=["1girl"],
            natural_text_change={"change": "removed", "reason": "不要だった"},
        )

        with self.assertNoLogs(LOGGER_NAME, level="WARNING"):
            revised = revise_current_prompt(output, current, "")

        self.assertEqual(revised["natural_text"], "")


class DescribePromptChangesTest(unittest.TestCase):
    def test_tag_diff_uses_actual_difference_and_model_reasons(self) -> None:
        current = "1girl, smile, @wlop"
        output = _revision(
            tag_line="1girl, happy, @wlop, masterpiece",
            tag_changes=[
                {"tag": "happy", "change": "added", "reason": "表情を変えた"},
                {"tag": "smile", "change": "removed", "reason": ""},
                {"tag": "masterpiece", "change": "added"},
            ],
        )

        result = describe_prompt_changes(output, current)

        self.assertEqual(
            result["tag_changes"],
            [
                {"tag": "happy", "change": "added", "reason": "表情を変えた"},
                {"tag": "masterpiece", "change": "added", "reason": ""},
                {"tag": "smile", "change": "removed", "reason": ""},
            ],
        )

    def test_natural_text_change_detects_added(self) -> None:
        current = "1girl"
        output = _revision(
            tag_line="1girl",
            natural_text="A girl in the rain.",
            natural_text_change={"change": "added", "reason": "情景を書き足した"},
        )

        result = describe_prompt_changes(output, current)

        self.assertEqual(result["tag_changes"], [])
        self.assertEqual(
            result["natural_text_change"],
            {"change": "added", "reason": "情景を書き足した"},
        )

    def test_natural_text_change_detects_removed(self) -> None:
        current = "1girl\n\nA girl stands in the rain."
        output = _revision(
            tag_line="1girl",
            natural_text="",
            natural_text_change={"change": "removed", "reason": "説明が不要だった"},
        )

        result = describe_prompt_changes(output, current)

        self.assertEqual(
            result["natural_text_change"],
            {"change": "removed", "reason": "説明が不要だった"},
        )

    def test_natural_text_change_detects_modified(self) -> None:
        current = "1girl\n\nA girl stands in the rain."
        output = _revision(
            tag_line="1girl",
            natural_text="A girl stands in the snow.",
            natural_text_change={"change": "modified", "reason": "天候を変えた"},
        )

        result = describe_prompt_changes(output, current)

        self.assertEqual(
            result["natural_text_change"],
            {"change": "modified", "reason": "天候を変えた"},
        )

    def test_empty_current_prompt_returns_no_changes(self) -> None:
        output = _revision(
            tag_line="1girl",
            natural_text="hi",
            tag_changes=[{"tag": "1girl", "change": "added", "reason": "x"}],
            natural_text_change={"change": "added", "reason": "y"},
        )

        for current in ("", "   "):
            with self.subTest(current=repr(current)):
                result = describe_prompt_changes(output, current)

                self.assertEqual(result["tag_changes"], [])
                self.assertEqual(
                    result["natural_text_change"],
                    {"change": "unchanged", "reason": ""},
                )


if __name__ == "__main__":
    unittest.main()
