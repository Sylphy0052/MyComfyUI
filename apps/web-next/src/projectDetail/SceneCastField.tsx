import { ActionIcon, Button, Group, Paper, Select, SimpleGrid, Stack, TagsInput, Text, Textarea, Title } from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";

import type { StoryCharacter } from "../api/client";
import { TAG_MAX, TAGS_MAX, TEXT_MAX } from "./CostumeDrawer";
import { emptyCast, type CastDraft } from "./sceneDraft";

/** 登場キャラ。衣装は、選んだキャラの衣装だけから選べる。 */
export function SceneCastField({
  cast,
  characters,
  onChange,
}: {
  cast: CastDraft[];
  characters: StoryCharacter[];
  onChange: (cast: CastDraft[]) => void;
}) {
  const used = new Set(cast.map((entry) => entry.character_id));
  const unused = characters.filter((character) => !used.has(character.id));
  const patch = (uid: string, change: Partial<CastDraft>) =>
    onChange(cast.map((entry) => (entry.uid === uid ? { ...entry, ...change } : entry)));

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Title order={5}>登場キャラ</Title>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          disabled={unused.length === 0}
          onClick={() => unused[0] && onChange([...cast, emptyCast(unused[0].id)])}
        >
          登場キャラを追加
        </Button>
      </Group>
      {characters.length === 0 ? (
        <Text size="sm" c="dimmed">
          キャラクタータブでキャラクターを作ると、ここで選べます。
        </Text>
      ) : null}
      {cast.map((entry) => {
        const character = characters.find((item) => item.id === entry.character_id);
        return (
          <Paper key={entry.uid} withBorder p="sm" data-testid="cast-entry">
            <Stack gap="xs">
              <Group align="flex-end" wrap="nowrap">
                <Select
                  label="キャラ"
                  allowDeselect={false}
                  style={{ flex: 1 }}
                  value={entry.character_id}
                  data={characters
                    .filter((item) => item.id === entry.character_id || !used.has(item.id))
                    .map((item) => ({ value: item.id, label: item.name }))}
                  // キャラを替えたら、前のキャラの衣装は選べないので外す。
                  onChange={(value) => value && patch(entry.uid, { character_id: value, costume_id: null })}
                />
                <Select
                  label="衣装"
                  placeholder="指定なし"
                  clearable
                  style={{ flex: 1 }}
                  value={entry.costume_id}
                  data={(character?.costumes ?? []).map((costume) => ({ value: costume.id, label: costume.name }))}
                  onChange={(value) => patch(entry.uid, { costume_id: value })}
                />
                <ActionIcon
                  variant="subtle"
                  color="red"
                  size="lg"
                  aria-label="登場キャラを外す"
                  onClick={() => onChange(cast.filter((item) => item.uid !== entry.uid))}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
              <SimpleGrid cols={{ base: 1, md: 2 }}>
                <Stack gap="xs">
                  <Textarea
                    label="ポーズ"
                    autosize
                    minRows={1}
                    maxLength={TEXT_MAX}
                    value={entry.pose_text}
                    onChange={(event) => patch(entry.uid, { pose_text: event.currentTarget.value })}
                  />
                  <TagsInput
                    label="ポーズのタグ"
                    value={entry.pose_tags}
                    maxTags={TAGS_MAX}
                    maxLength={TAG_MAX}
                    onChange={(pose_tags) => patch(entry.uid, { pose_tags })}
                  />
                </Stack>
                <Stack gap="xs">
                  <Textarea
                    label="表情"
                    autosize
                    minRows={1}
                    maxLength={TEXT_MAX}
                    value={entry.expression_text}
                    onChange={(event) => patch(entry.uid, { expression_text: event.currentTarget.value })}
                  />
                  <TagsInput
                    label="表情のタグ"
                    value={entry.expression_tags}
                    maxTags={TAGS_MAX}
                    maxLength={TAG_MAX}
                    onChange={(expression_tags) => patch(entry.uid, { expression_tags })}
                  />
                </Stack>
              </SimpleGrid>
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}
