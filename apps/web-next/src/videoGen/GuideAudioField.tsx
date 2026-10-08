import { Button, FileButton, Group, ScrollArea, Stack, Text } from "@mantine/core";

import { artifactContentUrl, type Recipe, type StoryCharacter, type StoryScene } from "../api/client";
import { acceptsInput } from "../imageGen/imageForm";
import { notifyError } from "../notifications";
import { useSceneAdoptions } from "../projectDetail/useStory";
import { speakerNameOf } from "../voice/SceneLineList";
import { useImportVoiceReference } from "../voice/useVoice";
import { useRecentVoiceAudio } from "./useVideoGen";
import type { GuideAudio } from "./videoForm";

/** 台詞文を候補の見出しに使うときの長さ。 */
const LABEL_TEXT_MAX = 40;

type Candidate = { artifactId: string; label: string };

/** Sceneの台詞の行に採用済みの音声。採用の枠 (slot) が`voice`のものだけで、BGMは入らない。 */
function useSceneVoiceCandidates(projectId: string | null, scene: StoryScene | null, characters: StoryCharacter[]): Candidate[] {
  const adoptions = useSceneAdoptions(projectId ?? "", projectId === null ? null : (scene?.id ?? null));
  if (scene === null) return [];
  return (adoptions.data ?? []).flatMap((adoption): Candidate[] => {
    if (adoption.slot !== "voice" || adoption.dialogue_id === null) return [];
    const index = scene.dialogues.findIndex((line) => line.id === adoption.dialogue_id);
    const line = scene.dialogues[index];
    if (line === undefined) return [];
    const text = line.text.length > LABEL_TEXT_MAX ? `${line.text.slice(0, LABEL_TEXT_MAX)}…` : line.text;
    return [{ artifactId: adoption.artifact_id, label: `${index + 1}行目 ${speakerNameOf(characters, line.speaker_character_id)}: ${text}` }];
  });
}

function sameArtifact(audio: GuideAudio | null, artifactId: string): boolean {
  return audio !== null && "artifact_id" in audio.ref && audio.ref.artifact_id === artifactId;
}

/**
 * 台詞音声 (guide_audio) を1本選ぶ欄。Sceneを選んでいればその台詞に採用した音声を、
 * そのほかに最近生成した台詞音声と、手元のwavのアップロードから選べる。選ぶと`audio_mode=external_voice`で投入する。
 * Recipeがguide_audioを受けないときは出さない。
 */
export function GuideAudioField({
  recipe,
  audio,
  onChange,
  projectId,
  scene,
  characters,
}: {
  recipe: Recipe | null;
  audio: GuideAudio | null;
  onChange: (audio: GuideAudio | null) => void;
  projectId: string | null;
  scene: StoryScene | null;
  characters: StoryCharacter[];
}) {
  const enabled = recipe !== null && acceptsInput(recipe, "guide_audio") && acceptsInput(recipe, "audio_mode");
  const sceneCandidates = useSceneVoiceCandidates(projectId, scene, characters);
  const recent = useRecentVoiceAudio(enabled);
  const upload = useImportVoiceReference();
  if (!enabled) return null;

  const recentCandidates = (recent.data ?? []).flatMap((item): Candidate[] =>
    item.artifact_id ? [{ artifactId: item.artifact_id, label: item.label ?? item.created_at.slice(0, 16).replace("T", " ") }] : [],
  );
  const pick = (candidate: Candidate) => onChange({ ref: { artifact_id: candidate.artifactId }, label: candidate.label });
  const list = (candidates: Candidate[], testId: string) => (
    <Stack gap={4} data-testid={testId}>
      {candidates.map((candidate) => (
        <Button
          key={candidate.artifactId}
          size="compact-xs"
          variant={sameArtifact(audio, candidate.artifactId) ? "filled" : "default"}
          justify="flex-start"
          onClick={() => pick(candidate)}
          data-testid="guide-audio-candidate"
        >
          {candidate.label}
        </Button>
      ))}
    </Stack>
  );

  return (
    <Stack gap="xs" data-testid="guide-audio-field">
      <Text size="sm" fw={500}>
        台詞音声 (任意)
      </Text>
      {audio !== null ? (
        <Group gap="sm" wrap="nowrap" data-testid="guide-audio-selected">
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              {audio.label}
            </Text>
            {"artifact_id" in audio.ref ? <audio controls preload="none" src={artifactContentUrl(audio.ref.artifact_id)} /> : null}
          </Stack>
          <Button size="compact-xs" variant="default" onClick={() => onChange(null)} data-testid="guide-audio-clear">
            外す
          </Button>
        </Group>
      ) : (
        <Text size="xs" c="dimmed">
          未選択です。選ぶと、この音声に合わせて動画を作ります。選ばなければ動画が音声も作ります。
        </Text>
      )}
      {sceneCandidates.length > 0 ? (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            Sceneの台詞に採用した音声
          </Text>
          {list(sceneCandidates, "guide-audio-scene-candidates")}
        </Stack>
      ) : null}
      {recentCandidates.length > 0 ? (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            最近生成した台詞音声
          </Text>
          <ScrollArea.Autosize mah={160}>{list(recentCandidates, "guide-audio-recent")}</ScrollArea.Autosize>
        </Stack>
      ) : null}
      <FileButton
        accept="audio/wav,audio/x-wav,.wav"
        onChange={(file) => {
          if (file === null) return;
          upload.importFile(
            file,
            (reference) => onChange({ ref: { relative_path: reference.relativePath, sha256: reference.sha256 }, label: reference.label }),
            (error) => notifyError("音声を取り込めませんでした", error),
          );
        }}
      >
        {(props) => (
          <Button {...props} size="compact-xs" variant="default" loading={upload.isPending} data-testid="guide-audio-upload">
            wavを取り込む
          </Button>
        )}
      </FileButton>
    </Stack>
  );
}
