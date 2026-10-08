import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Group,
  Loader,
  Menu,
  Modal,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDots, IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import type { ProjectRecord } from "../api/client";
import {
  useCreateProject,
  usePurgeProject,
  useProjectList,
  useRestoreProject,
  useTrashProject,
  useUpdateProject,
  type ProjectDraft,
  type ProjectTab,
} from "../projects/useProjects";

/** API (`schemas.py`の`ProjectName`と`ProjectCreate.description`) の上限に合わせる。 */
const NAME_MAX = 120;
const DESCRIPTION_MAX = 10_000;

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP");
}

function notifyError(title: string, error: Error) {
  notifications.show({ color: "red", title, message: error.message });
}

/** 作成と編集で共用するフォーム。`project`があれば編集として開く。 */
function ProjectFormModal({
  opened,
  project,
  onClose,
}: {
  opened: boolean;
  project: ProjectRecord | null;
  onClose: () => void;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title={project ? "Projectを編集" : "Projectを作成"}>
      {/* 開くたびに入力を元の値へ戻すため、閉じている間はフォームを描画しない。 */}
      {opened ? <ProjectForm project={project} onDone={onClose} /> : null}
    </Modal>
  );
}

function ProjectForm({ project, onDone }: { project: ProjectRecord | null; onDone: () => void }) {
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const create = useCreateProject();
  const update = useUpdateProject();
  const mutation = project ? update : create;
  const trimmedName = name.trim();
  const nameError = trimmedName.length > NAME_MAX ? `${NAME_MAX}文字以内で入力してください` : null;

  const submit = () => {
    const draft: ProjectDraft = { name: trimmedName, description: description.trim() || null };
    const onSuccess = () => {
      notifications.show({ color: "green", message: project ? "Projectを保存しました" : "Projectを作成しました" });
      onDone();
    };
    if (project) update.mutate({ id: project.id, draft }, { onSuccess });
    else create.mutate(draft, { onSuccess });
  };

  return (
    <Stack>
      <TextInput
        label="名前"
        required
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        error={nameError}
        data-autofocus
      />
      <Textarea
        label="説明"
        autosize
        minRows={3}
        maxRows={10}
        maxLength={DESCRIPTION_MAX}
        value={description}
        onChange={(event) => setDescription(event.currentTarget.value)}
      />
      {mutation.error ? <Text c="red" size="sm">{mutation.error.message}</Text> : null}
      <Group justify="flex-end">
        <Button variant="default" onClick={onDone}>
          キャンセル
        </Button>
        <Button onClick={submit} loading={mutation.isPending} disabled={trimmedName === "" || nameError !== null}>
          {project ? "保存" : "作成"}
        </Button>
      </Group>
    </Stack>
  );
}

