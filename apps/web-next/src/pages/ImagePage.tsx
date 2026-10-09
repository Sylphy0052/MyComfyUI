import { Alert, Loader } from "@mantine/core";
import { useCallback } from "react";
import { useSearchParams } from "react-router";

import { ImageWorkspace } from "../imageGen/ImageWorkspace";
import { IMAGE_PAGE_STORAGE_KEYS, type ImageTarget } from "../imageGen/imageForm";
import { paramsFromTarget, targetFromParams } from "../imageGen/targetParams";
import { useTxt2ImgRecipe } from "../imageGen/useImageGen";

/** `/image`。新規・参照・修正の入力欄と、この画面から投入した生成の結果欄。 */
export function ImagePage() {
  const recipe = useTxt2ImgRecipe();
  const [searchParams, setSearchParams] = useSearchParams();
  const changeTarget = useCallback(
    (next: ImageTarget) => setSearchParams(paramsFromTarget(next), { replace: true }),
    [setSearchParams],
  );
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
      <Alert color="yellow" title="新規生成のRecipeがありません">
        anima_txt2imgのRecipeを登録してから開いてください。
      </Alert>
    );
  }
  return (
    <ImageWorkspace
      recipe={recipe.data}
      target={targetFromParams(searchParams)}
      onTargetChange={changeTarget}
      storageKeys={IMAGE_PAGE_STORAGE_KEYS}
      fromArtifact={searchParams.get("from_artifact")}
      paneScroll
    />
  );
}
