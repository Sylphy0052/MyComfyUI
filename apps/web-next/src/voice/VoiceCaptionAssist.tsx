import { Button, SimpleGrid, Stack, Text } from "@mantine/core";

import type { VoiceCaptionAssist } from "../api/client";
import { AssistResultFrame } from "../promptAssist/AssistResultFrame";
import { INSTRUCTION_MAX, useInstructionAssist } from "../promptAssist/useInstructionAssist";

/**
 * 話者のキャラの性格・設定と演技指示から、声質の文章 (caption) の案を作る。結果は今のcaptionと並べて出し、「適用」でcaption欄を置き換える。
 * 依頼した後で演技指示か話者のキャラが変わった結果は適用させない。失敗してもcaption欄は変えない。
 */
export function VoiceCaptionAssistField({
  direction,
  storyCharacterId,
  caption,
  onApply,
}: {
  /** 演技指示の欄の値。 */
  direction: string;
  /** 話者に選んだキャラのID。未選択なら`null`で、要求に含めない。 */
  storyCharacterId: string | null;
  /** 今のcaption欄の値。 */
  caption: string;
  onApply: (caption: string) => void;
}) {
  const assist = useInstructionAssist<VoiceCaptionAssist>(
    "/voice-caption-assists",
    "声質の文章への変換に失敗しました",
    direction,
    storyCharacterId === null ? undefined : { story_character_id: storyCharacterId },
  );
  const result = assist.result;
  const directionEmpty = direction.trim() === "";

  return (
    <Stack gap="xs">
      <div>
        <Button
          size="xs"
          variant="light"
          disabled={!assist.canRun}
          loading={assist.isPending}
          onClick={assist.run}
          data-testid="voice-caption-assist-run"
        >
          演技指示から変換
        </Button>
      </div>
      {directionEmpty ? (
        <Text size="xs" c="dimmed" data-testid="voice-caption-assist-hint">
          演技指示を入れると変換できます。
        </Text>
      ) : assist.tooLong ? (
        <Text size="xs" c="dimmed" data-testid="voice-caption-assist-hint">
          演技指示が{INSTRUCTION_MAX}文字を超えているため変換できません。
        </Text>
      ) : null}
      {result ? (
        <AssistResultFrame
          testId="voice-caption-assist-diff"
          title="変換の結果"
          stale={assist.stale}
          staleMessage="依頼した後で演技指示か話者のキャラが変わりました。もう一度変換してください。"
          applyDisabled={result.caption.trim() === ""}
          onApply={() => {
            onApply(result.caption);
            assist.clear();
          }}
          onDiscard={assist.clear}
        >
          <SimpleGrid cols={caption.trim() === "" ? 1 : { base: 1, sm: 2 }} spacing="xs">
            {caption.trim() === "" ? null : (
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  今の声質の文章
                </Text>
                <Text size="sm" style={{ whiteSpace: "pre-wrap" }} data-testid="voice-caption-assist-current">
                  {caption}
                </Text>
              </Stack>
            )}
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                変換後
              </Text>
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }} data-testid="voice-caption-assist-result">
                {result.caption}
              </Text>
            </Stack>
          </SimpleGrid>
          {result.rationale ? (
            <Text size="xs" c="dimmed" data-testid="voice-caption-assist-rationale">
              {result.rationale}
            </Text>
          ) : null}
        </AssistResultFrame>
      ) : null}
    </Stack>
  );
}
