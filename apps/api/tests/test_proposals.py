import unittest

from mycomfyui_api.adapters.agent.proposals import (
    MAX_CURRENT_TAG_WORDS,
    _current_tags,
    build_tag_confidence_blocks,
    describe_prompt_changes,
    revise_current_prompt,
)

LOGGER_NAME = "mycomfyui_api.adapters.agent.proposals"

SENTENCE = "a girl standing in the rain at night"
#: タグ辞書から読んだキャラクターのタグ名。`load_tag_dictionary`と同じく正規化済み。
DICTIONARY_CHARACTERS = frozenset({"hatsune miku"})


def _revision(**fields: object) -> dict[str, object]:
    """全ブロックを空にしたレビュー案。指定したフィールドだけ上書きする。"""
    output: dict[str, object] = {
        "quality_tags": [],
        "subject_tags": [],
        "character_tags": [],
        "artist_tags": [],
        "general_tags": [],
        "tag_changes": [],
        "natural_text_change": {"change": "unchanged"},
        "natural_text": "",
        "tag_glosses": [],
        "tag_confidences": [],
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
    def test_restored_tags_have_no_count_limit(self) -> None:
        # #407: ブロックの件数上限を撤廃した。戻すタグがどれだけ多くても拒否しない。
        tags = [f"item{i}" for i in range(40)]

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

    def test_dictionary_character_removed_as_general_is_restored(self) -> None:
        current = "hatsune miku, smile"
        output = _revision(
            general_tags=["smile"],
            tag_changes=[
                {"tag": "hatsune miku", "change": "removed", "field": "general_tags"}
            ],
        )

        with self.assertLogs(LOGGER_NAME, level="WARNING") as logs:
            revised = revise_current_prompt(
                output, current, "", character_tags=DICTIONARY_CHARACTERS
            )

        self.assertEqual(revised["character_tags"], ["hatsune miku"])
        self.assertNotIn("hatsune miku", revised["general_tags"])
        self.assertIn("指示に綴りが無く消さなかったタグ: hatsune miku", logs.output[0])

    def test_dictionary_character_added_as_general_is_dropped(self) -> None:
        current = "smile"
        output = _revision(
            general_tags=["smile", "hatsune miku"],
            tag_changes=[
                {"tag": "hatsune miku", "change": "added", "field": "general_tags"}
            ],
        )

        with self.assertLogs(LOGGER_NAME, level="WARNING") as logs:
            revised = revise_current_prompt(
                output, current, "", character_tags=DICTIONARY_CHARACTERS
            )

        self.assertEqual(revised["general_tags"], ["smile"])
        self.assertEqual(revised["character_tags"], [])
        self.assertIn("足さなかったタグ: hatsune miku", logs.output[0])

    def test_dictionary_character_with_instruction_spelling_is_removed(self) -> None:
        current = "hatsune miku, smile"
        output = _revision(
            general_tags=["smile"],
            tag_changes=[
                {"tag": "hatsune miku", "change": "removed", "field": "general_tags"}
            ],
        )
        instruction = "hatsune mikuの要素を消してください。"

        with self.assertNoLogs(LOGGER_NAME, level="WARNING"):
            revised = revise_current_prompt(
                output, current, instruction, character_tags=DICTIONARY_CHARACTERS
            )

        self.assertEqual(revised["character_tags"], [])
        self.assertEqual(revised["general_tags"], ["smile"])

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
            natural_text_change={"change": "removed"},
        )

        with self.assertNoLogs(LOGGER_NAME, level="WARNING"):
            revised = revise_current_prompt(output, current, "")

        self.assertEqual(revised["natural_text"], "")


