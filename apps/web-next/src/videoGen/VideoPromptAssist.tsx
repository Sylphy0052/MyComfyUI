import { Button, SimpleGrid, Stack, Text, Textarea } from "@mantine/core";
import { useState } from "react";

import type { VideoPromptAssist } from "../api/client";
import { AssistResultFrame } from "../promptAssist/AssistResultFrame";
import { INSTRUCTION_MAX, useInstructionAssist } from "../promptAssist/useInstructionAssist";

/**
 * 日本語の説明から動画のプロンプト (文章) を作る。結果は今のプロンプトと並べて出し、「適用」でプロンプト欄を置き換える。
 * 失敗しても日本語欄とプロンプト欄は残す。
 */
export function VideoPromptAssistField({ prompt, onApply }: { prompt: string; onApply: (prompt: string) => void }) {
  const [instruction, setInstruction] = useState("");
  const assist = useInstructionAssist<VideoPromptAssist>(
    "/video-prompt-assists",
    "プロンプトの変換に失敗しました",
    instruction,
  );
  const result = assist.result;

  return (
    <Stack gap="xs">
      <Textarea
        label="日本語で説明"
        description="「変換」で動画のプロンプトの案を作る。結果を確かめてから適用する"
        autosize
        minRows={2}
        maxRows={6}
        value={instruction}
        onChange={(event) => setInstruction(event.currentTarget.value)}
        data-testid="video-assist-instruction"
      />
      {assist.tooLong ? (
        <Text size="xs" c="dimmed">
          {INSTRUCTION_MAX}文字を超えているため変換できません。
        </Text>
      ) : null}
      <div>
        <Button
          size="xs"
          variant="light"
          disabled={!assist.canRun}
          loading={assist.isPending}
          onClick={assist.run}
          data-testid="video-assist-run"
        >
          変換
        </Button>
      </div>
      {result ? (
        <AssistResultFrame
          testId="video-assist-diff"
          title="変換の結果"
          stale={assist.stale}
          onApply={() => {
            onApply(result.prompt);
            assist.clear();
          }}
          onDiscard={assist.clear}
        >
          <SimpleGrid cols={prompt.trim() === "" ? 1 : { base: 1, sm: 2 }} spacing="xs">
            {prompt.trim() === "" ? null : (
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  今のプロンプト
                </Text>
                <Text size="sm" style={{ whiteSpace: "pre-wrap" }} data-testid="video-assist-current">
                  {prompt}
                </Text>
              </Stack>
            )}
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                変換後
              </Text>
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }} data-testid="video-assist-result">
                {result.prompt}
              </Text>
            </Stack>
          </SimpleGrid>
          {result.rationale ? (
            <Text size="xs" c="dimmed" data-testid="video-assist-rationale">
              {result.rationale}
            </Text>
          ) : null}
        </AssistResultFrame>
      ) : null}
    </Stack>
  );
}
