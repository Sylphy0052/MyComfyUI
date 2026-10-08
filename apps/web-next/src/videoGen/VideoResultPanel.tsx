import { Alert, Badge, Button, Card, CloseButton, Group, Loader, Stack, Text, Title } from "@mantine/core";

import { artifactContentUrl, type ArtifactRecord, type GenerationJobFollowup } from "../api/client";
import { useJob, useJobImages, useSlotDecision, type AdoptionSlot, type SceneDecision } from "../imageGen/useImageGen";
import { STATE_LABELS } from "../jobs/JobDrawer";
import { notifyError } from "../notifications";
import { useSceneAdoptions } from "../projectDetail/useStory";
import { useFollowup, useJobVideos, type VideoResultEntry } from "./useVideoGen";

/** 動画の採用枠。統合Jobの動画は`compose`枠、それ以外は`video`枠にだけ入る。 */
type VideoSlot = Extract<AdoptionSlot, "video" | "compose">;

/** Sceneを指定して作った動画の、`slot`枠への採用と不採用の印。 */
function VideoDecisionButtons({
  artifact,
  projectId,
  sceneId,
  slot,
}: {
  artifact: ArtifactRecord;
  projectId: string;
  sceneId: string;
  slot: VideoSlot;
}) {
  const adoptions = useSceneAdoptions(projectId, sceneId);
  const decide = useSlotDecision(projectId, sceneId, slot);
  const adopted = adoptions.data?.some((item) => item.slot === slot && item.artifact_id === artifact.id) ?? false;
  const rejected = artifact.decision === "rejected";
  const run = (action: SceneDecision) =>
    decide.mutate({ artifact, action, adopted }, { onError: (error) => notifyError("採否を変えられませんでした", error) });
  // 採用一覧を読めないと採用中かどうかが分からず、採用中のものを「採用」と誤表示して操作させてしまう。
  const busy = decide.isPending || adoptions.isPending || adoptions.isError;
  return (
    <Group gap={4} data-testid="video-decision">
      <Button
        size="compact-xs"
        variant={adopted ? "filled" : "light"}
        color="green"
        disabled={busy}
        onClick={() => run(adopted ? "release" : "adopt")}
      >
        {adopted ? "採用を外す" : "採用"}
      </Button>
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
    </Group>
  );
}

/** 待機中・実行中の生成のプレースホルダ。完成すると動画のプレーヤーに差し替わる。 */
function PlaceholderCard({ label }: { label: string }) {
  return (
    <Card withBorder padding="xs" data-testid="result-placeholder">
      <Stack h={220} align="center" justify="center" gap={4} bg="var(--mantine-color-default-hover)">
        <Loader size="sm" />
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      </Stack>
    </Card>
  );
}

/** 動画のJobの結果。`slot`は採用先で、統合の工程は`compose`を渡す。 */
export function VideoResult({
  entry,
  onRemove,
  slot = "video",
}: {
  entry: VideoResultEntry;
  onRemove?: () => void;
  slot?: VideoSlot;
}) {
  const job = useJob(entry.jobId);
  const succeeded = job.data?.state === "succeeded";
  const videos = useJobVideos(entry.jobId, succeeded);
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
    if (succeeded && videos.data !== undefined) {
      if (videos.data.length === 0) {
        return (
          <Text size="sm" c="dimmed">
            動画がありません (ゴミ箱へ移した可能性があります)
          </Text>
        );
      }
      return (
        <Stack gap="xs">
          {videos.data.map((artifact) => (
            <Stack key={artifact.id} gap={4}>
              <video
                controls
                preload="metadata"
                src={artifactContentUrl(artifact.id)}
                style={{ width: "100%", maxHeight: 360 }}
                data-testid="result-video"
                data-artifact-id={artifact.id}
              />
              {artifact.decision !== "undecided" ? (
                <Badge size="xs" color={artifact.decision === "accepted" ? "green" : "red"} w="fit-content">
                  {artifact.decision === "accepted" ? "採用" : "不採用"}
                </Badge>
              ) : null}
              {artifact.assigned_project_id && artifact.story_scene_id ? (
                <VideoDecisionButtons
                  artifact={artifact}
                  projectId={artifact.assigned_project_id}
                  sceneId={artifact.story_scene_id}
                  slot={slot}
                />
              ) : null}
            </Stack>
          ))}
        </Stack>
      );
    }
    if (videos.error) return <Alert color="red">{videos.error.message}</Alert>;
    return <PlaceholderCard label={state?.label ?? "待機中"} />;
  };

  return (
    <Stack gap={4} data-testid="result-job" data-job-id={entry.jobId}>
      <Group justify="space-between">
        <Group gap="xs">
          {state ? (
            <Badge size="sm" color={state.color} variant="light">
              {state.label}
            </Badge>
          ) : null}
          <Text size="xs" c="dimmed">
            {job.data ? `#${job.data.queue_sequence}` : entry.jobId}
          </Text>
        </Group>
        {onRemove ? <CloseButton size="sm" aria-label="結果欄から外す" onClick={onRemove} /> : null}
      </Group>
      {body()}
    </Stack>
  );
}

const FOLLOWUP_LABELS: Record<GenerationJobFollowup["state"], { label: string; color: string }> = {
  pending: { label: "1段目の完了待ち", color: "gray" },
  submitted: { label: "投入済み", color: "blue" },
  skipped: { label: "投入しなかった", color: "yellow" },
  failed: { label: "投入に失敗", color: "red" },
};

