import { ActionIcon, Button, Group, Paper, Select, Stack, Text, Textarea, Title, Tooltip } from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from "@tabler/icons-react";

import type { StoryCharacter } from "../api/client";
import { TEXT_MAX } from "./CostumeDrawer";
import { emptyDialogue, type DialogueDraft } from "./sceneDraft";
import { moveItem } from "./useDragReorder";

/** 台詞の一覧。話者・台詞文・演技指示を持つ。既存の台詞のIDは編集しても保つ。 */
export function SceneDialogueField({
  dialogues,
  characters,
  defaultSpeakerId,
  onChange,
}: {
  dialogues: DialogueDraft[];
  characters: StoryCharacter[];
  /** 新しい台詞の話者の初期値。登場キャラの先頭、無ければキャラクターの先頭。 */
  defaultSpeakerId: string;
  onChange: (dialogues: DialogueDraft[]) => void;
}) {
  const patch = (uid: string, change: Partial<DialogueDraft>) =>
    onChange(dialogues.map((entry) => (entry.uid === uid ? { ...entry, ...change } : entry)));
  const speakers = characters.map((character) => ({ value: character.id, label: character.name }));

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Title order={5}>台詞</Title>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          disabled={characters.length === 0}
          onClick={() => onChange([...dialogues, emptyDialogue(defaultSpeakerId)])}
        >
          台詞を追加
        </Button>
      </Group>
      {dialogues.length === 0 ? (
        <Text size="sm" c="dimmed">
          台詞はありません。
        </Text>
      ) : null}
      {dialogues.map((entry, index) => (
        <Paper key={entry.uid} withBorder p="sm" data-testid="dialogue-entry">
          <Stack gap="xs">
            <Group align="flex-end" wrap="nowrap">
              <Select
                label="話者"
                allowDeselect={false}
                style={{ flex: 1 }}
                value={entry.speaker_character_id}
                data={speakers}
                onChange={(value) => value && patch(entry.uid, { speaker_character_id: value })}
              />
              <Tooltip label="上へ">
                <ActionIcon
                  variant="subtle"
                  size="lg"
                  aria-label="台詞を上へ"
                  disabled={index === 0}
                  onClick={() => onChange(moveItem(dialogues, index, index - 1))}
                >
                  <IconArrowUp size={16} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="下へ">
                <ActionIcon
                  variant="subtle"
                  size="lg"
                  aria-label="台詞を下へ"
                  disabled={index === dialogues.length - 1}
                  onClick={() => onChange(moveItem(dialogues, index, index + 1))}
                >
                  <IconArrowDown size={16} />
                </ActionIcon>
              </Tooltip>
              <ActionIcon
                variant="subtle"
                color="red"
                size="lg"
                aria-label="台詞を削除"
                onClick={() => onChange(dialogues.filter((item) => item.uid !== entry.uid))}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
            <Textarea
              label="台詞文"
              required
              autosize
              minRows={1}
              maxRows={6}
              maxLength={TEXT_MAX}
              value={entry.text}
              onChange={(event) => patch(entry.uid, { text: event.currentTarget.value })}
            />
            <Textarea
              label="演技指示"
              autosize
              minRows={1}
              maxRows={4}
              maxLength={TEXT_MAX}
              value={entry.direction}
              onChange={(event) => patch(entry.uid, { direction: event.currentTarget.value })}
            />
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
}
