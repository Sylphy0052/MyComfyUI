import { Alert, Button, Group, Stack, Text } from "@mantine/core";

import { stepLabel } from "./steps";
import type { RunAllState } from "./useRunAll";

/**
 * 「残りを一括実行」の操作と結果。実行中は「中止」を出し、止まったら止まった工程と理由を、続けた上での知らせを出す。
 * 工程ごとの進み具合は左のステッパーに出す。
 */
export function RunAllBar({
  state,
  disabled,
  onStart,
  onStop,
}: {
  state: RunAllState;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const running = state.phase === "running";
  return (
    <Stack gap="xs" data-testid="run-all" data-phase={state.phase}>
      <Group gap="sm">
        <Button
          size="xs"
          onClick={onStart}
          disabled={disabled || running}
          loading={running}
          data-testid="run-all-start"
        >
          残りを一括実行
        </Button>
        {running ? (
          <Button size="xs" color="red" variant="light" onClick={onStop} data-testid="run-all-stop">
            中止
          </Button>
        ) : null}
        <Text size="xs" c="dimmed">
          採用済みの工程を飛ばし、残りを順に生成して最初の候補を採用します。この画面を閉じると止まります。
        </Text>
      </Group>
      {state.phase === "failed" ? (
        <Alert color="red" title="一括実行が止まりました" data-testid="run-all-failed" data-step={state.failedStep ?? ""}>
          {state.failedStep ? `${stepLabel(state.failedStep)}で止まりました: ` : ""}
          {state.message}
        </Alert>
      ) : null}
      {state.phase === "aborted" ? (
        <Alert color="yellow" data-testid="run-all-aborted">
          {state.message}
        </Alert>
      ) : null}
      {state.phase === "completed" ? (
        <Alert color="green" data-testid="run-all-completed">
          残りの工程を最後まで実行しました。
        </Alert>
      ) : null}
      {state.notices.length > 0 ? (
        <Alert color="yellow" title="飛ばしたもの" data-testid="run-all-notices">
          <Stack gap={2}>
            {state.notices.map((text) => (
              <Text size="sm" key={text} data-testid="run-all-notice">
                {text}
              </Text>
            ))}
          </Stack>
        </Alert>
      ) : null}
    </Stack>
  );
}
