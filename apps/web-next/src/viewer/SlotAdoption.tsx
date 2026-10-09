import { Badge, Button, Group, Loader, SegmentedControl, Select, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";

import type { ArtifactRecord, GenerationJob, StorySceneAdoption } from "../api/client";
import { useSlotDecision, type AdoptionSlot } from "../imageGen/useImageGen";
import { notifyError } from "../notifications";
import { useSceneAdoptions, useScenes } from "../projectDetail/useStory";
import { useGenerationSettings, useRefreshAfterAdoption } from "./useViewer";

/** 採用枠の表示名。 */
const SLOT_LABELS: Record<AdoptionSlot, string> = {
  scene_image: "シーン画像",
  voice: "音声",
  bgm: "BGM",
  video: "動画",
  compose: "統合",
};

/** Jobを持たない音声 (取り込み) は声かBGMか分からないので、枠を選ばせる。 */
const AUDIO_SLOT_OPTIONS = [
  { value: "voice", label: SLOT_LABELS.voice },
  { value: "bgm", label: SLOT_LABELS.bgm },
];

type SlotChoice = { state: "ready"; slot: AdoptionSlot } | { state: "pending" } | { state: "choose-audio" } | { state: "none" };

/**
 * 生成物を入れる枠。画像と動画は種別で、統合の動画は`sceneProduce`と同じくJobの`kind === "compose"`で決まる。
 * 音声はJobの種別 (`voice` / `music`) で声とBGMを見分ける (`ArtifactRead`に`audio_class`は無い)。
 */
function slotChoiceOf(artifact: ArtifactRecord, job: { data?: GenerationJob; isPending: boolean; isError: boolean }): SlotChoice {
  if (artifact.kind === "image") return { state: "ready", slot: "scene_image" };
  if (artifact.kind !== "video" && artifact.kind !== "audio") return { state: "none" };
  if (artifact.job_id !== null && job.isPending) return { state: "pending" };
  // Jobを読めないと統合や声かBGMかが決まらない。誤った枠へ入れないよう採用させない。
  if (artifact.job_id !== null && job.isError) return { state: "none" };
  const jobKind = job.data?.kind;
  if (artifact.kind === "video") return { state: "ready", slot: jobKind === "compose" ? "compose" : "video" };
  if (jobKind === "voice") return { state: "ready", slot: "voice" };
  if (jobKind === "music") return { state: "ready", slot: "bgm" };
  return artifact.job_id === null ? { state: "choose-audio" } : { state: "none" };
}

function adoptionLabel(adoption: StorySceneAdoption, lineNumbers: Map<string, number>): string {
  if (adoption.slot !== "voice") return SLOT_LABELS[adoption.slot];
  const line = adoption.dialogue_id ? lineNumbers.get(adoption.dialogue_id) : undefined;
  return line === undefined ? SLOT_LABELS.voice : `${SLOT_LABELS.voice} ${line}行目`;
}

function AdoptionControls({
  artifact,
  projectId,
  sceneId,
  slot,
  jobDialogueId,
}: {
  artifact: ArtifactRecord;
  projectId: string;
  sceneId: string;
  slot: AdoptionSlot;
  jobDialogueId: string | null;
}) {
  const scenes = useScenes(projectId);
  const adoptions = useSceneAdoptions(projectId, sceneId);
  const refresh = useRefreshAfterAdoption();
  // 行IDを持つ台詞だけが採用先になる。行番号は台詞の並びでの位置。
  const lines = (scenes.data?.find((scene) => scene.id === sceneId)?.dialogues ?? []).flatMap((line, index) =>
    line.id ? [{ id: line.id, number: index + 1, text: line.text }] : [],
  );
  // 行を取れるのは、Jobの行がこのシーンに今もあるとき。消えた行や行の無いJobは選ばせる。
  const jobLineKnown = jobDialogueId !== null && lines.some((line) => line.id === jobDialogueId);
  const [pickedLine, setPickedLine] = useState<string | null>(null);
  const dialogueId = slot === "voice" ? (jobLineKnown ? jobDialogueId : pickedLine) : null;
  const decide = useSlotDecision(projectId, sceneId, slot, dialogueId);

  const lineNumbers = new Map(lines.map((line) => [line.id, line.number] as const));
  const mine = (adoptions.data ?? []).filter((item) => item.artifact_id === artifact.id);
  const adopted = mine.some((item) => item.slot === slot && item.dialogue_id === dialogueId);
  const needsLine = slot === "voice" && dialogueId === null;
  const busy = decide.isPending || adoptions.isPending || adoptions.isError;
  const run = () =>
    decide.mutate(
      { artifact, action: adopted ? "release" : "adopt", adopted },
      {
        onSuccess: () =>
          notifications.show({
            color: "green",
            message: adopted ? `${SLOT_LABELS[slot]}の採用を外しました` : `${SLOT_LABELS[slot]}に採用しました`,
          }),
        onError: (error) => notifyError("採否を変えられませんでした", error),
        onSettled: () => refresh(artifact.id),
      },
    );
  return (
    <>
      {mine.length > 0 ? (
        <Group gap={4} data-testid="adopted-slots">
          <Text size="xs" c="dimmed">
            採用中:
          </Text>
          {mine.map((item) => (
            <Badge key={item.id} color="green" variant="light">
              {adoptionLabel(item, lineNumbers)}
            </Badge>
          ))}
        </Group>
      ) : null}
      {adoptions.isError ? (
        <Text size="xs" c="red">
          採用の状況を取得できません: {adoptions.error.message}
        </Text>
      ) : null}
      {slot === "voice" && !jobLineKnown ? (
        <Select
          size="xs"
          label="台詞の行"
          description="この音声を入れる行を選びます"
          placeholder="行を選ぶ"
          data={lines.map((line) => ({ value: line.id, label: `${line.number}行目 ${line.text}` }))}
          value={pickedLine}
          onChange={setPickedLine}
          disabled={scenes.isPending}
          allowDeselect={false}
        />
      ) : null}
      <Group>
        <Button size="xs" variant={adopted ? "filled" : "light"} color="green" onClick={run} loading={decide.isPending} disabled={busy || needsLine}>
          {adopted ? "採用を外す" : `紐づけたシーンの${SLOT_LABELS[slot]}に採用`}
        </Button>
      </Group>
    </>
  );
}

/**
 * Projectとシーンに紐づく生成物を、種別に合うシーンの採用枠へ入れる。紐づいていなければ何も出さない。
 * 今どの枠に採用されているかも出す。
 */
export function SlotAdoption({ artifact }: { artifact: ArtifactRecord }) {
  const projectId = artifact.assigned_project_id;
  const sceneId = artifact.story_scene_id ?? null;
  const { job } = useGenerationSettings(artifact.job_id);
  const [audioSlot, setAudioSlot] = useState<AdoptionSlot>("voice");
  if (!projectId || !sceneId) return null;
  const choice = slotChoiceOf(artifact, job);
  if (choice.state === "none") return null;
  if (choice.state === "pending") return <Loader size="xs" />;
  const slot = choice.state === "ready" ? choice.slot : audioSlot;
  return (
    <>
      {choice.state === "choose-audio" ? (
        <SegmentedControl size="xs" data={AUDIO_SLOT_OPTIONS} value={audioSlot} onChange={(value) => setAudioSlot(value as AdoptionSlot)} />
      ) : null}
      <AdoptionControls
        key={`${slot}:${artifact.id}`}
        artifact={artifact}
        projectId={projectId}
        sceneId={sceneId}
        slot={slot}
        jobDialogueId={job.data?.story_dialogue_id ?? null}
      />
    </>
  );
}
