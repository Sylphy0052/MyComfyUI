import { Alert, Loader } from "@mantine/core";

import { type BgmStorageKeys, useBgmRecipe } from "../bgm/useBgm";
import { BgmWorkspace } from "../pages/BgmPage";

/** シーン生成のBGMの入力値は、`/bgm`の保存値を上書きしないよう別のキーに残す。 */
const STORAGE_KEYS: BgmStorageKeys = {
  input: "web-next:scene-produce-bgm-input",
  results: "web-next:scene-produce-bgm-results",
};

/** BGMの工程。`/bgm`の部品を、Project・Sceneを固定して埋め込む。 */
export function BgmStep({ projectId, sceneId }: { projectId: string; sceneId: string }) {
  const recipe = useBgmRecipe();
  if (recipe.isPending) return <Loader size="sm" />;
  if (recipe.error) {
    return (
      <Alert color="red" title="Recipeを読めません">
        {recipe.error.message}
      </Alert>
    );
  }
  if (recipe.data === null) {
    return (
      <Alert color="yellow" title="BGM生成のRecipeがありません">
        ace_step_bgmのRecipeを登録してから開いてください。
      </Alert>
    );
  }
  return <BgmWorkspace recipe={recipe.data} target={{ projectId, sceneId }} storageKeys={STORAGE_KEYS} />;
}