function StageWaiting({ label }: { label: string }) {
  return (
    <Group gap="xs" data-testid="stage-waiting">
      <Loader size="xs" />
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Group>
  );
}

/** 「プロンプトだけ」の1段目。画像Jobの状態と、できた画像。 */
function ImageStage({ jobId }: { jobId: string }) {
  const job = useJob(jobId);
  const succeeded = job.data?.state === "succeeded";
  const images = useJobImages(jobId, succeeded);
  const state = job.data ? (STATE_LABELS[job.data.state] ?? { label: job.data.state, color: "gray" }) : null;

  const body = () => {
    if (job.data === undefined) {
      return job.error ? <Alert color="red">{job.error.message}</Alert> : <Loader size="xs" />;
    }
    if (job.data.state === "failed") {
      return (
        <Alert color="red" title="画像の生成に失敗しました">
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
    if (succeeded && images.data !== undefined) {
      if (images.data.length === 0) {
        return (
          <Text size="sm" c="dimmed">
            画像がありません (ゴミ箱へ移した可能性があります)
          </Text>
        );
      }
      return (
        <Group gap="xs">
          {images.data.map((artifact) => (
            <img
              key={artifact.id}
              src={artifactContentUrl(artifact.id)}
              alt="1段目の画像"
              style={{ maxWidth: "100%", maxHeight: 240 }}
              data-testid="result-image"
              data-artifact-id={artifact.id}
            />
          ))}
        </Group>
      );
    }
    if (images.error) return <Alert color="red">{images.error.message}</Alert>;
    return <StageWaiting label={state?.label ?? "待機中"} />;
  };

  return (
    <Stack gap={4} data-testid="result-stage-image" data-job-id={jobId} data-job-state={job.data?.state}>
      <Group gap="xs">
        <Text size="sm" fw={600}>
          1段目: 画像
        </Text>
        {state ? (
          <Badge size="sm" color={state.color} variant="light">
            {state.label}
          </Badge>
        ) : null}
      </Group>
      {body()}
    </Stack>
  );
}

/** 「プロンプトだけ」の2段目。予約の状態と、投入後はi2v Jobの状態・動画。 */
function VideoStage({ followupId }: { followupId: string }) {
  const followup = useFollowup(followupId);
  const data = followup.data;
  const state = data ? FOLLOWUP_LABELS[data.state] : null;

  const body = () => {
    if (data === undefined) {
      return followup.error ? <Alert color="red">{followup.error.message}</Alert> : <Loader size="xs" />;
    }
    // 取り直しの失敗はdataを消さないため、前回の状態を出したまま小さく知らせる。
    const refetchFailed = followup.isRefetchError ? (
      <Text size="xs" c="red" data-testid="followup-refetch-error">
        状態の取得に失敗しました。自動で再取得します。
      </Text>
    ) : null;
    if (data.state === "pending") {
      return (
        <>
          <StageWaiting label="1段目の完了後に自動で投入します" />
          {refetchFailed}
        </>
      );
    }
    if (data.state === "skipped" || data.state === "failed") {
      return (
        <Alert color={data.state === "failed" ? "red" : "yellow"} title="動画は作られません" data-testid="followup-reason">
          {data.failure_message ?? "理由は記録されていません"}
        </Alert>
      );
    }
    if (data.child_job_id) return <VideoResult entry={{ jobId: data.child_job_id }} />;
    return (
      <>
        <StageWaiting label="動画のJobを投入しています" />
        {refetchFailed}
      </>
    );
  };

  return (
    <Stack gap={4} data-testid="result-stage-video" data-followup-state={data?.state}>
      <Group gap="xs">
        <Text size="sm" fw={600}>
          2段目: 動画
        </Text>
        {state ? (
          <Badge size="sm" color={state.color} variant="light">
            {state.label}
          </Badge>
        ) : null}
      </Group>
      {body()}
    </Stack>
  );
}

/** 「プロンプトだけ」の結果。1段目の画像と、2段目の動画を順に出す。 */
function PromptOnlyResult({
  jobId,
  followupId,
  onRemove,
}: {
  jobId: string;
  followupId: string;
  onRemove: () => void;
}) {
  return (
    <Stack gap="xs" data-testid="result-prompt-only" data-job-id={jobId} data-followup-id={followupId}>
      <Group justify="space-between">
        <Badge size="sm" variant="outline">
          プロンプトだけ
        </Badge>
        <CloseButton size="sm" aria-label="結果欄から外す" onClick={onRemove} />
      </Group>
      <ImageStage jobId={jobId} />
      <VideoStage followupId={followupId} />
    </Stack>
  );
}

/** この画面から投入した動画の生成を新しい順に出す。 */
export function VideoResultPanel({
  entries,
  onRemove,
}: {
  entries: VideoResultEntry[];
  onRemove: (jobId: string) => void;
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
        entry.followupId === undefined ? (
          <VideoResult key={entry.jobId} entry={entry} onRemove={() => onRemove(entry.jobId)} />
        ) : (
          <PromptOnlyResult
            key={entry.jobId}
            jobId={entry.jobId}
            followupId={entry.followupId}
            onRemove={() => onRemove(entry.jobId)}
          />
        )
      ))}
    </Stack>
  );
}
