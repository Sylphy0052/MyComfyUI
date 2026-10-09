import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";

import { notifyError } from "../notifications";
import { useReadOnly } from "./readOnly";
import { useLegacyLinkPreview, useRunLegacyLinks, type LegacyLinkResult } from "./useLegacyLinks";

function unmatchedText(result: LegacyLinkResult): string {
  const { scene_not_imported: notImported, shot_unknown: shotUnknown, project_ambiguous: ambiguous } = result.unmatched;
  const parts = [
    notImported > 0 ? `シーンが未取り込み${notImported}件` : null,
    shotUnknown > 0 ? `Shotの親のシーンが不明${shotUnknown}件` : null,
    ambiguous > 0 ? `Projectを決められない${ambiguous}件` : null,
  ].filter((part) => part !== null);
  return parts.join("、");
}

/**
 * 旧Shot・旧Sceneに紐づいた生成物を、取り込んだシーンへ付ける (#632)。
 * 付け替える対象が0件のときは何も出さない。件数を見せてから実行する。
 */
export function LegacyLinksPanel({ projectId }: { projectId: string }) {
  const readOnly = useReadOnly();
  const preview = useLegacyLinkPreview(projectId);
  const run = useRunLegacyLinks(projectId);

  if (preview.data === undefined) {
    return preview.isError ? (
      <Alert color="red" variant="light" py="xs" title="旧生成物の件数を取得できません">
        {preview.error.message}
      </Alert>
    ) : null;
  }
  const result = preview.data;
  if (result.linked === 0) return null;

  const unmatched = unmatchedText(result);
  const execute = () =>
    run.mutate(undefined, {
      onSuccess: (done) =>
        notifications.show(
          done.linked === 0
            ? { color: "yellow", message: "付ける対象がありませんでした。すでに別の操作で付いています" }
            : {
                color: "green",
                message: `旧生成物${done.linked}件をシーンへ付けました${done.project_filled > 0 ? ` (うちProjectも設定${done.project_filled}件)` : ""}`,
              },
        ),
      onError: (error) => notifyError("旧生成物をシーンへ付けられませんでした", error),
    });
  return (
    <Alert color="blue" variant="light" title="旧生成物をシーンへ付けられます" data-testid="legacy-links-panel">
      <Stack gap="xs">
        <Text size="sm">
          旧Shot・旧Sceneに紐づいた生成物{result.linked}件を、取り込み済みのシーンへ付けます。付けると、Viewerとシーン生成画面から採用できます。
          {result.project_filled > 0 ? `うち${result.project_filled}件はProjectも設定します。` : ""}
        </Text>
        {unmatched ? (
          <Text size="xs" c="dimmed">
            付けない生成物: {unmatched}
          </Text>
        ) : null}
        <Group>
          <Button size="xs" loading={run.isPending} disabled={readOnly} onClick={execute}>
            旧生成物をシーンへ付ける
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}
