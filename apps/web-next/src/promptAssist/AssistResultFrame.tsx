import { Button, Group, Paper, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

/** 変換結果の枠。古い結果 (日本語欄が依頼後に変わった) は「適用」をdisabledにする。 */
export function AssistResultFrame({
  testId,
  title,
  stale,
  onApply,
  onDiscard,
  children,
}: {
  testId: string;
  title: string;
  stale: boolean;
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
            依頼した後で日本語の説明が変わりました。もう一度変換してください。
          </Text>
        ) : null}
        <Group gap="xs">
          <Button size="xs" disabled={stale} onClick={onApply}>
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
