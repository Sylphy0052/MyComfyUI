import {
  ActionIcon,
  Badge,
  Box,
  Checkbox,
  Group,
  Paper,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import {
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
} from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { artifactContentUrl, type MediaItem } from "../api/client";
import { useCharacters, useScenes } from "../projectDetail/useStory";
import { useProjectList } from "../projects/useProjects";
import { LoadMoreSentinel } from "./MediaGrid";

const DECISION_BADGES: Record<string, { label: string; color: string }> = {
  accepted: { label: "採用", color: "teal" },
  rejected: { label: "不採用", color: "red" },
};

function formatSeconds(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

type NamedQuery = {
  data: { id: string; name: string }[] | undefined;
  isError: boolean;
};

/**
 * 一覧から名前を引く。取得中は`null` (表示しない)。取得に失敗したら「取得できません」、
 * 一覧に無ければ「削除済み」、名前が空なら「名前なし」。SceneとキャラでWordingをそろえる。
 */
function linkName(query: NamedQuery, id: string): string | null {
  if (query.data) {
    const entry = query.data.find((candidate) => candidate.id === id);
    if (!entry) return "(削除済み)";
    return entry.name || "(名前なし)";
  }
  return query.isError ? "(取得できません)" : null;
}

/** 行に出す紐づけ名 (Scene・キャラ)。Projectがあるときだけ、そのProjectのScene・キャラ一覧から名前を引く。 */
function useLinkNames(item: MediaItem, showCharacters: boolean) {
  const projectId = item.assigned_project_id ?? null;
  const scenes = useScenes(projectId);
  const characters = useCharacters(projectId, showCharacters);
  const sceneId = item.story_scene_id ?? null;
  const scene = sceneId === null ? null : linkName(scenes, sceneId);
  const characterIds = [
    ...new Set(
      [item.story_character_id, ...(item.character_ids ?? [])].filter(
        (id): id is string => !!id,
      ),
    ),
  ];
  const characterNames = showCharacters
    ? characterIds
        .map((id) => linkName(characters, id))
        .filter((name): name is string => name !== null)
    : [];
  return { scene, characterNames };
}

type RowProps = {
  item: MediaItem;
  projectName: string | null;
  selected: boolean;
  /** 音声のときだけ紐づくキャラを出す (BGMにキャラは無い)。 */
  showCharacters: boolean;
  playing: boolean;
  position: number;
  failed: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onPlay: () => void;
};

function Row({
  item,
  projectName,
  selected,
  showCharacters,
  playing,
  position,
  failed,
  onToggle,
  onOpen,
  onPlay,
}: RowProps) {
  const { scene, characterNames } = useLinkNames(item, showCharacters);
  const badge = item.decision ? DECISION_BADGES[item.decision] : undefined;
  const place = [projectName, scene]
    .filter((part): part is string => !!part)
    .join(" / ");
  return (
    <Paper
      withBorder
      p="xs"
      radius="sm"
      data-testid="viewer-item"
      data-artifact-id={item.artifact_id}
      data-playing={playing ? "true" : "false"}
      style={{
        outline: selected
          ? "2px solid var(--mantine-primary-color-filled)"
          : undefined,
      }}
    >
      <Group gap="sm" wrap="nowrap">
        <Checkbox aria-label="選択" checked={selected} onChange={onToggle} />
        <ActionIcon
          variant={playing ? "filled" : "light"}
          color={failed ? "red" : undefined}
          radius="xl"
          size="lg"
          aria-label={playing ? "停止" : "再生"}
          onClick={onPlay}
        >
          {playing ? (
            <IconPlayerPauseFilled size={18} />
          ) : (
            <IconPlayerPlayFilled size={18} />
          )}
        </ActionIcon>
        <UnstyledButton
          onClick={onOpen}
          aria-label="開く"
          style={{ flex: 1, minWidth: 0 }}
        >
          <Stack gap={0}>
            <Text size="sm" truncate>
              {place || "Project無し"}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {showCharacters && characterNames.length > 0
                ? `${characterNames.join("、")} / `
                : ""}
              {new Date(item.created_at).toLocaleString("ja-JP")}
            </Text>
          </Stack>
        </UnstyledButton>
        {failed ? (
          <Text size="xs" c="red" data-testid="audio-error">
            再生できません
          </Text>
        ) : playing ? (
          <Text size="xs" c="dimmed" data-testid="audio-position">
            {formatSeconds(position)}
          </Text>
        ) : null}
        {badge ? (
          <Badge size="sm" color={badge.color}>
            {badge.label}
          </Badge>
        ) : null}
      </Group>
    </Paper>
  );
}

/**
 * 音声・BGMの行リスト。波形は出さない。再生ボタンでドロワーを開かずに再生する。
 * `<audio>`は1つだけ持ち、別の行を再生したら差し替えるので、前の行は止まる。
 */
export function AudioList({
  items,
  showCharacters,
  selected,
  onToggle,
  onOpen,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  empty,
}: {
  items: MediaItem[];
  showCharacters: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  empty: ReactNode;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const projects = useProjectList("active");
  const projectNames = new Map(
    (projects.data ?? []).map((project) => [project.id, project.name]),
  );

  // 再生中の行がゴミ箱へ移るなどして一覧から消えたら止める。
  const playingGone =
    playingId !== null && !items.some((item) => item.artifact_id === playingId);
  useEffect(() => {
    if (!playingGone) return;
    audioRef.current?.pause();
    setPlayingId(null);
  }, [playingGone]);

  const play = (id: string) => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (playingId === id) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    audio.src = artifactContentUrl(id);
    setPosition(0);
    setFailedId(null);
    setPlayingId(id);
    audio.play().catch(() => {
      // 読み込み失敗は`onError`でも来る。ここは別の再生に差し替えられた中断を除いて失敗扱いにする。
      if (audioRef.current?.src === audio.src && audio.error !== null) {
        setFailedId(id);
        setPlayingId(null);
      }
    });
  };

  if (items.length === 0 && !hasNextPage) return <>{empty}</>;
  return (
    <>
      <audio
        ref={audioRef}
        data-testid="audio-player"
        preload="none"
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onEnded={() => setPlayingId(null)}
        onError={() => {
          setFailedId(playingId);
          setPlayingId(null);
        }}
      />
      <Stack gap="xs">
        {items.map((item) => {
          const id = item.artifact_id as string;
          return (
            <Row
              key={id}
              item={item}
              projectName={
                projectNames.get(item.assigned_project_id ?? "") ?? null
              }
              selected={selected.has(id)}
              showCharacters={showCharacters}
              playing={playingId === id}
              position={playingId === id ? position : 0}
              failed={failedId === id}
              onToggle={() => onToggle(id)}
              onOpen={() => onOpen(id)}
              onPlay={() => play(id)}
            />
          );
        })}
      </Stack>
      <Box>
        <LoadMoreSentinel
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={onLoadMore}
        />
      </Box>
    </>
  );
}
