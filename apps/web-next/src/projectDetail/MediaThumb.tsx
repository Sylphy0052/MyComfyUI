import { Box, Image } from "@mantine/core";
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

/** 画像のmedia keyを正方形のサムネイルにする。 */
export function MediaThumb({
  mediaKey,
  size = 64,
  alt = "",
}: {
  mediaKey: string | null;
  size?: number;
  alt?: string;
}) {
  const url = mediaKey === null ? null : imageUrlOf(mediaKey);
  if (url === null) {
    return (
      <Box
        w={size}
        h={size}
        bg="var(--mantine-color-default-hover)"
        style={{ display: "grid", placeItems: "center", borderRadius: 4, flexShrink: 0 }}
      >
        <IconPhoto size={size / 2} stroke={1.2} />
      </Box>
    );
  }
  return <Image src={url} alt={alt} w={size} h={size} fit="cover" radius="sm" style={{ flexShrink: 0 }} />;
}
