import { Alert, Loader, Stack, Text } from "@mantine/core";

import type { StoryScene } from "../api/client";
import { ImageWorkspace } from "../imageGen/ImageWorkspace";
import { useTxt2ImgRecipe } from "../imageGen/useImageGen";
import { MediaThumb } from "../projectDetail/MediaThumb";
import { useSceneAdoptions } from "../projectDetail/useStory";
import { sceneImageKeysOf } from "./storageKeys";
import { sceneImageTargetOf } from "./stepTargets";

/** 採用済みの画像の大きさ (px)。 */
const ADOPTED_SIZE = 160;

/**
 * シーン生成のシーン画像の工程。`/image`の部品を、Project・Scene・登場キャラを固定して埋め込む。
 * 補完タグはシーンの背景・時間帯・ポーズ・表情を含む。生成Jobはシーンに紐づく。
 * 採用済みの画像は上部に出す。
 */
export function SceneImageStep({ projectId, scene }: { projectId: string; scene: StoryScene }) {
  const recipe = useTxt2ImgRecipe();
  const adoptions = useSceneAdoptions(projectId, scene.id);
  const adopted = adoptions.data?.find((item) => item.slot === "scene_image") ?? null;

  return (
    <Stack gap="md" mt="sm">
      <Stack gap={4} data-testid="scene-image-adopted" data-adopted={adopted ? "true" : "false"}>
        {adoptions.isPending ? (
          <Loader size="sm" />
        ) : adoptions.isError ? (
          <Alert color="red">{adoptions.error?.message ?? "採用済みの画像を取得できません。"}</Alert>
        ) : adopted ? (
          <>
            <MediaThumb mediaKey={`artifact:${adopted.artifact_id}`} size={ADOPTED_SIZE} alt="採用したシーン画像" />
            <Text size="xs" c="dimmed">
              採用済みのシーン画像
            </Text>
          </>
        ) : (
          <Text size="sm" c="dimmed">
            採用したシーン画像はまだありません。
          </Text>
        )}
      </Stack>
      {recipe.isPending ? <Loader size="sm" /> : null}
      {recipe.isError ? <Alert color="red">{recipe.error?.message ?? "Recipeを取得できません。"}</Alert> : null}
      {recipe.data === null ? <Alert color="yellow">新規生成のRecipeがありません。</Alert> : null}
      {recipe.data ? (
        <div data-testid="scene-image-workspace">
          {/* onTargetChangeを渡さないので、Project・Scene・登場キャラは固定される。 */}
          <ImageWorkspace
            recipe={recipe.data}
            target={sceneImageTargetOf(projectId, scene)}
            storageKeys={sceneImageKeysOf(scene.id)}
            title="シーン画像"
          />
        </div>
      ) : null}
    </Stack>
  );
}
