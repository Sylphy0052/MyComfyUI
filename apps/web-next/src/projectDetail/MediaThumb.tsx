import { Box, Group, Image, Text } from "@mantine/core";
import { IconPhoto } from "@tabler/icons-react";

import { artifactContentUrl, imageReferenceUrl } from "../api/client";

const ARTIFACT_PREFIX = "artifact:";
const INPUT_PREFIX = "input:";

/** media key (`artifact:<id>`か`input:<relative_path>`) が生成物を指すなら、そのID。 */
export function artifactIdOf(mediaKey: string): string | null {
  return mediaKey.startsWith(ARTIFACT_PREFIX) ? mediaKey.slice(ARTIFACT_PREFIX.length) : null;
}

function imageUrlOf(mediaKey: string): string | null {
  const artifactId = artifactIdOf(mediaKey);
  if (artifactId !== null) return artifactContentUrl(artifactId);
  if (mediaKey.startsWith(INPUT_PREFIX)) return imageReferenceUrl(mediaKey.slice(INPUT_PREFIX.length));
  return null;
}

/** 親の幅と高さいっぱいに広げたときの代替アイコンの大きさ。 */
const FILL_ICON_SIZE = 20;

/**
 * 画像のmedia keyを正方形のサムネイルにする。`size="fill"`なら親 (ViewerのグリッドのAspectRatio) いっぱいに広げる。
 * 画像が無いときはアイコンを出し、`label` (生成物の種類など) があれば横に添える。
 */
export function MediaThumb({
  mediaKey,
  size = 64,
  alt = "",
  label,
}: {
  mediaKey: string | null;
  size?: number | "fill";
  alt?: string;
  label?: string;
}) {
  const url = mediaKey === null ? null : imageUrlOf(mediaKey);
  const fill = size === "fill";
  const box = fill ? "100%" : size;
  if (url === null) {
    const icon = <IconPhoto size={fill ? FILL_ICON_SIZE : size / 2} stroke={1.2} />;
    return (
      <Box
        w={box}
        h={box}
        bg="var(--mantine-color-default-hover)"
        style={{ display: "grid", placeItems: "center", borderRadius: fill ? 0 : 4, flexShrink: 0 }}
      >
        {label ? (
          <Group gap={4}>
            {icon}
            <Text size="xs">{label}</Text>
          </Group>
        ) : (
          icon
        )}
      </Box>
    );
  }
  return (
    <Image
      src={url}
      alt={alt}
      w={box}
      h={box}
      fit="cover"
      radius={fill ? 0 : "sm"}
      loading="lazy"
      style={{ flexShrink: 0 }}
    />
  );
}
