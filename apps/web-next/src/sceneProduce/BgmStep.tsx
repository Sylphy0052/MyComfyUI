import { WithBgmRecipe } from "../bgm/WithBgmRecipe";
import { BgmWorkspace } from "../pages/BgmPage";
import { bgmKeysOf } from "./storageKeys";

/** BGMの工程。`/bgm`の部品を、Project・Sceneを固定して埋め込む。 */
export function BgmStep({ projectId, sceneId }: { projectId: string; sceneId: string }) {
  return (
    <WithBgmRecipe>
      {(recipe) => <BgmWorkspace recipe={recipe} target={{ projectId, sceneId }} storageKeys={bgmKeysOf(sceneId)} />}
    </WithBgmRecipe>
  );
}
