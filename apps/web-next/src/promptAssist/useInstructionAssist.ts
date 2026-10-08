import { useRef, useState } from "react";

import type { MediaPromptAssistBody } from "../api/client";
import { usePromptAssist } from "../imageGen/usePromptAssist";

/** `MediaPromptAssistCreate.instruction`の上限。 */
export const INSTRUCTION_MAX = 2000;

/** `basis`は依頼した時点の日本語欄の値 (trim済み)。 */
type Pending<Result> = { result: Result; basis: string };

/**
 * 日本語欄の値だけを要求に送る変換 (`/video-prompt-assists`・`/music-prompt-assists`)。
 * 結果は`pending`に持ち、依頼した後で日本語欄が変わったら`stale`にして適用させない。
 */
export function useInstructionAssist<Result>(path: string, failureTitle: string, instruction: string) {
  const assist = usePromptAssist<MediaPromptAssistBody, Result>(path, failureTitle);
  const [pending, setPending] = useState<Pending<Result> | null>(null);
  const trimmed = instruction.trim();
  const tooLong = trimmed.length > INSTRUCTION_MAX;
  // 依頼ごとに進める。「破棄」「適用」や再依頼の後に、古い依頼の応答が結果を戻さないようにする。
  const generation = useRef(0);

  const run = () => {
    const basis = trimmed;
    const mine = ++generation.current;
    assist.mutate(
      { instruction: trimmed },
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
    stale: pending !== null && pending.basis !== trimmed,
    clear: () => {
      generation.current += 1;
      setPending(null);
    },
  };
}
