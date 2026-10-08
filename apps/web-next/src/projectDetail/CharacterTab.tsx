import { Alert, Button, Group, Loader, NavLink, Paper, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlus } from "@tabler/icons-react";
import { useEffect, useState } from "react";

import type { StoryCostume } from "../api/client";
import { CharacterEditor } from "./CharacterEditor";
import { CostumeDrawer } from "./CostumeDrawer";
import { useReadOnly } from "./readOnly";
import { RefetchErrorAlert } from "./RefetchErrorAlert";
import { useRunGuarded } from "./unsavedGuard";
import { useCharacters } from "./useStory";

const NEW = "new";

/** 左にキャラクターの一覧、右に選んだキャラクターの編集欄。 */
export function CharacterTab({ projectId }: { projectId: string }) {
  const characters = useCharacters(projectId);
  const runGuarded = useRunGuarded();
  const readOnly = useReadOnly();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 衣装ドロワーの対象。`false`は閉じている、`null`は新規、それ以外は編集中の衣装のID。
  const [costumeTarget, setCostumeTarget] = useState<string | null | false>(false);

  const list = characters.data;
  const isNew = selectedId === NEW;
  const current =
    list === undefined || isNew
      ? null
      : (list.find((item) => item.id === selectedId) ?? (selectedId === null ? list[0] : undefined) ?? null);
  const costume = current && typeof costumeTarget === "string"
    ? (current.costumes.find((item) => item.id === costumeTarget) ?? null)
    : null;
  // ドロワーで開いている衣装が一覧から消えた (他で削除された)。新規のフォームへ化けないよう閉じる。
  const costumeGone = current !== null && typeof costumeTarget === "string" && costume === null;

  // 選択は一覧のIDで持つ (初回は先頭)。選択中のキャラクターが他で削除されたら、通知して先頭へ移る。
  // 編集中の内容は保存先が無いので捨てる。
  useEffect(() => {
    if (list === undefined || selectedId === NEW) return;
    if (selectedId !== null && list.some((item) => item.id === selectedId)) return;
    if (selectedId !== null) {
      notifications.show({ color: "yellow", message: "選択中のキャラクターは削除されました" });
      setCostumeTarget(false);
    }
    setSelectedId(list[0]?.id ?? null);
  }, [list, selectedId]);
  useEffect(() => {
    if (!costumeGone) return;
    notifications.show({ color: "yellow", message: "編集中の衣装は削除されました" });
    setCostumeTarget(false);
  }, [costumeGone]);

  if (characters.isPending) return <Loader size="sm" />;
  // 取り直しの失敗では`data`が残る。そのときは編集欄を残し、エラーは右の欄の上に出す。
  if (list === undefined) return <Alert color="red">{characters.error?.message}</Alert>;

  const select = (id: string) => runGuarded(() => setSelectedId(id));
  const openCostume = (target: StoryCostume | null) => setCostumeTarget(target?.id ?? null);

  return (
    <Group align="flex-start" wrap="nowrap" gap="lg">
      <Stack gap="xs" w={240} style={{ flexShrink: 0 }}>
        <Button
          leftSection={<IconPlus size={16} />}
          variant="light"
          disabled={readOnly}
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
        <RefetchErrorAlert error={characters.error} mb="sm" />
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
          opened={costumeTarget !== false && !costumeGone}
          projectId={projectId}
          character={current}
          costume={costume}
          onRequestClose={() => runGuarded(() => setCostumeTarget(false), "costume")}
          onCreated={(created) => setCostumeTarget(created.id)}
          onSaved={() => setCostumeTarget(false)}
        />
      ) : null}
    </Group>
  );
}
