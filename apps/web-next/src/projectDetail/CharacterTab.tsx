import { Alert, Button, Group, Loader, NavLink, Paper, Stack, Text } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useState } from "react";

import type { StoryCostume } from "../api/client";
import { CharacterEditor } from "./CharacterEditor";
import { CostumeDrawer } from "./CostumeDrawer";
import { useRunGuarded } from "./unsavedGuard";
import { useCharacters } from "./useStory";

const NEW = "new";

/** 左にキャラクターの一覧、右に選んだキャラクターの編集欄。 */
export function CharacterTab({ projectId }: { projectId: string }) {
  const characters = useCharacters(projectId);
  const runGuarded = useRunGuarded();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 衣装ドロワーの対象。`false`は閉じている、`null`は新規、それ以外は編集中の衣装のID。
  const [costumeTarget, setCostumeTarget] = useState<string | null | false>(false);

  if (characters.isPending) return <Loader size="sm" />;
  if (characters.error) return <Alert color="red">{characters.error.message}</Alert>;

  const list = characters.data;
  const isNew = selectedId === NEW;
  const current = isNew ? null : (list.find((item) => item.id === selectedId) ?? list[0] ?? null);
  const costume = current && typeof costumeTarget === "string"
    ? (current.costumes.find((item) => item.id === costumeTarget) ?? null)
    : null;

  const select = (id: string) => runGuarded(() => setSelectedId(id));
  const openCostume = (target: StoryCostume | null) => setCostumeTarget(target?.id ?? null);

  return (
    <Group align="flex-start" wrap="nowrap" gap="lg">
      <Stack gap="xs" w={240} style={{ flexShrink: 0 }}>
        <Button
          leftSection={<IconPlus size={16} />}
          variant="light"
          onClick={() => runGuarded(() => setSelectedId(NEW))}
        >
          キャラクターを追加
        </Button>
        {list.length === 0 && !isNew ? (
          <Text size="sm" c="dimmed">
            キャラクターはまだありません。
          </Text>
        ) : null}
        {isNew ? <NavLink active label="(新しいキャラクター)" /> : null}
        {list.map((item) => (
          <NavLink
            key={item.id}
            active={!isNew && item.id === current?.id}
            label={item.name}
            description={`衣装${item.costumes.length}着`}
            onClick={() => select(item.id)}
          />
        ))}
      </Stack>
      <Paper withBorder p="md" style={{ flex: 1, minWidth: 0 }}>
        {current || isNew ? (
          <CharacterEditor
            key={current?.id ?? NEW}
            projectId={projectId}
            character={current}
            onSaved={(saved) => setSelectedId(saved.id)}
            onOpenCostume={openCostume}
          />
        ) : (
          <Text c="dimmed">左の「キャラクターを追加」から作成します。</Text>
        )}
      </Paper>
      {current ? (
        <CostumeDrawer
          opened={costumeTarget !== false}
          projectId={projectId}
          character={current}
          costume={costume}
          onRequestClose={() => runGuarded(() => setCostumeTarget(false), "costume")}
          onSaved={() => setCostumeTarget(false)}
        />
      ) : null}
    </Group>
  );
}
