import { Alert, Badge, Button, Card, CloseButton, Group, Loader, SimpleGrid, Stack, Text, Title } from "@mantine/core";

import type { ArtifactRecord } from "../api/client";
import { STATE_LABELS } from "../jobs/JobDrawer";
import { ArtifactCard } from "./ArtifactCard";
import { SweepResult } from "./SweepResult";
import { useJob, useJobImages, type ResultEntry } from "./useImageGen";
import type { SweepEntry } from "./useSweep";

type RestoreProps = {
  onRestore: (jobId: string) => void;
  restoringJobId: string | null;
  onSendToEdit: (artifact: ArtifactRecord) => void;
};

/** 待機中・実行中の生成のプレースホルダ。完成すると生成物のカードに差し替わる。 */
function PlaceholderCard({ label, onRestore, restoring }: { label: string; onRestore: () => void; restoring: boolean }) {
  return (
    <Card withBorder padding="xs" data-testid="result-placeholder">
      <Card.Section>
        <Stack h={220} align="center" justify="center" gap={4} bg="var(--mantine-color-default-hover)">
          <Loader size="sm" />
          <Text size="xs" c="dimmed">
            {label}
          </Text>
        </Stack>
      </Card.Section>
      <Group mt="xs">
        <Button size="compact-xs" variant="light" loading={restoring} onClick={onRestore}>
          この設定を入力欄へ戻す
        </Button>
      </Group>
    </Card>
  );
}

function JobResult({ entry, onRemove, onRestore, restoringJobId, onSendToEdit }: { entry: ResultEntry; onRemove: () => void } & RestoreProps) {
  const job = useJob(entry.jobId);
  const succeeded = job.data?.state === "succeeded";
  const images = useJobImages(entry.jobId, succeeded);
  const restore = () => onRestore(entry.jobId);
  const restoring = restoringJobId === entry.jobId;
  const state = job.data ? (STATE_LABELS[job.data.state] ?? { label: job.data.state, color: "gray" }) : null;

  const body = () => {
    if (job.data === undefined) {
      return job.error ? <Alert color="red">{job.error.message}</Alert> : <Loader size="xs" />;
    }
    if (job.data.state === "failed") {
      return (
        <Alert color="red" title="生成に失敗しました">
          <Stack gap="xs">
            <Text size="sm">{job.data.failure_message ?? "理由は記録されていません"}</Text>
            <Group>
              <Button size="compact-xs" variant="light" loading={restoring} onClick={restore}>
                この設定を入力欄へ戻す
              </Button>
            </Group>
          </Stack>
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
        <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="xs">
          {images.data.map((artifact) => (
            <ArtifactCard
              key={artifact.id}
              artifact={artifact}
              onRestore={restore}
              restoring={restoring}
              onSendToEdit={onSendToEdit}
            />
          ))}
        </SimpleGrid>
      );
    }
    if (images.error) return <Alert color="red">{images.error.message}</Alert>;
    return (
      <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="xs">
        {Array.from({ length: entry.count }, (_, index) => (
          <PlaceholderCard key={index} label={state?.label ?? "待機中"} onRestore={restore} restoring={restoring} />
        ))}
      </SimpleGrid>
    );
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

/** この画面から投入した生成を新しい順に出す。 */
export function ResultPanel({
  entries,
  onRemove,
  onRestore,
  restoringJobId,
  onSendToEdit,
  sweeps,
  onRemoveSweep,
}: {
  entries: ResultEntry[];
  onRemove: (jobId: string) => void;
  sweeps: SweepEntry[];
  onRemoveSweep: (experimentId: string) => void;
} & RestoreProps) {
  return (
    <Stack gap="md">
      <Title order={4}>結果</Title>
      {entries.length === 0 && sweeps.length === 0 ? (
        <Text size="sm" c="dimmed">
          まだ生成していません。左の入力欄から投入すると、ここに新しい順で並びます。
        </Text>
      ) : null}
      {sweeps.map((sweep) => (
        <SweepResult
          key={sweep.experimentId}
          experimentId={sweep.experimentId}
          onRemove={() => onRemoveSweep(sweep.experimentId)}
          onRestore={onRestore}
          restoringJobId={restoringJobId}
          onSendToEdit={onSendToEdit}
        />
      ))}
      {entries.map((entry) => (
        <JobResult
          key={entry.jobId}
          entry={entry}
          onRemove={() => onRemove(entry.jobId)}
          onRestore={onRestore}
          restoringJobId={restoringJobId}
          onSendToEdit={onSendToEdit}
        />
      ))}
    </Stack>
  );
}
