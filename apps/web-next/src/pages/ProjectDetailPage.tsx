import { Alert, Anchor, Button, Group, Loader, Stack, Tabs, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { Link, useParams } from "react-router";

import { useProject } from "../layout/projectContext";
import { CharacterTab } from "../projectDetail/CharacterTab";
import { SceneTab } from "../projectDetail/SceneTab";
import { UnsavedGuardProvider, useRunGuarded } from "../projectDetail/unsavedGuard";
import { useRestoreProject } from "../projects/useProjects";

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
  const restore = useRestoreProject();

  if (project.isPending) return <Loader size="sm" />;
  if (project.error) {
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
        {record.lifecycle === "trashed" ? (
          <Alert color="yellow" title="ゴミ箱のProjectです">
            <Group>
              <Text size="sm">ゴミ箱のProjectは更新できません。復元してから編集してください。</Text>
              <Button
                size="xs"
                loading={restore.isPending}
                onClick={() =>
                  restore.mutate(record.id, {
                    onSuccess: () => notifications.show({ color: "green", message: "Projectを復元しました" }),
                    onError: (error) =>
                      notifications.show({ color: "red", title: "復元できません", message: error.message }),
                  })
                }
              >
                復元してから編集
              </Button>
            </Group>
          </Alert>
        ) : null}
        <DetailTabs projectId={record.id} />
      </Stack>
    </UnsavedGuardProvider>
  );
}
