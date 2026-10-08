import { Alert, Loader } from "@mantine/core";
import type { ReactNode } from "react";

import type { Recipe } from "../api/client";
import { useVoiceRecipe } from "./useVoice";

/** 音声のRecipeを読んでから`children`を出す。読めないとき・登録が無いときは案内を出す。 */
export function WithVoiceRecipe({ children }: { children: (recipe: Recipe) => ReactNode }) {
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
  return children(recipe.data);
}
