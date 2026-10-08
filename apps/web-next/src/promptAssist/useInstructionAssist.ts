import { useRef, useState } from "react";

import { usePromptAssist } from "../imageGen/usePromptAssist";

/** `MediaPromptAssistCreate.instruction`の上限。 */
export const INSTRUCTION_MAX = 2000;

/** `basis`は依頼した時点の日本語欄の値 (trim済み) と`extra`をまとめた文字列。 */
type Pending<Result> = { result: Result; basis: string };

/**
 * 日本語欄の値だけを要求に送る変換 (`/video-prompt-assists`・`/music-prompt-assists`)。
 * 結果は`pending`に持ち、依頼した後で日本語欄が変わったら`stale`にして適用させない。
 * `extra`は`instruction`に添えて送る項目 (`/voice-caption-assists`の`story_character_id`など)。
 * 日本語欄と同じく、依頼した後で変わったら`stale`にする。動画とBGMは渡さない。
 */
export function useInstructionAssist<Result>(
  path: string,
  failureTitle: string,
  instruction: string,
  extra?: Record<string, unknown>,
) {
  const assist = usePromptAssist<Record<string, unknown>, Result>(path, failureTitle);
  const [pending, setPending] = useState<Pending<Result> | null>(null);
  const trimmed = instruction.trim();
  const tooLong = trimmed.length > INSTRUCTION_MAX;
  const basisNow = JSON.stringify([trimmed, extra ?? null]);
  // 依頼ごとに進める。「破棄」「適用」や再依頼の後に、古い依頼の応答が結果を戻さないようにする。
  const generation = useRef(0);

  const run = () => {
    const basis = basisNow;
    const mine = ++generation.current;
    assist.mutate(
      { instruction: trimmed, ...extra },
      {
        onSuccess: (result) => {
          if (generation.current === mine) setPending({ result, basis });
        },
      },
    );
  };

  return {
    run,
    canRun: trimmed !== "" && !tooLong && !assist.isPending,
    tooLong,
    isPending: assist.isPending,
    result: pending?.result ?? null,
    stale: pending !== null && pending.basis !== basisNow,
    clear: () => {
      generation.current += 1;
      setPending(null);
    },
  };
}
