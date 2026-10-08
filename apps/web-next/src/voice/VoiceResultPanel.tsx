import { Alert, Anchor, Badge, Button, Card, CloseButton, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { Link } from "react-router";

import { artifactContentUrl, type ArtifactRecord, type VoiceVerification } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { MemoField, viewerPathOf } from "../imageGen/ArtifactCard";
import { useJob, type SceneDecision } from "../imageGen/useImageGen";
import { STATE_LABELS } from "../jobs/JobDrawer";
import { notifyError } from "../notifications";
import { useSceneAdoptions } from "../projectDetail/useStory";
import {
  useArtifactAsVoiceReference,
  useJobAudio,
  useVoiceDecision,
  useVoiceVerifications,
  type VoiceResultEntry,
} from "./useVoice";
import type { VoiceReferenceFile } from "./voiceForm";

/** 読み検証1件の見出し。一致・不一致・検証できなかった理由を分ける。 */
function verificationBadge(item: VoiceVerification): { label: string; color: string } {
  if (item.match === true) return { label: "読み一致", color: "green" };
  if (item.match === false) return { label: "読み不一致", color: "red" };
  if (item.status === "asr_failed") return { label: "ASR失敗", color: "orange" };
  if (item.status === "kana_unavailable") return { label: "読みを比べられません", color: "orange" };
  return { label: "検証なし", color: "gray" };
}

/** ASRによる読みの検証結果。検証をオフにして作った生成では出ない。 */
function VerificationView({ jobId }: { jobId: string }) {
  const verifications = useVoiceVerifications(jobId, true);
  if (verifications.isPending) return null;
  if (verifications.error) {
    return (
      <Text size="xs" c="red" data-testid="verification-error">
        読みの検証結果を取得できません: {verifications.error.message}
      </Text>
    );
  }
  return (
    <Stack gap={4} data-testid="verification-list">
      {verifications.data.map((item) => {
        const badge = verificationBadge(item);
        return (
          <Stack gap={2} key={item.id} data-testid="verification" data-match={String(item.match)}>
            <Group gap="xs">
              <Badge size="xs" color={badge.color} data-testid="verification-badge">
                {badge.label}
              </Badge>
              {item.match === false && item.diff_ratio !== null ? (
                <Text size="xs" c="dimmed">
                  差分率 {item.diff_ratio.toFixed(2)}
                </Text>
              ) : null}
            </Group>
            {item.match === false ? (
              <Text size="xs" c="dimmed" data-testid="verification-asr">
                期待: {item.expected_reading ?? item.expected_text} / 聞き取り: {item.asr_text ?? "(なし)"}
              </Text>
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );
}

/**
 * Sceneの台詞の行を指定して作った生成物の、音声枠への採用と不採用の印。
 * 台詞の行が決まっていない生成物は枠を選べないので、採用は出さず不採用だけ出す。
 */
function VoiceDecisionButtons({
  artifact,
  projectId,
  sceneId,
  dialogueId,
}: {
  artifact: ArtifactRecord;
  projectId: string;
  sceneId: string;
  dialogueId: string | null;
}) {
  const adoptions = useSceneAdoptions(projectId, sceneId);
  const decide = useVoiceDecision(projectId, sceneId, dialogueId);
  const adopted =
    adoptions.data?.some(
      (item) => item.slot === "voice" && item.artifact_id === artifact.id && item.dialogue_id === dialogueId,
    ) ?? false;
  const rejected = artifact.decision === "rejected";
  const run = (action: SceneDecision) =>
    decide.mutate({ artifact, action, adopted }, { onError: (error) => notifyError("採否を変えられませんでした", error) });
  // 採用一覧を読めないと採用中かどうかが分からず、採用中のものを「採用」と誤表示して操作させてしまう。
  const busy = decide.isPending || adoptions.isPending || adoptions.isError;
  return (
    <>
      {dialogueId !== null ? (
        <Button
          size="compact-xs"
          variant={adopted ? "filled" : "light"}
          color="green"
          disabled={busy}
          onClick={() => run(adopted ? "release" : "adopt")}
        >
          {adopted ? "採用を外す" : "採用"}
        </Button>
      ) : null}
      <Button
        size="compact-xs"
        variant={rejected ? "filled" : "light"}
        color="red"
        disabled={busy}
        onClick={() => run(rejected ? "unreject" : "reject")}
      >
        {rejected ? "不採用を外す" : "不採用"}
      </Button>
      {adoptions.isError ? (
        <Text size="xs" c="red" data-testid="adoptions-error">
          採用の状況を取得できません: {adoptions.error.message}
        </Text>
      ) : null}
    </>
  );
}

/** 生成物を参照音声として取り込み、入力欄のCloneに入れる。 */
function UseAsReferenceButton({
  artifact,
  onUse,
}: {
  artifact: ArtifactRecord;
  onUse: (reference: VoiceReferenceFile) => void;
}) {
  const importer = useArtifactAsVoiceReference();
  return (
    <Button
      size="compact-xs"
      variant="light"
      loading={importer.isPending}
      onClick={() =>
        importer.mutate(artifact, {
          onSuccess: onUse,
          onError: (error) => notifyError("参照音声にできませんでした", error),
        })
      }
    >
      参照音声にする
    </Button>
  );
}

/** 完成した音声のカード。その場で再生でき、読みの検証、メモ、採否、参照音声にする、Viewerで開くを持つ。 */
function VoiceCard({
  artifact,
  jobId,
  dialogueId,
  onUseReference,
}: {
  artifact: ArtifactRecord;
  jobId: string;
  dialogueId: string | null;
  onUseReference: (reference: VoiceReferenceFile) => void;
}) {
  const projectId = artifact.assigned_project_id;
  return (
    <Card withBorder padding="xs" data-testid="result-artifact" data-artifact-id={artifact.id}>
      <Stack gap={6}>
        <audio controls preload="none" src={artifactContentUrl(artifact.id)} style={{ width: "100%" }} />
        {artifact.decision !== "undecided" ? (
          <Badge size="xs" color={artifact.decision === "accepted" ? "green" : "red"}>
            {artifact.decision === "accepted" ? "採用" : "不採用"}
          </Badge>
        ) : null}
        <VerificationView jobId={jobId} />
        <MemoField artifact={artifact} listKeyOf={queryKeys.jobAudio} />
        <Group gap={4}>
          {projectId && artifact.story_scene_id ? (
            <VoiceDecisionButtons
              artifact={artifact}
              projectId={projectId}
              sceneId={artifact.story_scene_id}
              dialogueId={dialogueId}
            />
          ) : null}
          <UseAsReferenceButton artifact={artifact} onUse={onUseReference} />
          <Anchor component={Link} to={viewerPathOf(artifact)} size="xs">
            Viewerで開く
          </Anchor>
        </Group>
      </Stack>
    </Card>
  );
}

/** 待機中・実行中の生成のプレースホルダ。完成すると音声のカードに差し替わる。 */
function PlaceholderCard({ label }: { label: string }) {
  return (
    <Card withBorder padding="xs" data-testid="result-placeholder">
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      </Group>
    </Card>
  );
}

function JobResult({
  entry,
  onRemove,
  onUseReference,
}: {
  entry: VoiceResultEntry;
  onRemove: () => void;
  onUseReference: (reference: VoiceReferenceFile) => void;
}) {
  const job = useJob(entry.jobId);
  const succeeded = job.data?.state === "succeeded";
  const audio = useJobAudio(entry.jobId, succeeded);
  const state = job.data ? (STATE_LABELS[job.data.state] ?? { label: job.data.state, color: "gray" }) : null;

  const body = () => {
    if (job.data === undefined) {
      return job.error ? <Alert color="red">{job.error.message}</Alert> : <Loader size="xs" />;
    }
    if (job.data.state === "failed") {
      return (
        <Alert color="red" title="生成に失敗しました">
          {job.data.failure_message ?? "理由は記録されていません"}
        </Alert>
      );
    }
    if (job.data.state === "cancelled") {
      return (
        <Text size="sm" c="dimmed">
          中止しました
        </Text>
      );
    }
    if (succeeded && audio.data !== undefined) {
      if (audio.data.length === 0) {
        return (
          <Text size="sm" c="dimmed">
            音声がありません (ゴミ箱へ移した可能性があります)
          </Text>
        );
      }
      return (
        <Stack gap="xs">
          {audio.data.map((artifact) => (
            <VoiceCard
              key={artifact.id}
              artifact={artifact}
              jobId={entry.jobId}
              dialogueId={job.data?.story_dialogue_id ?? null}
              onUseReference={onUseReference}
            />
          ))}
        </Stack>
      );
    }
    if (audio.error) return <Alert color="red">{audio.error.message}</Alert>;
    return <PlaceholderCard label={state?.label ?? "待機中"} />;
  };

  return (
    <Stack gap={4} data-testid="result-job" data-job-id={entry.jobId}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          {state ? (
            <Badge size="sm" color={state.color} variant="light">
              {state.label}
            </Badge>
          ) : null}
          <Text size="xs" c="dimmed">
            {job.data ? `#${job.data.queue_sequence}` : entry.jobId}
          </Text>
          {entry.line !== null ? (
            <Badge size="sm" variant="outline" data-testid="result-line">
              {entry.line}
            </Badge>
          ) : null}
          <Text size="sm" truncate data-testid="result-text">
            {entry.text}
          </Text>
        </Group>
        <CloseButton size="sm" aria-label="結果欄から外す" onClick={onRemove} />
      </Group>
      {body()}
    </Stack>
  );
}

/** この画面から投入した生成を新しい順に出す。 */
export function VoiceResultPanel({
  entries,
  onRemove,
  onUseReference,
}: {
  entries: VoiceResultEntry[];
  onRemove: (jobId: string) => void;
  onUseReference: (reference: VoiceReferenceFile) => void;
}) {
  return (
    <Stack gap="md">
      <Title order={4}>結果</Title>
      {entries.length === 0 ? (
        <Text size="sm" c="dimmed">
          まだ生成していません。左の入力欄から投入すると、ここに新しい順で並びます。
        </Text>
      ) : null}
      {entries.map((entry) => (
        <JobResult
          key={entry.jobId}
          entry={entry}
          onRemove={() => onRemove(entry.jobId)}
          onUseReference={onUseReference}
        />
      ))}
    </Stack>
  );
}
