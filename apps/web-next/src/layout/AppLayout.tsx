import { ActionIcon, Anchor, AppShell, Button, Group, NavLink, Text, Title, Tooltip } from "@mantine/core";
import { useDisclosure, useLocalStorage } from "@mantine/hooks";
import { Notifications, notifications } from "@mantine/notifications";
import {
  IconFolders,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMicrophone,
  IconMovie,
  IconMusic,
  IconPhoto,
  IconPhotoSearch,
  IconSettings,
  type Icon,
} from "@tabler/icons-react";
import { useCallback } from "react";
import { Link, NavLink as RouterNavLink, Outlet } from "react-router";

import { useApiEvents, type ApiEvent } from "../api/events";
import { JobDrawer } from "../jobs/JobDrawer";
import { jobResultPath, useJobBoard } from "../jobs/useJobs";
import { projectSearch, useCurrentProjectId, useProject } from "./projectContext";
import { QwenSettingsModal } from "./QwenSettingsModal";

type NavItem = { path: string; label: string; icon: Icon };

const NAV_ITEMS: NavItem[] = [
  { path: "/projects", label: "Project", icon: IconFolders },
  { path: "/image", label: "画像", icon: IconPhoto },
  { path: "/video", label: "動画", icon: IconMovie },
  { path: "/voice", label: "音声", icon: IconMicrophone },
  { path: "/bgm", label: "BGM", icon: IconMusic },
  { path: "/viewer", label: "Viewer", icon: IconPhotoSearch },
];

const NAV_WIDTH = { expanded: 200, collapsed: 60 };

function SideNav({ collapsed }: { collapsed: boolean }) {
  const projectId = useCurrentProjectId();
  return (
    <AppShell.Section grow>
      {NAV_ITEMS.map(({ path, label, icon: ItemIcon }) => {
        const link = (
          <NavLink
            key={path}
            component={RouterNavLink}
            to={{ pathname: path, search: projectSearch(projectId) }}
            label={collapsed ? null : label}
            aria-label={label}
            leftSection={<ItemIcon size={20} stroke={1.6} />}
          />
        );
        return collapsed ? (
          <Tooltip key={path} label={label} position="right">
            {link}
          </Tooltip>
        ) : (
          link
        );
      })}
    </AppShell.Section>
  );
}

function CurrentProject() {
  const projectId = useCurrentProjectId();
  const { data: project, error } = useProject(projectId);
  if (!projectId) return <Text size="sm" c="dimmed">Project未選択</Text>;
  return (
    <Anchor component={Link} to={`/projects/${encodeURIComponent(projectId)}`} size="sm">
      {project?.name ?? (error ? "Projectを読めません" : "読み込み中")}
    </Anchor>
  );
}

function JobCounter({ onOpen }: { onOpen: () => void }) {
  const { data: board, isError } = useJobBoard();
  // 取得に失敗したまま0件と出すと、Jobが無いように見えてしまう。
  if (isError || !board) {
    return (
      <Button variant="default" size="xs" color={isError ? "red" : undefined} onClick={onOpen}>
        {isError ? "Jobを取得できません" : "Job"}
      </Button>
    );
  }
  const more = board.truncated ? "+" : "";
  return (
    <Button variant="default" size="xs" onClick={onOpen}>
      実行中{board.running}{more}・待機{board.queued}{more}
    </Button>
  );
}

/** 完了は結果へのリンク、失敗は理由を見るためにJobのドロワーを開くボタンを付けて知らせる。 */
function notifyJobFinished(event: ApiEvent, openDrawer: () => void): void {
  const state = event.payload.state;
  const jobId = event.payload.job_id;
  if (typeof jobId !== "string" || (state !== "succeeded" && state !== "failed")) return;
  const id = `job-${jobId}-${state}`;
  if (state === "succeeded") {
    notifications.show({
      id,
      color: "green",
      title: "Jobが完了しました",
      message: (
        <Anchor component={Link} to={jobResultPath(jobId)} size="sm" onClick={() => notifications.hide(id)}>
          結果を開く
        </Anchor>
      ),
      autoClose: 5000,
    });
    return;
  }
  notifications.show({
    id,
    color: "red",
    title: "Jobが失敗しました",
    message: (
      <Anchor
        component="button"
        size="sm"
        onClick={() => {
          notifications.hide(id);
          openDrawer();
        }}
      >
        詳細を見る
      </Anchor>
    ),
    autoClose: false,
  });
}

export function AppLayout() {
  const [navCollapsed, setNavCollapsed] = useLocalStorage({ key: "web-next:nav-collapsed", defaultValue: false });
  const [drawerOpened, drawer] = useDisclosure(false);
  const [qwenOpened, qwen] = useDisclosure(false);
  const openDrawer = drawer.open;
  useApiEvents(useCallback((event: ApiEvent) => notifyJobFinished(event, openDrawer), [openDrawer]));

  return (
    <AppShell
      header={{ height: 52 }}
      navbar={{ width: navCollapsed ? NAV_WIDTH.collapsed : NAV_WIDTH.expanded, breakpoint: 0 }}
      padding="md"
    >
      <Notifications position="bottom-right" />
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <ActionIcon
              variant="subtle"
              onClick={() => setNavCollapsed((value) => !value)}
              aria-label={navCollapsed ? "ナビを広げる" : "ナビを畳む"}
            >
              {navCollapsed ? <IconLayoutSidebarLeftExpand size={20} /> : <IconLayoutSidebarLeftCollapse size={20} />}
            </ActionIcon>
            <Title order={4}>MyComfyUI</Title>
            <CurrentProject />
          </Group>
          <Group gap="xs">
            <JobCounter onOpen={drawer.open} />
            <ActionIcon variant="subtle" onClick={qwen.open} aria-label="Qwen設定">
              <IconSettings size={20} />
            </ActionIcon>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p={4}>
        <SideNav collapsed={navCollapsed} />
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
      <JobDrawer opened={drawerOpened} onClose={drawer.close} />
      <QwenSettingsModal opened={qwenOpened} onClose={qwen.close} />
    </AppShell>
  );
}
