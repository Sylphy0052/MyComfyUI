import { Alert, Loader } from "@mantine/core";
import type { ReactNode } from "react";

import type { Recipe } from "../api/client";
import { useBgmRecipe } from "./useBgm";

/** BGMのRecipeを読んでから`children`を出す。読めないとき・登録が無いときは案内を出す。 */
export function WithBgmRecipe({ children }: { children: (recipe: Recipe) => ReactNode }) {
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
  return children(recipe.data);
}
