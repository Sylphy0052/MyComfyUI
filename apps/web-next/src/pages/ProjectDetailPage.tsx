import { Alert, Anchor, Button, Group, Loader, Stack, Tabs, Text, Title } from "@mantine/core";
import { useState } from "react";
import { Link, useParams } from "react-router";

import { useProject } from "../layout/projectContext";
import { CharacterTab } from "../projectDetail/CharacterTab";
import { ReadOnlyContext } from "../projectDetail/readOnly";
import { RefetchErrorAlert } from "../projectDetail/RefetchErrorAlert";
import { SceneTab } from "../projectDetail/SceneTab";
import { UnsavedGuardProvider, useRunGuarded } from "../projectDetail/unsavedGuard";
import { useRestoreProjectWithNotice } from "../projects/useProjects";

type DetailTab = "characters" | "scenes";

function DetailTabs({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<DetailTab>("characters");
  const runGuarded = useRunGuarded();
  return (
    // 未保存の編集があるとタブは切り替えず、確認を出す。
    <Tabs value={tab} onChange={(value) => value && runGuarded(() => setTab(value as DetailTab))}>
      <Tabs.List>
        <Tabs.Tab value="characters">キャラクター</Tabs.Tab>
        <Tabs.Tab value="scenes">シーン</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="characters" pt="md">
        <CharacterTab projectId={projectId} />
      </Tabs.Panel>
      <Tabs.Panel value="scenes" pt="md">
        <SceneTab projectId={projectId} />
      </Tabs.Panel>
    </Tabs>
  );
}

/** `/projects/:projectId`。キャラクター・衣装・シーンを編集する。 */
export function ProjectDetailPage() {
  const { projectId = "" } = useParams();
  const project = useProject(projectId);
  const restore = useRestoreProjectWithNotice();

  if (project.isPending) return <Loader size="sm" />;
  // 取り直しの失敗では`data`が残る。そのときは編集欄を残し、エラーは見出しの下に出す。
  if (project.data === undefined) {
    return (
      <Stack>
        <Alert color="red" title="Projectを開けません">
          {project.error.message}
        </Alert>
        <Anchor component={Link} to="/projects">
          Project一覧へ戻る
        </Anchor>
      </Stack>
    );
  }

  const record = project.data;
  const trashed = record.lifecycle === "trashed";
  return (
    <UnsavedGuardProvider>
      <Stack>
        <Group justify="space-between" align="flex-start">
          <div>
            <Anchor component={Link} to="/projects" size="sm">
              Project一覧
            </Anchor>
            <Title order={2}>{record.name}</Title>
            {record.description ? (
              <Text c="dimmed" size="sm">
                {record.description}
              </Text>
            ) : null}
          </div>
        </Group>
        <RefetchErrorAlert error={project.error} />
        {trashed ? (
          <Alert color="yellow" title="ゴミ箱のProjectです">
            <Group>
              <Text size="sm">ゴミ箱のProjectは更新できません。復元してから編集してください。</Text>
              <Button size="xs" loading={restore.isPending} onClick={() => restore.run(record)}>
                復元してから編集
              </Button>
            </Group>
          </Alert>
        ) : null}
        {/* 警告を出している間は、両タブの編集を止める。復元すると取り直しで外れる。 */}
        <ReadOnlyContext.Provider value={trashed}>
          <DetailTabs projectId={record.id} />
        </ReadOnlyContext.Provider>
      </Stack>
    </UnsavedGuardProvider>
  );
}
