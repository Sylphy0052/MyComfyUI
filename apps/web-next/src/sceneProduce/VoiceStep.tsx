import { VoiceWorkspace } from "../pages/VoicePage";
import type { VoiceStorageKeys } from "../voice/useVoice";
import { WithVoiceRecipe } from "../voice/WithVoiceRecipe";

/** シーンごとに別の保存キーにする。`/voice`の保存値とも、ほかのシーンとも混ざらない。 */
function storageKeysOf(sceneId: string): VoiceStorageKeys {
  return {
    input: `web-next:scene-produce-voice-input:${sceneId}`,
    results: `web-next:scene-produce-voice-results:${sceneId}`,
  };
}

/** 音声の工程。`/voice`の部品を、Project・Sceneを固定して埋め込む。 */
export function VoiceStep({ projectId, sceneId }: { projectId: string; sceneId: string }) {
  return (
    <WithVoiceRecipe>
      {(recipe) => (
        <VoiceWorkspace recipe={recipe} target={{ projectId, sceneId }} storageKeys={storageKeysOf(sceneId)} />
      )}
    </WithVoiceRecipe>
  );
}
