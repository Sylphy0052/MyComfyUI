import { Alert, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { useEffect } from "react";

import type { StoryImportResult } from "../api/client";
import { StoryImportCounts } from "./StoryImportPreview";
import { useReportPending, useRunStoryImport, useStoryImportPreview } from "./useStoryImport";

/**
 * 1つのProjectについて、作る件数のプレビューを出し、「取り込む」で実行する。
 * 実行中は`onPendingChange`で親へ知らせ、親はモーダルを閉じられないようにする (閉じるとmutate単位の完了処理が失われるため)。
 * 失敗はAPIの文言をそのまま画面内に出す。開くたびにプレビューを取り直すため、モーダルを閉じている間は描画しない。
 */
export function StoryImportRunner({
  projectId,
  projectName,
  onBack,
  onClose,
  onPendingChange,
  onImported,
}: {
  projectId: string;
  projectName: string;
  /** 候補一覧へ戻る。再取り込みでは渡さない。 */
  onBack?: () => void;
  onClose: () => void;
  /** 取り込みの実行中かどうかを親へ知らせる。 */
  onPendingChange: (pending: boolean) => void;
  onImported: (result: StoryImportResult) => void;
}) {
  const preview = useStoryImportPreview();
  const run = useRunStoryImport();
  const { mutate: loadPreview } = preview;
  useReportPending(run.isPending, onPendingChange);

  useEffect(() => {
    loadPreview(projectId);
  }, [projectId, loadPreview]);

  const execute = () => run.mutate(projectId, { onSuccess: onImported });

  return (
    <Stack>
      <Text size="sm">
        「{projectName}」に、novel-writerからまだ無いキャラクター・衣装・シーンを足します。取り込み済みの行は変えません。
      </Text>
      {preview.isPending || preview.isIdle ? <Loader size="sm" /> : null}
      {preview.error ? (
        <Alert color="red" title="プレビューを取得できません" data-testid="story-import-error">
          {preview.error.message}
        </Alert>
      ) : null}
      {preview.data ? <StoryImportCounts result={preview.data} /> : null}
      {run.error ? (
        <Alert color="red" title="取り込めません" data-testid="story-import-error">
          {run.error.message}
        </Alert>
      ) : null}
      <Group justify="flex-end">
        {onBack ? (
          <Button variant="default" onClick={onBack} disabled={run.isPending}>
            候補へ戻る
          </Button>
        ) : null}
        <Button variant="default" onClick={onClose} disabled={run.isPending}>
          キャンセル
        </Button>
        {preview.error ? (
          <Button variant="light" onClick={() => loadPreview(projectId)}>
            プレビューをやり直す
          </Button>
        ) : null}
        <Button onClick={execute} loading={run.isPending} disabled={preview.data === undefined}>
          取り込む
        </Button>
      </Group>
    </Stack>
  );
}
