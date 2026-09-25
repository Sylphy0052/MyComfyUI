import unittest

from mycomfyui_api.adapters.agent.proposals import _warn_untranslated_rationale

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


if __name__ == "__main__":
    unittest.main()
