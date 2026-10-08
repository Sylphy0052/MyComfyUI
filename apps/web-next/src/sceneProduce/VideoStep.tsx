import { Alert, Anchor, Stack } from "@mantine/core";
import { useState } from "react";
import { Link } from "react-router";

import type { StoryScene } from "../api/client";
import { VideoWorkspace, WithVideoRecipes } from "../pages/VideoPage";
import { useSceneAdoptions } from "../projectDetail/useStory";
import { videoKeysOf } from "./storageKeys";
import { videoTargetOf } from "./stepTargets";

/**
 * シーン生成の動画の工程。`/video`の部品を、Project・Sceneを固定して埋め込む。
 * 先頭フレームと`video_motion`はワークスペースが入れる。採用したシーン画像が無いときは案内を出す。
 */
export function VideoStep({ projectId, scene }: { projectId: string; scene: StoryScene }) {
  const [target, setTarget] = useState(() => videoTargetOf(projectId, scene));
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
            storageKeys={videoKeysOf(scene.id)}
            embedded
          />
        )}
      </WithVideoRecipes>
    </Stack>
  );
}
