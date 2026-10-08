import { Alert, Badge, Button, Card, Group, Stack, Text, Title } from "@mantine/core";

import { artifactContentUrl, type StoryCharacter, type StorySceneDialogue } from "../api/client";
import { useSceneAdoptions } from "../projectDetail/useStory";

/** 台詞の一覧の上に出す案内。投入の結果や、飛ばした行を知らせる。 */
export type LineNotice = { color: "green" | "yellow"; text: string };

/** 話者のキャラ名。一覧に無いキャラ (削除済みなど) は`(不明)`。 */
export function speakerNameOf(characters: StoryCharacter[], characterId: string): string {
  return characters.find((character) => character.id === characterId)?.name ?? "(不明)";
}

/** 台詞の行の見出し。結果欄にも添え、どの行の音声かを示す。 */
export function lineLabel(index: number, speakerName: string): string {
  return `${index + 1}行目 ${speakerName}`;
}

/**
 * Sceneの台詞の一覧。行ごとに話者・台詞文・演技指示・採用済みの音声を出し、1行ずつ、または全行をまとめて投入できる。
 * 投入の中身は呼び出し側が組む。
 */
export function SceneLineList({
  projectId,
  sceneId,
  dialogues,
  characters,
  disabled,
  running,
  notice,
  onDismissNotice,
  onSubmitLine,
  onSubmitAll,
}: {
  projectId: string;
  sceneId: string;
  dialogues: StorySceneDialogue[];
  characters: StoryCharacter[];
  disabled: boolean;
  /** 「全行を投入」の途中。 */
  running: boolean;
  notice: LineNotice | null;
  onDismissNotice: () => void;
  onSubmitLine: (line: StorySceneDialogue, index: number) => void;
  onSubmitAll: () => void;
}) {
  const adoptions = useSceneAdoptions(projectId, sceneId);
  // 行IDの無い行は採用先に指定できないので、採用済みの音声も無い。
  const adoptedOf = (lineId: string | null | undefined) =>
    lineId
      ? (adoptions.data?.find((item) => item.slot === "voice" && item.dialogue_id === lineId) ?? null)
      : null;

  return (
    <Stack gap="xs" data-testid="scene-lines">
      <Group justify="space-between">
        <Title order={5}>台詞の一覧</Title>
        <Button
          size="xs"
          onClick={onSubmitAll}
          disabled={disabled || dialogues.length === 0}
          loading={running}
          data-testid="lines-submit-all"
        >
          全行を投入
        </Button>
      </Group>
      {notice !== null ? (
        <Alert color={notice.color} withCloseButton onClose={onDismissNotice} data-testid="lines-notice">
          {notice.text}
        </Alert>
      ) : null}
      {dialogues.length === 0 ? (
        <Text size="xs" c="dimmed">
          このSceneには台詞がありません。
        </Text>
      ) : null}
      {adoptions.isError ? (
        <Text size="xs" c="red" data-testid="lines-adoptions-error">
          採用の状況を取得できません: {adoptions.error.message}
        </Text>
      ) : null}
      {dialogues.map((line, index) => {
        const speaker = characters.find((character) => character.id === line.speaker_character_id) ?? null;
        const adopted = adoptedOf(line.id);
        return (
          <Card key={line.id ?? `index-${index}`} withBorder padding="xs" data-testid="scene-line" data-line-id={line.id ?? ""}>
            <Stack gap={4}>
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                  <Text size="xs" c="dimmed">
                    {index + 1}
                  </Text>
                  <Text size="sm" fw={500} data-testid="scene-line-speaker">
                    {speaker?.name ?? "(不明)"}
                  </Text>
                  {speaker?.voice_media_key ? null : (
                    <Badge size="xs" color="gray" data-testid="scene-line-no-voice">
                      声の参照なし
                    </Badge>
                  )}
                </Group>
                <Button
                  size="compact-xs"
                  variant="light"
                  onClick={() => onSubmitLine(line, index)}
                  disabled={disabled}
                  data-testid="scene-line-submit"
                >
                  投入
                </Button>
              </Group>
              <Text size="sm" data-testid="scene-line-text">
                {line.text}
              </Text>
              {line.direction.trim() !== "" ? (
                <Text size="xs" c="dimmed" data-testid="scene-line-direction">
                  演技指示: {line.direction}
                </Text>
              ) : null}
              {adopted !== null ? (
                <audio
                  controls
                  preload="none"
                  src={artifactContentUrl(adopted.artifact_id)}
                  style={{ width: "100%" }}
                  data-testid="scene-line-adopted"
                  data-artifact-id={adopted.artifact_id}
                />
              ) : null}
            </Stack>
          </Card>
        );
      })}
    </Stack>
  );
}
