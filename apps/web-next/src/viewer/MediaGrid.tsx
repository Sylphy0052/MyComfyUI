import { AspectRatio, Badge, Box, Card, Checkbox, Loader, SimpleGrid, Text, UnstyledButton } from "@mantine/core";
import { useEffect, useRef, type ReactNode } from "react";

import { artifactContentUrl } from "../api/client";
import { MediaThumb } from "../projectDetail/MediaThumb";

export type GridItem = {
  id: string;
  kind: string;
  decision: string | null;
  createdAt: string;
};

const DECISION_BADGES: Record<string, { label: string; color: string }> = {
  accepted: { label: "採用", color: "teal" },
  rejected: { label: "不採用", color: "red" },
};

/** 動画のサムネイル。サーバで画像を作らず、`preload="metadata"`で先頭フレームを出す。 */
function VideoThumb({ artifactId }: { artifactId: string }) {
  return (
    <video
      // 先頭の0フレームは描画されないことがあるので、少しだけ進めた位置を指す。
      src={`${artifactContentUrl(artifactId)}#t=0.1`}
      preload="metadata"
      muted
      playsInline
      aria-hidden
      data-testid="video-thumb"
      style={{ width: "100%", height: "100%", objectFit: "cover", background: "var(--mantine-color-default-hover)" }}
    />
  );
}

/** 1件のサムネイル。左上のチェックで選び、画像の部分を押すと`onOpen`を呼ぶ。 */
function Tile({
  item,
  selected,
  onToggle,
  onOpen,
}: {
  item: GridItem;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const badge = item.decision ? DECISION_BADGES[item.decision] : undefined;
  return (
    <Card
      withBorder
      padding={0}
      radius="sm"
      data-testid="viewer-item"
      data-artifact-id={item.id}
      style={{
        position: "relative",
        outline: selected ? "2px solid var(--mantine-primary-color-filled)" : undefined,
      }}
    >
      <UnstyledButton onClick={onOpen} aria-label="開く" style={{ display: "block" }}>
        <AspectRatio ratio={1}>
          {item.kind === "video" ? (
            <VideoThumb artifactId={item.id} />
          ) : (
            <MediaThumb
              mediaKey={item.kind === "image" ? `artifact:${item.id}` : null}
              size="fill"
              label={item.kind === "image" ? undefined : item.kind}
            />
          )}
        </AspectRatio>
      </UnstyledButton>
      <Checkbox
        aria-label="選択"
        checked={selected}
        onChange={onToggle}
        style={{ position: "absolute", top: 6, left: 6 }}
      />
      {badge ? (
        <Badge size="xs" color={badge.color} style={{ position: "absolute", top: 6, right: 6 }}>
          {badge.label}
        </Badge>
      ) : null}
      <Text size="xs" c="dimmed" px={6} py={2} truncate>
        {new Date(item.createdAt).toLocaleString("ja-JP")}
      </Text>
    </Card>
  );
}

/** 一覧の末尾。画面に入ったら次のページを読む。 */
function LoadMoreSentinel({
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element || !hasNextPage || isFetchingNextPage) return;
    // 読み終えるたびに作り直すので、読んだ後も末尾が見えたままなら続けて読む。
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMoreRef.current();
      },
      { rootMargin: "400px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage]);
  return (
    <Box ref={ref} py="sm" style={{ display: "grid", placeItems: "center" }} data-testid="load-more">
      {isFetchingNextPage ? <Loader size="sm" /> : null}
    </Box>
  );
}

/** サムネイルのグリッド。スクロールで続きを読む。 */
export function MediaGrid({
  items,
  selected,
  onToggle,
  onOpen,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  empty,
}: {
  items: GridItem[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  empty: ReactNode;
}) {
  if (items.length === 0 && !hasNextPage) return <>{empty}</>;
  return (
    <>
      <SimpleGrid cols={{ base: 2, sm: 4, md: 5, lg: 6 }} spacing="sm">
        {items.map((item) => (
          <Tile
            key={item.id}
            item={item}
            selected={selected.has(item.id)}
            onToggle={() => onToggle(item.id)}
            onOpen={() => onOpen(item.id)}
          />
        ))}
      </SimpleGrid>
      <LoadMoreSentinel hasNextPage={hasNextPage} isFetchingNextPage={isFetchingNextPage} onLoadMore={onLoadMore} />
    </>
  );
}