function PurgeModal({
  opened,
  project,
  onClose,
}: {
  opened: boolean;
  project: ProjectRecord | null;
  onClose: () => void;
}) {
  const purge = usePurgeProject();
  const close = () => {
    purge.reset();
    onClose();
  };
  const submit = () => {
    if (!project) return;
    purge.mutate(project.id, {
      onSuccess: (result) => {
        notifications.show({
          color: "green",
          message: `「${project.name}」を完全に削除しました。生成物${result.detached_artifact_count}件をProject無しで残しました`,
        });
        close();
      },
    });
  };

  return (
    <Modal opened={opened} onClose={close} title="Projectを完全に削除">
      <Stack>
        <Text size="sm">「{project?.name}」を完全に削除します。この操作は取り消せません。</Text>
        <Text size="sm">
          消えるのはProject・キャラクター・衣装・シーンの定義だけです。生成物は消えず、「Project無し」としてViewerに残ります。要らない生成物はViewerで個別に削除してください。
        </Text>
        {purge.error ? <Text c="red" size="sm">{purge.error.message}</Text> : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            キャンセル
          </Button>
          <Button color="red" onClick={submit} loading={purge.isPending}>
            完全に削除
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ProjectCard({
  project,
  tab,
  onEdit,
  onPurge,
}: {
  project: ProjectRecord;
  tab: ProjectTab;
  onEdit: (project: ProjectRecord) => void;
  onPurge: (project: ProjectRecord) => void;
}) {
  const navigate = useNavigate();
  const trash = useTrashProject();
  const restore = useRestoreProject();
  const active = tab === "active";

  const moveToTrash = () =>
    trash.mutate(project.id, {
      onSuccess: () => notifications.show({ message: `「${project.name}」をゴミ箱へ移しました` }),
      onError: (error) => notifyError("ゴミ箱へ移せません", error),
    });
  const restoreFromTrash = () =>
    restore.mutate(project.id, {
      onSuccess: () => notifications.show({ color: "green", message: `「${project.name}」を復元しました` }),
      onError: (error) => notifyError("復元できません", error),
    });

  return (
    <Card
      withBorder
      padding="md"
      // ゴミ箱のProjectは復元するまで開けない (更新も受け付けないため)。
      onClick={active ? () => navigate(`/projects/${encodeURIComponent(project.id)}`) : undefined}
      style={active ? { cursor: "pointer" } : undefined}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Text fw={600} lineClamp={2}>
            {project.name}
          </Text>
          {active ? (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={`${project.name}の操作`}
                  loading={trash.isPending}
                  onClick={(event) => event.stopPropagation()}
                >
                  <IconDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown onClick={(event) => event.stopPropagation()}>
                <Menu.Item onClick={() => onEdit(project)}>編集</Menu.Item>
                <Menu.Item color="red" onClick={moveToTrash}>
                  ゴミ箱へ移す
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          ) : null}
        </Group>
        {project.description ? (
          <Text size="sm" c="dimmed" lineClamp={3}>
            {project.description}
          </Text>
        ) : null}
        <Text size="xs" c="dimmed">
          {active
            ? `更新: ${formatDateTime(project.updated_at)}`
            : `削除: ${formatDateTime(project.deleted_at ?? project.updated_at)}`}
        </Text>
        <Text size="xs" c="dimmed">
          作成: {formatDateTime(project.created_at)}
        </Text>
        {active ? null : (
          <Group gap="xs">
            <Button size="xs" variant="default" onClick={restoreFromTrash} loading={restore.isPending}>
              復元
            </Button>
            <Button size="xs" color="red" variant="light" onClick={() => onPurge(project)}>
              完全に削除
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}

function ProjectGrid({
  tab,
  onEdit,
  onPurge,
}: {
  tab: ProjectTab;
  onEdit: (project: ProjectRecord) => void;
  onPurge: (project: ProjectRecord) => void;
}) {
  const { data, error, isPending } = useProjectList(tab);
  if (isPending) return <Loader size="sm" />;
  if (error) return <Alert color="red" title="Projectを取得できません">{error.message}</Alert>;
  if (data.length === 0) {
    return <Text c="dimmed">{tab === "active" ? "Projectがありません" : "ゴミ箱は空です"}</Text>;
  }
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
      {data.map((project) => (
        <ProjectCard key={project.id} project={project} tab={tab} onEdit={onEdit} onPurge={onPurge} />
      ))}
    </SimpleGrid>
  );
}

export function ProjectsPage() {
  const [tab, setTab] = useState<ProjectTab>("active");
  const [form, setForm] = useState<{ opened: boolean; project: ProjectRecord | null }>({
    opened: false,
    project: null,
  });
  // 閉じるアニメーションの間も名前を出し続けるため、開閉とは別に対象を残す。
  const [purge, setPurge] = useState<{ opened: boolean; project: ProjectRecord | null }>({
    opened: false,
    project: null,
  });

  const openEdit = (project: ProjectRecord) => setForm({ opened: true, project });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Project</Title>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setForm({ opened: true, project: null })}>
          新規作成
        </Button>
      </Group>
      <Tabs value={tab} onChange={(value) => setTab(value === "trashed" ? "trashed" : "active")}>
        <Tabs.List>
          <Tabs.Tab value="active">一覧</Tabs.Tab>
          <Tabs.Tab value="trashed">ゴミ箱</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      <ProjectGrid tab={tab} onEdit={openEdit} onPurge={(project) => setPurge({ opened: true, project })} />
      <ProjectFormModal
        opened={form.opened}
        project={form.project}
        onClose={() => setForm((current) => ({ ...current, opened: false }))}
      />
      <PurgeModal
        opened={purge.opened}
        project={purge.project}
        onClose={() => setPurge((current) => ({ ...current, opened: false }))}
      />
    </Stack>
  );
}
