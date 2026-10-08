import { VoiceWorkspace } from "../pages/VoicePage";
import { WithVoiceRecipe } from "../voice/WithVoiceRecipe";
import { voiceKeysOf } from "./storageKeys";

/** 音声の工程。`/voice`の部品を、Project・Sceneを固定して埋め込む。 */
export function VoiceStep({ projectId, sceneId }: { projectId: string; sceneId: string }) {
  return (
    <WithVoiceRecipe>
      {(recipe) => (
        <VoiceWorkspace recipe={recipe} target={{ projectId, sceneId }} storageKeys={voiceKeysOf(sceneId)} />
      )}
    </WithVoiceRecipe>
  );
}