class DescribePromptChangesTest(unittest.TestCase):
    def test_tag_diff_uses_actual_difference(self) -> None:
        current = "1girl, smile, @wlop"
        output = _revision(
            tag_line="1girl, happy, @wlop, masterpiece",
            tag_changes=[
                {"tag": "happy", "change": "added"},
                {"tag": "smile", "change": "removed"},
                {"tag": "masterpiece", "change": "added"},
            ],
        )

        result = describe_prompt_changes(output, current)

        self.assertEqual(
            result["tag_changes"],
            [
                {"tag": "happy", "change": "added"},
                {"tag": "masterpiece", "change": "added"},
                {"tag": "smile", "change": "removed"},
            ],
        )

    def test_natural_text_change_detects_added(self) -> None:
        current = "1girl"
        output = _revision(
            tag_line="1girl",
            natural_text="A girl in the rain.",
            natural_text_change={"change": "added"},
        )

        result = describe_prompt_changes(output, current)

        self.assertEqual(result["tag_changes"], [])
        self.assertEqual(
            result["natural_text_change"],
            {"change": "added"},
        )

    def test_natural_text_change_detects_removed(self) -> None:
        current = "1girl\n\nA girl stands in the rain."
        output = _revision(
            tag_line="1girl",
            natural_text="",
            natural_text_change={"change": "removed"},
        )

        result = describe_prompt_changes(output, current)

        self.assertEqual(
            result["natural_text_change"],
            {"change": "removed"},
        )

    def test_natural_text_change_detects_modified(self) -> None:
        current = "1girl\n\nA girl stands in the rain."
        output = _revision(
            tag_line="1girl",
            natural_text="A girl stands in the snow.",
            natural_text_change={"change": "modified"},
        )

        result = describe_prompt_changes(output, current)

        self.assertEqual(
            result["natural_text_change"],
            {"change": "modified"},
        )

    def test_empty_current_prompt_returns_no_changes(self) -> None:
        output = _revision(
            tag_line="1girl",
            natural_text="hi",
            tag_changes=[{"tag": "1girl", "change": "added"}],
            natural_text_change={"change": "added"},
        )

        for current in ("", "   "):
            with self.subTest(current=repr(current)):
                result = describe_prompt_changes(output, current)

                self.assertEqual(result["tag_changes"], [])
                self.assertEqual(
                    result["natural_text_change"],
                    {"change": "unchanged"},
                )


class BuildTagConfidenceBlocksTest(unittest.TestCase):
    """#407: 件数上限の代わりにブロックごとの確信度一覧を組み立てる関数のテスト。"""

    def test_tag_without_declared_confidence_defaults_to_one(self) -> None:
        # revise_current_promptが戻したタグや補ったratingタグはtag_confidencesに無い。
        data = _revision(subject_tags=["1girl"], tag_confidences=[])

        blocks = build_tag_confidence_blocks(data)

        self.assertEqual(
            blocks["subject_tags"],
            [{"tag": "1girl", "confidence": 1.0, "ja": ""}],
        )

    def test_declared_confidence_is_used(self) -> None:
        data = _revision(
            subject_tags=["1girl"],
            tag_confidences=[
                {"tag": "1girl", "field": "subject_tags", "confidence": 0.4}
            ],
        )

        blocks = build_tag_confidence_blocks(data)

        self.assertEqual(
            blocks["subject_tags"],
            [{"tag": "1girl", "confidence": 0.4, "ja": ""}],
        )

    def test_tags_in_block_sort_by_confidence_descending(self) -> None:
        data = _revision(
            general_tags=["low", "high", "mid"],
            tag_confidences=[
                {"tag": "low", "field": "general_tags", "confidence": 0.1},
                {"tag": "high", "field": "general_tags", "confidence": 0.9},
                {"tag": "mid", "field": "general_tags", "confidence": 0.5},
            ],
        )

        blocks = build_tag_confidence_blocks(data)

        self.assertEqual(
            [item["tag"] for item in blocks["general_tags"]],
            ["high", "mid", "low"],
        )

    def test_gloss_is_attached_from_tag_glosses(self) -> None:
        data = _revision(
            general_tags=["safelight"],
            tag_glosses=[{"tag": "safelight", "ja": "セーフライト"}],
        )

        blocks = build_tag_confidence_blocks(data)

        self.assertEqual(blocks["general_tags"][0]["ja"], "セーフライト")

    def test_blocks_cover_all_tag_block_fields_in_order(self) -> None:
        data = _revision()

        blocks = build_tag_confidence_blocks(data)

        self.assertEqual(
            list(blocks.keys()),
            [
                "quality_tags",
                "subject_tags",
                "character_tags",
                "artist_tags",
                "general_tags",
            ],
        )


if __name__ == "__main__":
    unittest.main()
