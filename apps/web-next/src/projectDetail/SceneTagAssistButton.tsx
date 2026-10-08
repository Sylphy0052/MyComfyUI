import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";

import { splitPrompt, tagKey, uniqueTags } from "../imageGen/promptTags";
import { useImagePromptAssist } from "../imageGen/usePromptAssist";
import { TAG_MAX, TAGS_MAX } from "./limits";

/** `ImagePromptAssistCreate.instruction`の上限。頭に付ける説明と日本語をつないだ全体をこの長さで切る。 */
const INSTRUCTION_MAX = 2000;

/**
 * 日本語の説明を、シーンの欄に入れるタグへ変換するボタン。結果は`onTags`で欄へ入れ、保存は既存の保存ボタンで行う。
 * 人物・品質・rating・絵師のタグは欄の用途に合わないため、一般タグのブロックに入ったものだけを使う。
 * 失敗しても日本語の欄とタグ欄は変えない。
 */
export function SceneTagAssistButton({
  subject,
  text,
  onTags,
}: {
  /** 変換する欄の名前 (背景、ポーズ、表情)。 */
  subject: string;
  text: string;
  onTags: (tags: string[]) => void;
}) {
  const assist = useImagePromptAssist(`${subject}のタグへの変換に失敗しました`);
  const prefix = `次の${subject}の説明だけを表す英語のタグにする。人物の人数、品質、rating、絵師のタグは出さない。説明: `;

  return (
    <Button
      size="compact-xs"
      variant="light"
      loading={assist.isPending}
      disabled={text.trim() === ""}
      onClick={() =>
        assist.mutate(
          { instruction: `${prefix}${text.trim()}`.slice(0, INSTRUCTION_MAX) },
          {
            onSuccess: (result) => {
              const general = new Set((result.tag_confidence_blocks?.general_tags ?? []).map((item) => tagKey(item.tag)));
              const tags = splitPrompt(result.tag_line.replaceAll("\n", ","))
                .filter((tag) => general.has(tagKey(tag)))
                .filter((tag) => tag.length <= TAG_MAX);
              if (tags.length === 0) {
                notifications.show({ color: "yellow", message: `${subject}のタグを得られませんでした。説明を変えて試してください` });
                return;
              }
              onTags(uniqueTags(tags).slice(0, TAGS_MAX));
            },
          },
        )
      }
    >
      日本語→タグ
    </Button>
  );
}
