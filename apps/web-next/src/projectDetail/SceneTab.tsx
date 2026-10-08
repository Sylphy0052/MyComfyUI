import { Alert, Button, Group, Loader, NavLink, Paper, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconGripVertical, IconPlus } from "@tabler/icons-react";
import { useEffect, useState } from "react";

import { notifyError } from "../notifications";
import { useReadOnly } from "./readOnly";
import { RefetchErrorAlert } from "./RefetchErrorAlert";
import { SceneEditor } from "./SceneEditor";
import { useRunGuarded } from "./unsavedGuard";
import { useDragReorder } from "./useDragReorder";
import { useReorderScenes, useScenes } from "./useStory";

const NEW = "new";

/** 左にシーンの一覧 (ドラッグで並べ替え)、右に選んだシーンの編集欄。 */
export function SceneTab({ projectId }: { projectId: string }) {
  const scenes = useScenes(projectId);
  const reorder = useReorderScenes(projectId);
  const runGuarded = useRunGuarded();
  const readOnly = useReadOnly();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = scenes.data ?? [];
  const { rowProps } = useDragReorder(
    list.map((scene) => scene.id),
    (ids) =>
      reorder.mutate(ids, {
        onError: (error) => notifyError("並べ替えを保存できません", error),
      }),
    readOnly,
  );

  // 選択は一覧のIDで持つ (初回は先頭)。選択中のシーンが他で削除されたら、通知して先頭へ移る。
  // 編集中の内容は保存先が無いので捨てる。
  const loaded = scenes.data;
  useEffect(() => {
    if (loaded === undefined || selectedId === NEW) return;
    if (selectedId !== null && loaded.some((item) => item.id === selectedId)) return;
    if (selectedId !== null) notifications.show({ color: "yellow", message: "選択中のシーンは削除されました" });
    setSelectedId(loaded[0]?.id ?? null);
  }, [loaded, selectedId]);

  if (scenes.isPending) return <Loader size="sm" />;
  // 取り直しの失敗では`data`が残る。そのときは編集欄を残し、エラーは右の欄の上に出す。
  if (loaded === undefined) return <Alert color="red">{scenes.error?.message}</Alert>;

  const isNew = selectedId === NEW;
  const current = isNew
    ? null
    : (list.find((item) => item.id === selectedId) ?? (selectedId === null ? list[0] : undefined) ?? null);

  return (
    <Group align="flex-start" wrap="nowrap" gap="lg">
      <Stack gap="xs" w={240} style={{ flexShrink: 0 }}>
        <Button
          leftSection={<IconPlus size={16} />}
          variant="light"
          disabled={readOnly}
          onClick={() => runGuarded(() => setSelectedId(NEW))}
        >
          シーンを追加
        </Button>
        {list.length === 0 && !isNew ? (
          <Text size="sm" c="dimmed">
            シーンはまだありません。
          </Text>
        ) : (
          <Text size="xs" c="dimmed">
            ドラッグで並べ替えられます。
          </Text>
        )}
        {isNew ? <NavLink active label="(新しいシーン)" /> : null}
        {list.map((scene) => (
          <div
            key={scene.id}
            data-testid="scene-item"
            style={{ cursor: readOnly ? undefined : "grab" }}
            {...rowProps(scene.id)}
          >
            <NavLink
              active={!isNew && scene.id === current?.id}
              label={scene.name}
              leftSection={<IconGripVertical size={16} />}
              onClick={() => runGuarded(() => setSelectedId(scene.id))}
            />
          </div>
        ))}
      </Stack>
      <Paper withBorder p="md" style={{ flex: 1, minWidth: 0 }}>
        <RefetchErrorAlert error={scenes.error} mb="sm" />
        {current || isNew ? (
          <SceneEditor key={current?.id ?? NEW} projectId={projectId} scene={current} onSaved={(saved) => setSelectedId(saved.id)} />
        ) : (
          <Text c="dimmed">左の「シーンを追加」から作成します。</Text>
        )}
      </Paper>
    </Group>
  );
}
