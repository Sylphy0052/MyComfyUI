import { Button, Modal } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";

import type { ProjectRecord } from "../api/client";
import { summarizeImport } from "./StoryImportPreview";
import { StoryImportRunner } from "./StoryImportRunner";
import { useLocalOverrides } from "./useStoryImport";

/**
 * Project詳細の「novel-writerから再取り込み」。snapshotか`local_overrides.characters`を持つProjectにだけ出す。
 * snapshotの有無は`source_snapshot_sha256`で分かるので、持たないProjectだけ旧キャラ設定を読んで確かめる。
 * ゴミ箱のProjectは取り込みを受け付けないため出さない。
 */
export function ReimportButton({ project }: { project: ProjectRecord }) {
  const [opened, setOpened] = useState(false);
  const [pending, setPending] = useState(false);
  const hasSnapshot = project.source_snapshot_sha256 !== null;
  const overrides = useLocalOverrides(project.id, !hasSnapshot);
  const importable = hasSnapshot || (overrides.data?.characters?.length ?? 0) > 0;
  if (project.lifecycle === "trashed" || !importable) return null;

  const close = () => setOpened(false);
  return (
    <>
      <Button variant="default" onClick={() => setOpened(true)}>
        novel-writerから再取り込み
      </Button>
      <Modal
        opened={opened}
        onClose={close}
        title="novel-writerから再取り込み"
        size="lg"
        // 取り込み中に閉じると完了通知が失われるため、終わるまで閉じさせない。
        closeOnEscape={!pending}
        closeOnClickOutside={!pending}
        closeButtonProps={{ disabled: pending }}
      >
        {/* 開くたびにプレビューを取り直すため、閉じている間は描画しない。 */}
        {opened ? (
          <StoryImportRunner
            projectId={project.id}
            projectName={project.name}
            onClose={close}
            onPendingChange={setPending}
            onImported={(result) => {
              notifications.show({ color: "green", message: summarizeImport(result) });
              close();
            }}
          />
        ) : null}
      </Modal>
    </>
  );
}
