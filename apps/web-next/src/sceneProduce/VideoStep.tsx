import { Alert, Anchor, Stack } from "@mantine/core";
import { useState } from "react";
import { Link } from "react-router";

import type { StoryScene } from "../api/client";
import type { ImageTarget } from "../imageGen/imageForm";
import { type VideoStorageKeys, VideoWorkspace, WithVideoRecipes } from "../pages/VideoPage";
import { useSceneAdoptions } from "../projectDetail/useStory";

/** シーンごとに別の保存キーにする。`/video`の入力欄・結果欄とも、ほかのシーンとも混ざらない。 */
function storageKeysOf(sceneId: string): VideoStorageKeys {
  return {
    input: `web-next:scene-produce-video-input:${sceneId}`,
    results: `web-next:scene-produce-video-results:${sceneId}`,
  };
}

/** シーンの登場キャラの先頭を対象にする。動画は1人のキャラの衣装だけを使う。 */
function initialTargetOf(projectId: string, scene: StoryScene): ImageTarget {
  const first = scene.cast[0];
  return {
    projectId,
    sceneId: scene.id,
    characterId: first?.character_id ?? null,
    costumeId: first?.costume_id ?? null,
    extraCast: [],
  };
}

/**
 * シーン生成の動画の工程。`/video`の部品を、Project・Sceneを固定して埋め込む。
 * 先頭フレームと`video_motion`はワークスペースが入れる。採用したシーン画像が無いときは案内を出す。
 */
export function VideoStep({ projectId, scene }: { projectId: string; scene: StoryScene }) {
  const [target, setTarget] = useState(() => initialTargetOf(projectId, scene));
  const adoptions = useSceneAdoptions(projectId, scene.id);
  const noSceneImage = adoptions.isSuccess && !adoptions.data.some((item) => item.slot === "scene_image");
  const sceneImagePath = `/scenes/${encodeURIComponent(scene.id)}/produce?${new URLSearchParams({
    project: projectId,
    step: "scene_image",
  })}`;

  return (
    <Stack>
      {noSceneImage ? (
        <Alert color="yellow" data-testid="video-no-scene-image">
          シーン画像の工程で採用してください。採用すると先頭フレームに使えます。{" "}
          <Anchor component={Link} to={sceneImagePath} data-testid="video-scene-image-link">
            シーン画像の工程へ
          </Anchor>
        </Alert>
      ) : null}
      <WithVideoRecipes>
        {(recipes) => (
          <VideoWorkspace
            recipes={recipes}
            target={target}
            // ProjectとSceneは固定。キャラと衣装だけ選び直せる。
            onTargetChange={(next) => setTarget({ ...next, projectId, sceneId: scene.id, extraCast: [] })}
            storageKeys={storageKeysOf(scene.id)}
            embedded
          />
        )}
      </WithVideoRecipes>
    </Stack>
  );
}
