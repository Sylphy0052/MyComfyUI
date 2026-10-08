import { Alert, Button, Group, Loader, Modal, Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";

import type { MediaItem } from "../api/client";
import { notifyError } from "../notifications";
import { LinkSelects } from "./LinkSelects";
import { MediaGrid, type GridItem } from "./MediaGrid";
import {
  useApplyLinks,
  useBatchOperation,
  useRejectedArtifactIds,
  useViewerImages,
  type SelectedArtifact,
} from "./useViewer";
import { mediaItemsQuery, NO_LINKS, type StoryLinks, type ViewerFilters } from "./viewerFilters";

function toSelected(item: MediaItem): SelectedArtifact {
  return { id: item.artifact_id as string, projectId: item.assigned_project_id ?? null };
}

function toGridItem(item: MediaItem): GridItem {
  return { id: item.artifact_id as string, kind: item.kind, decision: item.decision ?? null, createdAt: item.created_at };
}

/** 選んだ生成物へ同じ紐づけを付ける。Projectを空にすると紐づけを外す。 */
function BulkLinkModal({
  opened,
  items,
  onClose,
  onDone,
}: {
  opened: boolean;
  items: SelectedArtifact[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [links, setLinks] = useState<StoryLinks>(NO_LINKS);
  const apply = useApplyLinks();
  const submit = () =>
    apply.mutate(
      { items, links },
      {
        onSuccess: () => {
          notifications.show({
            color: "green",
            message: links.project ? `${items.length}件を紐づけました` : `${items.length}件の紐づけを外しました`,
          });
          onDone();
        },
        onError: (error) => notifyError("紐づけを変更できません。一部だけ変わっていることがあります", error),
      },
    );
  return (
    <Modal opened={opened} onClose={onClose} title={`${items.length}件を紐づける`}>
      <Stack>
        <SimpleGrid cols={2} spacing="xs">
          <LinkSelects value={links} onChange={setLinks} disabled={apply.isPending} />
        </SimpleGrid>
        <Text size="xs" c="dimmed">
          選んだ生成物の紐づけを、ここで選んだものに置き換えます。Projectを選ばなければ紐づけを外します。
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            キャンセル
          </Button>
          <Button onClick={submit} loading={apply.isPending}>
            {links.project ? "紐づける" : "紐づけを外す"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** 今のフィルタに合う不採用だけをゴミ箱へ移す。開いたときに対象を数え直し、件数を確かめてから移す。 */
function TrashRejectedModal({
  opened,
  filters,
  onClose,
}: {
  opened: boolean;
  filters: ViewerFilters;
  onClose: () => void;
}) {
  // 採否で「採用」「未判定」に絞っているときは、合う不採用は無い。
  const excluded = filters.decision !== null && filters.decision !== "rejected";
  const rejected = useRejectedArtifactIds(mediaItemsQuery(filters, { decision: "rejected" }), opened && !excluded);
  const trash = useBatchOperation();
  const ids = excluded ? [] : (rejected.data ?? []);
  const submit = () =>
    trash.mutate(
      { ids, operation: "trash" },
      {
        onSuccess: () => {
          notifications.show({ message: `不採用${ids.length}件をゴミ箱へ移しました` });
          onClose();
        },
        onError: (error) => notifyError("ゴミ箱へ移せません。一部だけ移っていることがあります", error),
      },
    );
  return (
    <Modal opened={opened} onClose={onClose} title="不採用をまとめてゴミ箱へ">
      <Stack>
        {rejected.isFetching ? <Loader size="sm" /> : null}
        {rejected.error ? <Alert color="red">対象を数えられません: {rejected.error.message}</Alert> : null}
        {excluded || (rejected.data && !rejected.isFetching) ? (
          <Text size="sm" data-testid="trash-rejected-count">
            今の絞り込みに合う不採用は{ids.length}件です。
            {ids.length > 0 ? "ゴミ箱へ移します (ゴミ箱タブで復元できます)。" : ""}
          </Text>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            color="red"
            onClick={submit}
            loading={trash.isPending}
            disabled={(!excluded && (!rejected.data || rejected.isFetching)) || ids.length === 0}
          >
            ゴミ箱へ移す
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** 画像タブ。フィルタが変わったら選択も含めて作り直す (呼び出し側で`key`を変える)。 */
export function ImageTab({ filters, onOpen }: { filters: ViewerFilters; onOpen: (artifactId: string) => void }) {
  const list = useViewerImages(mediaItemsQuery(filters));
  const [selected, setSelected] = useState<Map<string, SelectedArtifact>>(() => new Map());
  const [linkOpened, setLinkOpened] = useState(false);
  const [trashRejectedOpened, setTrashRejectedOpened] = useState(false);
  const trash = useBatchOperation();
  const items = list.data ?? [];

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(id)) next.delete(id);
      else {
        const item = items.find((entry) => entry.artifact_id === id);
        if (item) next.set(id, toSelected(item));
      }
      return next;
    });
  const selectAllLoaded = () => setSelected(new Map(items.map((item) => [item.artifact_id as string, toSelected(item)])));
  const clearSelection = () => setSelected(new Map());
  const selectedItems = [...selected.values()];

  const trashSelected = () =>
    trash.mutate(
      { ids: selectedItems.map((item) => item.id), operation: "trash" },
      {
        onSuccess: () => {
          notifications.show({ message: `${selectedItems.length}件をゴミ箱へ移しました` });
          clearSelection();
        },
        onError: (error) => notifyError("ゴミ箱へ移せません。一部だけ移っていることがあります", error),
      },
    );

  return (
    <Stack gap="sm">
      <Paper withBorder p="xs">
        <Group justify="space-between" gap="xs">
          <Group gap="xs">
            <Text size="sm" data-testid="selected-count">
              {selected.size}件を選択中
            </Text>
            <Button size="xs" variant="default" onClick={selectAllLoaded} disabled={items.length === 0}>
              表示中をすべて選択 ({items.length}件)
            </Button>
            <Button size="xs" variant="default" onClick={clearSelection} disabled={selected.size === 0}>
              選択を解除
            </Button>
            <Button size="xs" onClick={() => setLinkOpened(true)} disabled={selected.size === 0}>
              紐づけ
            </Button>
            <Button
              size="xs"
              color="red"
              variant="light"
              onClick={trashSelected}
              loading={trash.isPending}
              disabled={selected.size === 0}
            >
              ゴミ箱へ移す
            </Button>
          </Group>
          <Button size="xs" color="red" variant="subtle" onClick={() => setTrashRejectedOpened(true)}>
            不採用をまとめてゴミ箱へ
          </Button>
        </Group>
      </Paper>
      {list.isPending ? <Loader size="sm" /> : null}
      {list.error ? <Alert color="red" title="生成物を取得できません">{list.error.message}</Alert> : null}
      {list.data ? (
        <MediaGrid
          items={items.map(toGridItem)}
          selected={new Set(selected.keys())}
          onToggle={toggle}
          onOpen={onOpen}
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          empty={<Text c="dimmed">条件に合う画像はありません</Text>}
        />
      ) : null}
      {/* 開くたびに選択欄を空から始めるため、閉じている間は中身を作らない。 */}
      {linkOpened ? (
        <BulkLinkModal
          opened
          items={selectedItems}
          onClose={() => setLinkOpened(false)}
          onDone={() => {
            setLinkOpened(false);
            clearSelection();
          }}
        />
      ) : null}
      <TrashRejectedModal
        opened={trashRejectedOpened}
        filters={filters}
        onClose={() => setTrashRejectedOpened(false)}
      />
    </Stack>
  );
}
