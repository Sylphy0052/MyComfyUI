import { Badge, Button, Group, Loader, SegmentedControl, Select, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { UseQueryResult } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

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

type SlotChoice =
  | { state: "ready"; slot: AdoptionSlot }
  | { state: "pending" }
  | { state: "choose-audio" }
  | { state: "none" }
  /** 採用先を決められない。`error`なら取得の失敗、そうでなければ判別できないだけ。 */
  | { state: "blocked"; message: string; error: boolean };

/**
 * 採用中の生成物を不採用にする操作。採用中なら先に枠から外してから不採用にする (`useSlotDecision`の`reject`)。
 * `blockedReason`があるときは不採用にできない (枠に採用中のまま不採用にしてしまう、または採用中かが分からない)。
 */
export type SlotReject = { adopted: boolean; pending: boolean; reject: () => void; blockedReason: string | null };

type AdoptionsQuery = Pick<UseQueryResult<StorySceneAdoption[]>, "data" | "isPending" | "isError">;

/**
 * 枠に採用中のまま不採用にさせないための理由。`remaining`は不採用にしても枠に残る採用 (この生成物のうち、不採用の操作で外れないもの)。
 * 採用状況が分からない間も、採用中かを確かめられないので止める。
 */
function rejectBlockedReason(adoptions: AdoptionsQuery, remaining: StorySceneAdoption[]): string | null {
  if (adoptions.isPending) return "採用の状況を確認しています";
  if (adoptions.isError) return "採用の状況を取得できないため、不採用にできません";
  if (remaining.length > 0) return "採用中の枠を外してから不採用にしてください";
  return null;
}

type JobQuery = Pick<UseQueryResult<GenerationJob>, "data" | "isPending" | "isError" | "error">;

/**
 * 生成物を入れる枠。画像と動画は種別で、統合の動画は`useComposeArtifactIds`と同じくJobの`kind === "compose"`で決まる。
 * 音声はJobの種別 (`voice` / `music`) で声とBGMを見分ける (`ArtifactRead`に`audio_class`は無い)。
 */
function slotChoiceOf(artifact: ArtifactRecord, job: JobQuery): SlotChoice {
  if (artifact.kind === "image") return { state: "ready", slot: "scene_image" };
  if (artifact.kind !== "video" && artifact.kind !== "audio") return { state: "none" };
  if (artifact.job_id !== null && job.data === undefined) {
    // Jobを読めないと統合や声かBGMかが決まらない。誤った枠へ入れないよう採用させない。
    // 再取得の失敗は取得済みのJobがあれば無視する (`isError`はデータがあっても立つ)。
    if (job.isError) {
      return { state: "blocked", message: `Jobを取得できないため採用先を決められません: ${job.error?.message ?? ""}`, error: true };
    }
    return { state: "pending" };
  }
  const jobKind = job.data?.kind;
  if (artifact.kind === "video") return { state: "ready", slot: jobKind === "compose" ? "compose" : "video" };
  if (jobKind === "voice") return { state: "ready", slot: "voice" };
  if (jobKind === "music") return { state: "ready", slot: "bgm" };
  return artifact.job_id === null
    ? { state: "choose-audio" }
    : { state: "blocked", message: "この音声は採用枠を判別できません", error: false };
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
  renderDecision,
  slotPicker,
}: {
  artifact: ArtifactRecord;
  projectId: string;
  sceneId: string;
  slot: AdoptionSlot;
  jobDialogueId: string | null;
  renderDecision: (slotReject: SlotReject | null) => ReactNode;
  slotPicker: ReactNode;
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
  const mine = (adoptions.data ?? []).filter((item) => item.artifact_id === artifact.id);
  // 行を選んでいなければ、この生成物が採用中の行を既定にする (開き直すと選択は戻るので、採用先を見失わない)。
  const adoptedLine = mine.find((item) => item.slot === "voice")?.dialogue_id ?? null;
  const pickedOrAdoptedLine = pickedLine ?? adoptedLine;
  const dialogueId = slot === "voice" ? (jobLineKnown ? jobDialogueId : pickedOrAdoptedLine) : null;
  const decide = useSlotDecision(projectId, sceneId, slot, dialogueId);

  const lineNumbers = new Map(lines.map((line) => [line.id, line.number] as const));
  const isCurrent = (item: StorySceneAdoption) => item.slot === slot && item.dialogue_id === dialogueId;
  const adopted = mine.some(isCurrent);
  const needsLine = slot === "voice" && dialogueId === null;
  // 画像の採用は採用状況に依らず今までどおり押せる。ほかの枠は、採用中かが分からないまま入れ替えないよう止める。
  const needsStatus = slot !== "scene_image";
  const statusUnknown = needsStatus && (adoptions.isPending || adoptions.isError);
  const busy = decide.isPending || statusUnknown;
  const mutate = (action: "adopt" | "release" | "reject", message: string, failure: string) =>
    decide.mutate(
      { artifact, action, adopted },
      {
        onSuccess: () => notifications.show({ color: "green", message }),
        onError: (error) => notifyError(failure, error),
        onSettled: () => refresh(artifact.id),
      },
    );
  const run = () =>
    adopted
      ? mutate("release", `${SLOT_LABELS[slot]}の採用を外しました`, "採否を変えられませんでした")
      : mutate("adopt", `${SLOT_LABELS[slot]}に採用しました`, "採否を変えられませんでした");
  const reject = () => mutate("reject", `${SLOT_LABELS[slot]}の採用を外して不採用にしました`, "不採用にできませんでした");
  // 画像は今までどおり。ほかの枠は、今の枠・行以外にも採用中なら不採用にしても枠に残るので止める。
  const blockedReason = needsStatus ? rejectBlockedReason(adoptions, mine.filter((item) => !isCurrent(item))) : null;
  const scenesFailed = scenes.isError && scenes.data === undefined;
  const noLines = slot === "voice" && !jobLineKnown && scenes.isSuccess && lines.length === 0;
  return (
    <>
      {renderDecision({ adopted, pending: decide.isPending, reject, blockedReason })}
      {slotPicker}
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
          {needsStatus
            ? `採用の状況を取得できないため、${SLOT_LABELS[slot]}の採用は操作できません: ${adoptions.error.message}`
            : `採用の状況を取得できません: ${adoptions.error.message}`}
        </Text>
      ) : null}
      {slot === "voice" && !jobLineKnown && scenesFailed ? (
        <Text size="xs" c="red">
          採用先の台詞を取得できません: {scenes.error?.message}
        </Text>
      ) : null}
      {noLines ? (
        <Text size="xs" c="dimmed">
          このシーンに台詞がありません
        </Text>
      ) : null}
      {slot === "voice" && !jobLineKnown && !scenesFailed && !noLines ? (
        <Select
          size="xs"
          label="台詞の行"
          description="この音声を入れる行を選びます"
          placeholder="行を選ぶ"
          data={lines.map((line) => ({ value: line.id, label: `${line.number}行目 ${line.text}` }))}
          value={pickedOrAdoptedLine}
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
 * 採用先が決まらない (Job取得中・取得失敗・枠の判別不能・枠の無い種別) ときの採否。
 * 枠を操作できないので、採用中の生成物は不採用にさせない (枠に採用中のまま不採用になるのを防ぐ)。
 */
function UnslottedDecision({
  artifact,
  projectId,
  sceneId,
  renderDecision,
  children,
}: {
  artifact: ArtifactRecord;
  projectId: string;
  sceneId: string;
  renderDecision: (slotReject: SlotReject | null) => ReactNode;
  children: ReactNode;
}) {
  const adoptions = useSceneAdoptions(projectId, sceneId);
  const mine = (adoptions.data ?? []).filter((item) => item.artifact_id === artifact.id);
  const blockedReason = rejectBlockedReason(adoptions, mine);
  return (
    <>
      {renderDecision({ adopted: false, pending: false, reject: () => undefined, blockedReason })}
      {children}
    </>
  );
}

/**
 * Projectとシーンに紐づく生成物を、種別に合うシーンの採用枠へ入れる。紐づいていなければ何も出さない。
 * 今どの枠に採用されているかも出す。
 */
export function SlotAdoption({
  artifact,
  renderDecision,
}: {
  artifact: ArtifactRecord;
  /** 採否の切替を描く。採用先が決まっていれば、採用中の不採用を枠から外す操作を渡す。 */
  renderDecision: (slotReject: SlotReject | null) => ReactNode;
}) {
  const projectId = artifact.assigned_project_id;
  const sceneId = artifact.story_scene_id ?? null;
  const { job } = useGenerationSettings(artifact.job_id);
  const [audioSlot, setAudioSlot] = useState<AdoptionSlot>("voice");
  if (!projectId || !sceneId) return <>{renderDecision(null)}</>;
  const choice = slotChoiceOf(artifact, job);
  const unslotted = { artifact, projectId, sceneId, renderDecision };
  if (choice.state === "none") return <UnslottedDecision {...unslotted}>{null}</UnslottedDecision>;
  if (choice.state === "pending") {
    return (
      <UnslottedDecision {...unslotted}>
        <Loader size="xs" />
      </UnslottedDecision>
    );
  }
  if (choice.state === "blocked") {
    return (
      <UnslottedDecision {...unslotted}>
        <Text size="xs" c={choice.error ? "red" : "dimmed"}>
          {choice.message}
        </Text>
      </UnslottedDecision>
    );
  }
  const slot = choice.state === "ready" ? choice.slot : audioSlot;
  return (
    <>
      <AdoptionControls
        renderDecision={renderDecision}
        slotPicker={
          choice.state === "choose-audio" ? (
            <SegmentedControl size="xs" data={AUDIO_SLOT_OPTIONS} value={audioSlot} onChange={(value) => setAudioSlot(value as AdoptionSlot)} />
          ) : null
        }
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
