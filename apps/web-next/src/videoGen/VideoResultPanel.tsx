import { Alert, Badge, Card, CloseButton, Group, Loader, Stack, Text, Title } from "@mantine/core";

import { artifactContentUrl } from "../api/client";
import { useJob } from "../imageGen/useImageGen";
import { STATE_LABELS } from "../jobs/JobDrawer";
import { useJobVideos, type VideoResultEntry } from "./useVideoGen";

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

function VideoResult({ entry, onRemove }: { entry: VideoResultEntry; onRemove: () => void }) {
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
            <video
              key={artifact.id}
              controls
              preload="metadata"
              src={artifactContentUrl(artifact.id)}
              style={{ width: "100%", maxHeight: 360 }}
              data-testid="result-video"
              data-artifact-id={artifact.id}
            />
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
        <CloseButton size="sm" aria-label="結果欄から外す" onClick={onRemove} />
      </Group>
      {body()}
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
        <VideoResult key={entry.jobId} entry={entry} onRemove={() => onRemove(entry.jobId)} />
      ))}
    </Stack>
  );
}
