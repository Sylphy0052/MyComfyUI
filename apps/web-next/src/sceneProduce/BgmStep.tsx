import type { BgmStorageKeys } from "../bgm/useBgm";
import { WithBgmRecipe } from "../bgm/WithBgmRecipe";
import { BgmWorkspace } from "../pages/BgmPage";

/** シーンごとに別の保存キーにする。`/bgm`の保存値とも、ほかのシーンとも混ざらない。 */
function storageKeysOf(sceneId: string): BgmStorageKeys {
  return {
    input: `web-next:scene-produce-bgm-input:${sceneId}`,
    results: `web-next:scene-produce-bgm-results:${sceneId}`,
  };
}

/** BGMの工程。`/bgm`の部品を、Project・Sceneを固定して埋め込む。 */
export function BgmStep({ projectId, sceneId }: { projectId: string; sceneId: string }) {
  return (
    <WithBgmRecipe>
      {(recipe) => <BgmWorkspace recipe={recipe} target={{ projectId, sceneId }} storageKeys={storageKeysOf(sceneId)} />}
    </WithBgmRecipe>
  );
}
