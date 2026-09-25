import unittest

from mycomfyui_api.adapters.agent.base import AgentInvalidResponse
from mycomfyui_api.adapters.agent.proposals import (
    MAX_CURRENT_TAG_WORDS,
    MAX_PROMPT_TAGS,
    _current_tags,
    _warn_untranslated_rationale,
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
        "removed_tags": [],
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

        message = str(raised.exception)
        self.assertIn(
            f"artist_tagsが{MAX_PROMPT_TAGS + 1}件 (うち現在のpromptから戻したタグ: "
            f"{MAX_PROMPT_TAGS + 1}件)",
            message,
        )
        self.assertIn(
            f"general_tagsが{MAX_PROMPT_TAGS + 2}件 (うち現在のpromptから戻したタグ: 0件)",
            message,
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

    def test_sentence_listed_in_removed_tags_is_not_reported(self) -> None:
        current = f"1girl, smile, {SENTENCE}"
        output = _revision(
            subject_tags=["1girl"], general_tags=["smile"], removed_tags=[SENTENCE]
        )

        with self.assertNoLogs(LOGGER_NAME, level="WARNING"):
            revise_current_prompt(output, current, "")


if __name__ == "__main__":
    unittest.main()
