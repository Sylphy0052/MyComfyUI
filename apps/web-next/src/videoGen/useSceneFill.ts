import { useEffect } from "react";

import type { StoryScene } from "../api/client";
import { useSceneAdoptions } from "../projectDetail/useStory";
import { videoImage, type VideoDraft } from "./videoForm";

type Props = {
  projectId: string | null;
  sceneId: string | null;
  /** 一覧から引いたScene。まだ読めていない・無いときは`null`。 */
  scene: StoryScene | null;
  filledSceneId: string | null;
  setDraft: (update: (current: VideoDraft) => VideoDraft) => void;
};

/**
 * Sceneを選ぶと、採用済みのシーン画像を先頭フレームに、`video_motion`を自由欄に入れる。
 * 同じSceneでは入れ直さない。手で選んだ先頭フレームと、手で書いた自由欄は上書きしない。
 * 別のSceneへ切り替えたときは、前のSceneから自動で入れた分 (`auto`の先頭フレームと、補完したままの自由欄) を、
 * 新しいSceneに採用画像・動きが無ければ空へ戻す。
 */
export function useSceneFill({ projectId, sceneId, scene, filledSceneId, setDraft }: Props) {
  const adoptions = useSceneAdoptions(projectId ?? "", projectId === null ? null : sceneId);
  useEffect(() => {
    if (scene === null || !adoptions.isSuccess || filledSceneId === scene.id) return;
    const artifactId = adoptions.data.find((item) => item.slot === "scene_image")?.artifact_id ?? null;
    const motion = scene.video_motion.trim();
    setDraft((current) => {
      const firstFrame =
        artifactId !== null
          ? current.firstFrame === null || current.firstFrame.auto
            ? videoImage({ artifact_id: artifactId }, "シーンの採用画像", true)
            : current.firstFrame
          : current.firstFrame?.auto
            ? null
            : current.firstFrame;
      const promptIsFilled = current.prompt.trim() === "" || current.prompt === current.filled.motion;
      const prompt = promptIsFilled ? motion : current.prompt;
      return {
        ...current,
        firstFrame,
        prompt,
        // 自由欄を補完前の値へ戻したときだけ、補完した値の記録も消す。手で書き換えた自由欄は触らない。
        filled: {
          ...current.filled,
          sceneId: scene.id,
          motion: promptIsFilled ? (motion !== "" ? motion : null) : current.filled.motion,
        },
      };
    });
  }, [scene, adoptions.isSuccess, adoptions.data, filledSceneId, setDraft]);

  const sceneMotion = scene?.video_motion.trim() ?? "";
  /** 「Sceneの動きを入れ直す」。自由欄をSceneの動きに置き換える。 */
  const insertMotion = () =>
    setDraft((current) => ({ ...current, prompt: sceneMotion, filled: { ...current.filled, motion: sceneMotion } }));
  return { sceneMotion, insertMotion, adoptionsError: adoptions.error };
}
