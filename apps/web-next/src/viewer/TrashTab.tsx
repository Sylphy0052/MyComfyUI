import { Alert, Button, Group, List, Loader, Modal, Paper, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";

import { MediaGrid } from "./MediaGrid";
import { useSelection } from "./useSelection";
import {
  BATCH_MAX,
  formatBytes,
  notifyBatchError,
  PartialFailureError,
  useBatchOperation,
  usePurge,
  usePurgePreview,
  useTrashedArtifacts,
} from "./useViewer";

/**
 * 完全削除の確認。開いたときに影響 (件数と空く容量) を確かめてから実行する。
 * 途中で失敗したら`onPartial`へ消えたIDと残ったIDを渡す。
 */
function PurgeModal({
  ids,
  onClose,
  onDone,
  onPartial,
}: {
  ids: string[];
  onClose: () => void;
  onDone: () => void;
  onPartial: (purgedIds: string[], remainingIds: string[]) => void;
}) {
  const preview = usePurgePreview(ids, true);
  const purge = usePurge();
  // 取り直しに失敗したら、前回の影響は今の状態と合わないので出さない。
  const summary = preview.error ? undefined : preview.data;
  const submit = () =>
    purge.mutate(ids, {
      onSuccess: (result) => {
        notifications.show({
          color: "green",
          message: `${result.purged}件を完全に削除しました (${formatBytes(result.removedByteSize)}空きました)`,
        });
        onDone();
      },
      onError: (error) => {
        notifyBatchError("完全に削除できません", error);
        if (error instanceof PartialFailureError) onPartial(error.doneIds, error.failedIds);
      },
    });
  return (
    <Modal opened onClose={onClose} title="完全に削除">
      <Stack>
        {preview.isPending ? <Loader size="sm" /> : null}
        {preview.error ? <Alert color="red">影響を確かめられません: {preview.error.message}</Alert> : null}
        {summary ? (
          <Stack gap="xs" data-testid="purge-summary">
            <Text size="sm">
              {summary.count}件を完全に削除します。空く容量は{formatBytes(summary.removedByteSize)} (ファイル
              {summary.removedFileCount}個) です。この操作は取り消せません。
            </Text>
            <List size="xs" c="dimmed">
              {summary.sharedFileCount > 0 ? (
                <List.Item>ほかの生成物と共有しているファイル{summary.sharedFileCount}個は残ります。</List.Item>
              ) : null}
              {summary.detachedChildCount > 0 ? (
                <List.Item>この生成物から作った生成物{summary.detachedChildCount}件は、元との関係が外れます。</List.Item>
              ) : null}
              {ids.length > BATCH_MAX ? (
                <List.Item>
                  {BATCH_MAX}件ずつ確かめて合算しています。別の回に入った生成物同士でファイルを共有していると、空く容量は実際より少なく出ます。
                </List.Item>
              ) : null}
            </List>
            {summary.notTrashedIds.length > 0 ? (
              <Alert color="yellow">ゴミ箱に無い生成物が{summary.notTrashedIds.length}件含まれています。取り直してから選び直してください。</Alert>
            ) : null}
          </Stack>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            color="red"
            onClick={submit}
            loading={purge.isPending}
            // 影響の取り直し中は、表示した影響と実行時の対象がずれるので押させない。
            disabled={!summary || summary.notTrashedIds.length > 0 || preview.isFetching}
          >
            完全に削除
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** ゴミ箱タブ。選んだ生成物を復元するか、完全に削除する。 */
export function TrashTab({ onOpen }: { onOpen: (artifactId: string) => void }) {
  const list = useTrashedArtifacts();
  const [purgeIds, setPurgeIds] = useState<string[] | null>(null);
  const restore = useBatchOperation();
  const items = list.data ?? [];
  const selection = useSelection(items.map((item) => item.id));
  const { selected, clear: clearSelection } = selection;
  const restoreSelected = () =>
    restore.mutate(
      { ids: [...selected], operation: "restore" },
      {
        onSuccess: () => {
          notifications.show({ message: `${selected.size}件を復元しました` });
          clearSelection();
        },
        onError: (error) => notifyBatchError("復元できません", error),
      },
    );

  return (
    <Stack gap="sm">
      <Paper withBorder p="xs">
        <Group gap="xs">
          <Text size="sm" data-testid="selected-count">
            {selected.size}件を選択中
          </Text>
          <Button
            size="xs"
            variant="default"
            onClick={selection.selectAll}
            disabled={items.length === 0}
          >
            表示中をすべて選択 ({items.length}件)
          </Button>
          <Button size="xs" variant="default" onClick={clearSelection} disabled={selected.size === 0}>
            選択を解除
          </Button>
          <Button size="xs" onClick={restoreSelected} loading={restore.isPending} disabled={selected.size === 0}>
            復元
          </Button>
          <Button
            size="xs"
            color="red"
            variant="light"
            onClick={() => setPurgeIds([...selected])}
            disabled={selected.size === 0}
          >
            完全に削除
          </Button>
        </Group>
      </Paper>
      {list.isPending ? <Loader size="sm" /> : null}
      {list.error ? <Alert color="red" title="ゴミ箱を取得できません">{list.error.message}</Alert> : null}
      {list.data ? (
        <MediaGrid
          items={items.map((item) => ({
            id: item.id,
            kind: item.kind,
            decision: item.decision,
            createdAt: item.created_at,
          }))}
          selected={selected}
          onToggle={selection.toggle}
          onOpen={onOpen}
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          empty={<Text c="dimmed">ゴミ箱は空です</Text>}
        />
      ) : null}
      {purgeIds !== null ? (
        <PurgeModal
          ids={purgeIds}
          onClose={() => setPurgeIds(null)}
          onDone={() => {
            setPurgeIds(null);
            clearSelection();
          }}
          onPartial={(purgedIds, remainingIds) => {
            selection.remove(purgedIds);
            setPurgeIds(remainingIds);
          }}
        />
      ) : null}
    </Stack>
  );
}
