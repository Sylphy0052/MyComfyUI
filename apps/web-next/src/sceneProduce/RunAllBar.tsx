import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";

import { stepLabel } from "./steps";
import type { RunAllState } from "./useRunAll";

/** 経過時間の表示 (例: `3分12秒`、1分未満は`45秒`)。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

/** `startedAt`からの経過ミリ秒を、`startedAt`がある間1秒ごとに更新して返す。 */
function useElapsedMs(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : now - startedAt;
}

/**
 * 「残りを一括実行」の操作と結果。実行中は「中止」と実行中の工程の経過時間を出す。
 * 止まったら止まった工程と理由を、続けた上での知らせを出す。工程ごとの進み具合は左のステッパーに出す。
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
  const elapsedMs = useElapsedMs(state.startedAt);
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
      {running && state.current !== null ? (
        <Text size="sm" data-testid="run-all-elapsed">
          {stepLabel(state.current)}を実行中 ({formatElapsed(elapsedMs)})
        </Text>
      ) : null}
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
        <Alert color="yellow" title="お知らせ" data-testid="run-all-notices">
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
