import { Alert, Loader } from "@mantine/core";

import { VoiceWorkspace } from "../pages/VoicePage";
import { useVoiceRecipe, type VoiceStorageKeys } from "../voice/useVoice";

/** シーン生成の音声の入力値は、`/voice`の保存値を上書きしないよう別のキーに残す。 */
const STORAGE_KEYS: VoiceStorageKeys = {
  input: "web-next:scene-produce-voice-input",
  results: "web-next:scene-produce-voice-results",
};

/** 音声の工程。`/voice`の部品を、Project・Sceneを固定して埋め込む。 */
export function VoiceStep({ projectId, sceneId }: { projectId: string; sceneId: string }) {
  const recipe = useVoiceRecipe();
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
      <Alert color="yellow" title="音声生成のRecipeがありません">
        音声のRecipeを登録してから開いてください。
      </Alert>
    );
  }
  return <VoiceWorkspace recipe={recipe.data} target={{ projectId, sceneId }} storageKeys={STORAGE_KEYS} />;
}
