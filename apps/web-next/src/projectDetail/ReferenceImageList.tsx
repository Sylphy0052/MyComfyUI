import { ActionIcon, Button, FileButton, Group, Paper, Stack, Text, Textarea, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowDown, IconArrowUp, IconGripVertical, IconTrash, IconUpload } from "@tabler/icons-react";
import { useEffect, useRef } from "react";

import { notifyError } from "../notifications";
import { artifactIdOf, MediaThumb } from "./MediaThumb";
import { moveItem, useDragReorder } from "./useDragReorder";
import { inputMediaKey, useArtifact, useUploadImageReference } from "./useStory";

/** `PATCH /artifacts/{id}`の`memo`の上限 (`ARTIFACT_MEMO_MAX_LENGTH`)。 */
const MEMO_MAX = 2_000;

/** 生成物ごとのメモの編集。保存済みの値と違うものだけを持つ (キーは生成物のID)。 */
export type MemoEdits = Record<string, string>;

function MemoField({
  artifactId,
  edit,
  onChange,
}: {
  artifactId: string;
  edit: string | undefined;
  onChange: (artifactId: string, value: string | null) => void;
}) {
  const artifact = useArtifact(artifactId);
  const saved = artifact.data?.memo ?? "";
  return (
    <Textarea
      size="xs"
      label="メモ (生成物のメモ。Viewerと共通)"
      autosize
      minRows={1}
      maxRows={4}
      maxLength={MEMO_MAX}
      disabled={!artifact.data}
      value={edit ?? saved}
      // 保存済みの値へ戻したら「編集なし」に戻し、未保存の判定に残さない。
      onChange={(event) => onChange(artifactId, event.currentTarget.value === saved ? null : event.currentTarget.value)}
    />
  );
}

/**
 * 衣装の参照画像。先頭が代表。アップロードで追加し、ドラッグか上下ボタンで並べ替え、外せる。
 * 並び順とメモの編集は呼び出し側 (保存ボタン) が確定する。
 */
export function ReferenceImageList({
  keys,
  onChange,
  memoEdits,
  onMemoChange,
  disabled,
}: {
  keys: string[];
  onChange: (keys: string[]) => void;
  memoEdits: MemoEdits;
  onMemoChange: (artifactId: string, value: string | null) => void;
  /** 並べ替えを止める。ボタンと入力は呼び出し側の`fieldset`で止める。 */
  disabled: boolean;
}) {
  const upload = useUploadImageReference();
  const { rowProps } = useDragReorder(keys, onChange, disabled);
  // アップロードの待ちの間に並べ替え・削除されても上書きしないよう、追加は最新の並びに足す。
  const latestKeys = useRef(keys);
  useEffect(() => {
    latestKeys.current = keys;
  }, [keys]);

  const addFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        const reference = await upload.mutateAsync(file);
        const key = inputMediaKey(reference.relative_path);
        if (latestKeys.current.includes(key)) {
          notifications.show({ color: "yellow", message: `${file.name}は既に追加されています` });
          continue;
        }
        latestKeys.current = [...latestKeys.current, key];
        onChange(latestKeys.current);
      } catch (error) {
        notifyError(`${file.name}を追加できません`, error);
      }
    }
  };

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text fw={500} size="sm">
          参照画像 ({keys.length}枚。先頭が代表)
        </Text>
        <FileButton accept="image/png,image/jpeg,image/webp" multiple onChange={addFiles}>
          {(props) => (
            <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />} loading={upload.isPending}>
              画像を追加
            </Button>
          )}
        </FileButton>
      </Group>
      {keys.length === 0 ? (
        <Text size="sm" c="dimmed">
          参照画像はありません。
        </Text>
      ) : null}
      {keys.map((key, index) => {
        const artifactId = artifactIdOf(key);
        return (
          <Paper
            key={key}
            withBorder
            p="xs"
            data-testid="reference-image"
            style={{ cursor: disabled ? undefined : "grab" }}
            {...rowProps(key)}
          >
            <Group wrap="nowrap" align="flex-start">
              <IconGripVertical size={18} style={{ flexShrink: 0, marginTop: 20 }} />
              <MediaThumb mediaKey={key} size={64} />
              <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                <Text size="xs" c="dimmed" truncate>
                  {index === 0 ? "代表 / " : ""}
                  {key}
                </Text>
                {/* inputのキーはArtifactを持たないので、メモを付ける先が無い。メモ欄は出さない。 */}
                {artifactId !== null ? (
                  <MemoField artifactId={artifactId} edit={memoEdits[artifactId]} onChange={onMemoChange} />
                ) : null}
              </Stack>
              <Group gap={2} wrap="nowrap">
                <Tooltip label="上へ">
                  <ActionIcon
                    variant="subtle"
                    aria-label="上へ"
                    disabled={index === 0}
                    onClick={() => onChange(moveItem(keys, index, index - 1))}
                  >
                    <IconArrowUp size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="下へ">
                  <ActionIcon
                    variant="subtle"
                    aria-label="下へ"
                    disabled={index === keys.length - 1}
                    onClick={() => onChange(moveItem(keys, index, index + 1))}
                  >
                    <IconArrowDown size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="外す">
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label="外す"
                    onClick={() => onChange(keys.filter((item) => item !== key))}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>
          </Paper>
        );
      })}
    </Stack>
  );
}
