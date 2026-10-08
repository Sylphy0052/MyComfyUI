import { Badge, Button, Group, Paper, Stack, Text, Textarea } from "@mantine/core";
import { useState } from "react";

import type { ImagePromptAssist } from "../api/client";
import { diffTags } from "./promptTags";
import { useImagePromptAssist } from "./usePromptAssist";

/** `ImagePromptAssistCreate.instruction`の上限。 */
const INSTRUCTION_MAX = 2000;
/** `ImagePromptAssistCreate.context_tags`の上限件数と、1件の上限文字数。 */
const CONTEXT_TAGS_MAX = 200;
const CONTEXT_TAG_MAX = 200;
/** `ImagePromptAssistCreate.current_positive_prompt`の上限。超えると「直す」は422になる。 */
const CURRENT_PROMPT_MAX = 4000;

/** `basis`は依頼した時点の入力。今の入力と違えば、結果は古い前提のものなので適用させない。 */
type Pending = { mode: "convert" | "revise"; result: ImagePromptAssist; basis: string };

/**
 * 日本語からプロンプトへの変換と「直す」。結果は自由欄との差分で出し、「適用」で自由欄だけを置き換える。
 * 補完タグとネガティブには触れない。失敗しても日本語欄と自由欄は残す。
 */
export function PromptAssistPanel({
  recipeId,
  contextTags,
  positiveFree,
  onApply,
}: {
  recipeId: string;
  /** 外していない補完タグ。LLMへ文脈として渡し、結果から重複を除かせる。 */
  contextTags: string[];
  positiveFree: string;
  onApply: (positive: string) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const assist = useImagePromptAssist("プロンプトの変換に失敗しました");

  const hasInstruction = instruction.trim() !== "";
  const freeTooLong = positiveFree.length > CURRENT_PROMPT_MAX;
  // 変換は自由欄を土台にしないので、自由欄の編集では古くならない
  const basisOf = (mode: Pending["mode"]) =>
    JSON.stringify([recipeId, contextTags, mode === "revise" ? positiveFree : null]);
  const run = (mode: Pending["mode"]) => {
    const basis = basisOf(mode);
    assist.mutate(
      {
        instruction: instruction.trim(),
        recipe_id: recipeId,
        current_positive_prompt: mode === "revise" ? positiveFree : "",
        context_tags: contextTags.filter((tag) => tag.length <= CONTEXT_TAG_MAX).slice(0, CONTEXT_TAGS_MAX),
      },
      { onSuccess: (result) => setPending({ mode, result, basis }) },
    );
  };

  const diff = pending ? diffTags(positiveFree, pending.result.positive_prompt) : [];
  const stale = pending !== null && pending.basis !== basisOf(pending.mode);

  return (
    <Stack gap="xs" data-testid="prompt-assist">
      <Textarea
        label="日本語で指示"
        description="「変換」で自由欄を日本語から作り直す。「直す」は自由欄を土台に、指示した点だけを直す"
        value={instruction}
        maxLength={INSTRUCTION_MAX}
        onChange={(event) => setInstruction(event.currentTarget.value)}
        autosize
        minRows={2}
        maxRows={6}
      />
      <Group gap="xs">
        <Button
          size="xs"
          variant="light"
          disabled={!hasInstruction || assist.isPending}
          loading={assist.isPending && assist.variables?.current_positive_prompt === ""}
          onClick={() => run("convert")}
        >
          変換
        </Button>
        <Button
          size="xs"
          variant="light"
          disabled={!hasInstruction || positiveFree.trim() === "" || freeTooLong || assist.isPending}
          loading={assist.isPending && assist.variables?.current_positive_prompt !== ""}
          onClick={() => run("revise")}
        >
          直す
        </Button>
      </Group>
      {freeTooLong ? (
        <Text size="xs" c="dimmed">
          自由欄が{CURRENT_PROMPT_MAX}文字を超えているため「直す」は使えません。
        </Text>
      ) : null}
      {pending ? (
        <Paper withBorder p="sm" data-testid="assist-diff">
          <Stack gap="xs">
            <Text size="sm" fw={500}>
              {pending.mode === "convert" ? "変換の結果 (自由欄との差分)" : "直した結果 (自由欄との差分)"}
            </Text>
            {diff.length === 0 ? (
              <Text size="xs" c="dimmed">
                自由欄から変わる点はありません。
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
            {pending.result.positive_prompt === "" ? (
              <Text size="xs" c="dimmed">
                提案のタグはすべて補完タグにあります。適用すると自由欄は空になります。
              </Text>
            ) : null}
            {stale ? (
              <Text size="xs" c="yellow">
                依頼した後でレシピ・補完タグ・自由欄が変わりました。もう一度実行してください。
              </Text>
            ) : null}
            <Group gap="xs">
              <Button
                size="xs"
                disabled={stale}
                onClick={() => {
                  onApply(pending.result.positive_prompt);
                  setPending(null);
                }}
              >
                適用
              </Button>
              <Button size="xs" variant="default" onClick={() => setPending(null)}>
                破棄
              </Button>
            </Group>
          </Stack>
        </Paper>
      ) : null}
    </Stack>
  );
}
