import { Alert, Button, Group, Loader, NavLink, Paper, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconGripVertical, IconPlus } from "@tabler/icons-react";
import { useState } from "react";

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = scenes.data ?? [];
  const { rowProps } = useDragReorder(
    list.map((scene) => scene.id),
    (ids) =>
      reorder.mutate(ids, {
        onError: (error) => notifications.show({ color: "red", title: "並べ替えを保存できません", message: error.message }),
      }),
  );

  if (scenes.isPending) return <Loader size="sm" />;
  if (scenes.error) return <Alert color="red">{scenes.error.message}</Alert>;

  const isNew = selectedId === NEW;
  const current = isNew ? null : (list.find((item) => item.id === selectedId) ?? list[0] ?? null);

  return (
    <Group align="flex-start" wrap="nowrap" gap="lg">
      <Stack gap="xs" w={240} style={{ flexShrink: 0 }}>
        <Button
          leftSection={<IconPlus size={16} />}
          variant="light"
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
          <div key={scene.id} data-testid="scene-item" style={{ cursor: "grab" }} {...rowProps(scene.id)}>
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
        {current || isNew ? (
          <SceneEditor key={current?.id ?? NEW} projectId={projectId} scene={current} onSaved={(saved) => setSelectedId(saved.id)} />
        ) : (
          <Text c="dimmed">左の「シーンを追加」から作成します。</Text>
        )}
      </Paper>
    </Group>
  );
}
