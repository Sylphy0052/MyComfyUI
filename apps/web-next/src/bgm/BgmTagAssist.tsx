import { Badge, Button, Group, Stack, Text } from "@mantine/core";

import type { MusicPromptAssist } from "../api/client";
import { diffTags, splitPrompt, uniqueTags } from "../imageGen/promptTags";
import { AssistResultFrame } from "../promptAssist/AssistResultFrame";
import { INSTRUCTION_MAX, useInstructionAssist } from "../promptAssist/useInstructionAssist";

/** genreとmoodをカンマで分けて重複を除き、genre→moodの順につないだタグ欄の形にする。 */
export function suggestedBgmTags(result: Pick<MusicPromptAssist, "genre" | "mood">): string {
  return uniqueTags([...splitPrompt(result.genre), ...splitPrompt(result.mood)]).join(", ");
}

/**
 * 「雰囲気 (日本語)」欄を入力にして、タグ欄の案を作る。結果はタグ欄との差分で出し、「適用」でタグ欄だけを置き換える。
 * 失敗しても日本語欄とタグ欄は残す。
 */
export function BgmTagAssist({
  moodJa,
  tags,
  onApply,
}: {
  moodJa: string;
  tags: string;
  onApply: (tags: string) => void;
}) {
  const assist = useInstructionAssist<MusicPromptAssist>(
    "/music-prompt-assists",
    "タグへの変換に失敗しました",
    moodJa,
  );
  const result = assist.result;
  const suggestion = result ? suggestedBgmTags(result) : "";
  const diff = result ? diffTags(tags, suggestion) : [];

  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Button
          size="xs"
          variant="light"
          disabled={!assist.canRun}
          loading={assist.isPending}
          onClick={assist.run}
          data-testid="bgm-assist-run"
        >
          タグに変換
        </Button>
        {assist.tooLong ? (
          <Text size="xs" c="dimmed">
            {INSTRUCTION_MAX}文字を超えているため変換できません。
          </Text>
        ) : null}
      </Group>
      {result ? (
        <AssistResultFrame
          testId="bgm-assist-diff"
          title="変換の結果 (タグ欄との差分)"
          stale={assist.stale}
          onApply={() => {
            onApply(suggestion);
            assist.clear();
          }}
          onDiscard={assist.clear}
        >
          {diff.length === 0 ? (
            <Text size="xs" c="dimmed">
              タグ欄から変わる点はありません。
            </Text>
          ) : (
            <Group gap={4}>
              {diff.map((entry) => (
                <Badge
                  key={`${entry.kind}:${entry.tag}`}
                  variant={entry.kind === "same" ? "outline" : "light"}
                  color={entry.kind === "added" ? "green" : entry.kind === "removed" ? "red" : "gray"}
                  tt="none"
                  data-diff={entry.kind}
                  style={entry.kind === "removed" ? { textDecoration: "line-through" } : undefined}
                >
                  {entry.kind === "added" ? "+ " : entry.kind === "removed" ? "- " : ""}
                  {entry.tag}
                </Badge>
              ))}
            </Group>
          )}
          {result.rationale ? (
            <Text size="xs" c="dimmed">
              {result.rationale}
            </Text>
          ) : null}
        </AssistResultFrame>
      ) : null}
    </Stack>
  );
}
