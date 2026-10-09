import { Alert, Badge, Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { useNavigate } from "react-router";

import type { ExternalProjectCandidate, StoryImportResult } from "../api/client";
import { StoryImportRunner } from "./StoryImportRunner";
import { useExternalCandidates, useImportExternalProject } from "./useStoryImport";

/** 取り込みの通知に出す、作った件数の要約。 */
export function summarizeImport(result: StoryImportResult): string {
  return `キャラクター${result.characters.created}件・衣装${result.costumes.created}件・シーン${result.scenes.created}件を作りました`;
}

type Target = { projectId: string; projectName: string };

function CandidateStep({ onPicked, onClose }: { onPicked: (target: Target) => void; onClose: () => void }) {
  const candidates = useExternalCandidates(true);
  const create = useImportExternalProject();

  const pick = (candidate: ExternalProjectCandidate) => {
    // 取り込み済みの候補は既存のProjectを使う。無ければここでProjectを作る。
    if (candidate.imported_project_id) {
      onPicked({ projectId: candidate.imported_project_id, projectName: candidate.title });
      return;
    }
    create.mutate(candidate.id, {
      onSuccess: (project) => onPicked({ projectId: project.id, projectName: project.name }),
    });
  };

  return (
    <Stack>
      <Text size="sm">取り込むnovel-writerのProjectを選んでください。次の画面で、作る件数を確かめてから取り込みます。</Text>
      {candidates.isPending ? <Loader size="sm" /> : null}
      {candidates.error ? (
        <Alert color="red" title="候補を取得できません" data-testid="story-import-error">
          {candidates.error.message}
        </Alert>
      ) : null}
      {candidates.data && candidates.data.items.length === 0 ? <Text c="dimmed">取り込める候補がありません</Text> : null}
      {candidates.data?.items.map((candidate) => (
        <Group key={candidate.id} justify="space-between" wrap="nowrap" data-testid="story-import-candidate">
          <div>
            <Group gap="xs">
              <Text fw={600}>{candidate.title}</Text>
              {candidate.imported_project_id ? (
                <Badge variant="light" color="teal">
                  Project作成済み
                </Badge>
              ) : null}
            </Group>
            <Text size="xs" c="dimmed">
              {candidate.id} / {candidate.source_locator} / {candidate.revision.slice(0, 7)}
            </Text>
          </div>
          <Button
            size="xs"
            aria-label={`${candidate.title}を選ぶ`}
            loading={create.isPending && create.variables === candidate.id}
            disabled={create.isPending}
            onClick={() => pick(candidate)}
          >
            選ぶ
          </Button>
        </Group>
      ))}
      {create.error ? (
        <Alert color="red" title="Projectを作成できません" data-testid="story-import-error">
          {create.error.message}
        </Alert>
      ) : null}
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          閉じる
        </Button>
      </Group>
    </Stack>
  );
}

function ModalBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [target, setTarget] = useState<Target | null>(null);

  if (target === null) return <CandidateStep onPicked={setTarget} onClose={onClose} />;
  return (
    <StoryImportRunner
      projectId={target.projectId}
      projectName={target.projectName}
      onBack={() => setTarget(null)}
      onClose={onClose}
      onImported={(result) => {
        notifications.show({ color: "green", message: `「${target.projectName}」: ${summarizeImport(result)}` });
        onClose();
        navigate(`/projects/${encodeURIComponent(target.projectId)}`);
      }}
    />
  );
}

/** `/projects`の「novel-writerから取り込む」。候補を選び、Projectの作成、件数のプレビュー、取り込みの順に進める。 */
export function StoryImportModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <Modal opened={opened} onClose={onClose} title="novel-writerから取り込む" size="lg">
      {/* 開くたびに候補とプレビューを取り直すため、閉じている間は描画しない。 */}
      {opened ? <ModalBody onClose={onClose} /> : null}
    </Modal>
  );
}
