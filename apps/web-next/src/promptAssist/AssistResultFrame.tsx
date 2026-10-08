import { Button, Group, Paper, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

const DEFAULT_STALE_MESSAGE = "依頼した後で日本語の説明が変わりました。もう一度変換してください。";

/** 変換結果の枠。古い結果 (日本語欄が依頼後に変わった) は「適用」をdisabledにする。 */
export function AssistResultFrame({
  testId,
  title,
  stale,
  staleMessage = DEFAULT_STALE_MESSAGE,
  applyDisabled = false,
  onApply,
  onDiscard,
  children,
}: {
  testId: string;
  title: string;
  stale: boolean;
  /** 古い結果に出す文。既定は日本語欄だけを見る変換向けで、日本語欄以外の依頼項目も見る変換 (声質の文章) では差し替える。 */
  staleMessage?: string;
  /** 適用しても意味のない結果 (空) のとき。古さとは別に「適用」を止める。 */
  applyDisabled?: boolean;
  onApply: () => void;
  onDiscard: () => void;
  children: ReactNode;
}) {
  return (
    <Paper withBorder p="sm" data-testid={testId}>
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          {title}
        </Text>
        {children}
        {stale ? (
          <Text size="xs" c="yellow" data-testid="assist-stale">
            {staleMessage}
          </Text>
        ) : null}
        <Group gap="xs">
          <Button size="xs" disabled={stale || applyDisabled} onClick={onApply}>
            適用
          </Button>
          <Button size="xs" variant="default" onClick={onDiscard}>
            破棄
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
