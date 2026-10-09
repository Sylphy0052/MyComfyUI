import { artifactContentUrl, imageReferenceUrl, type Recipe } from "../api/client";
import { acceptsInput, buildInputs, type ImageForm, type ImageTarget } from "./imageForm";
import type { SupplementTags } from "./promptTags";

/** 生成方法のタブ。 */
export type GenerateMode = "txt2img" | "ref" | "edit";

export const REF_SIGLIP_TEMPLATE = "anima_ref_siglip";
export const REF_INCONTEXT_TEMPLATE = "anima_ref_incontext";
export const IMG2IMG_TEMPLATE = "anima_img2img";
export const INPAINT_TEMPLATE = "anima_inpaint";
export const UPSCALE_TEMPLATE = "image_upscale";

/** 参照と修正が使うWorkflowテンプレート。Recipeはこの名前で引く。 */
export const DERIVE_TEMPLATES = [
  REF_SIGLIP_TEMPLATE,
  REF_INCONTEXT_TEMPLATE,
  IMG2IMG_TEMPLATE,
  INPAINT_TEMPLATE,
  UPSCALE_TEMPLATE,
] as const;

/**
 * 参照強度の入力上限。`workflow.py`の`_coerce`が持つreference_strengthの上限 (2.0) と揃える。
 * どちらかを変えたらもう一方も直す。
 */
export const REFERENCE_STRENGTH_MAX = 2;

/** denoiseのRecipe既定値が読めないときの値。`bootstrap.py`の`IMAGE_IMG2IMG_DEFAULTS`に合わせる。 */
const FALLBACK_DENOISE = 0.65;

export type ChangePlan = { templateName: string; referenceStrength: number };

/** 参照強度の既定値。ポーズ・表情だけ、衣装だけ、両方を変えるときの順。 */
const POSE_EXPRESSION_STRENGTH = 0.5;
const OUTFIT_STRENGTH = 1.0;
const OUTFIT_AND_POSE_STRENGTH = 1.5;

/**
 * 「変えたい要素」のチェックからテンプレートと参照強度を決める。
 * 旧UI (#612で削除) の`planForOperations`を移植したもの。
 * 旧UIの「ポーズ」「表情」は、この画面では「ポーズ・表情を変える」の1つにまとめている。
 * - ポーズ・表情だけ → anima_ref_siglip, 0.5
 * - 衣装だけ → anima_ref_incontext, 1.0
 * - 両方 → anima_ref_incontext, 1.5 (旧UIで衣装とポーズ・表情を併せたときの扱い)
 * どちらも外していれば`null`を返し、投入できないものとする。
 */
export function planForChanges(changePoseExpression: boolean, changeOutfit: boolean): ChangePlan | null {
  if (!changePoseExpression && !changeOutfit) return null;
  if (!changeOutfit) return { templateName: REF_SIGLIP_TEMPLATE, referenceStrength: POSE_EXPRESSION_STRENGTH };
  if (!changePoseExpression) return { templateName: REF_INCONTEXT_TEMPLATE, referenceStrength: OUTFIT_STRENGTH };
  return { templateName: REF_INCONTEXT_TEMPLATE, referenceStrength: OUTFIT_AND_POSE_STRENGTH };
}

/** 修正の方式。 */
export type EditMethod = "img2img" | "inpaint" | "upscale";

export const EDIT_METHOD_TEMPLATES: Record<EditMethod, string> = {
  img2img: IMG2IMG_TEMPLATE,
  inpaint: INPAINT_TEMPLATE,
  upscale: UPSCALE_TEMPLATE,
};

/** Jobの`inputs`へ渡す入力ファイルの指定。生成物のIDか、入力cacheの参照。画像のほか、動画の`guide_audio`の音声も同じ形で渡す。 */
export type ImageRef = { artifact_id: string } | { relative_path: string; sha256: string };

/** アップロードして入力cacheに取り込んだ画像。 */
export type UploadedImage = { ref: { relative_path: string; sha256: string }; previewUrl: string; label: string };

export type SourceOrigin = "artifact" | "costume" | "upload";

/** 元画像。`links`は、選んだときに対象へ引き継ぐ紐づけ。 */
export type SourceImage = {
  origin: SourceOrigin;
  ref: ImageRef;
  previewUrl: string;
  label: string;
  links: ImageTarget;
};

export type DeriveState = {
  source: SourceImage | null;
  /** inpaintのマスク画像。描いたマスクも、取り込んだ画像としてここに入る。 */
  mask: UploadedImage | null;
  changePoseExpression: boolean;
  changeOutfit: boolean;
  /** 「詳細」で手で直した参照強度。`null`なら、チェックから決めた強度を使う。 */
  strengthOverride: number | null;
  editMethod: EditMethod;
  /** 全体を変える (img2img) のdenoise。`null`ならRecipeの既定値。 */
  denoise: number | null;
};

export const INITIAL_DERIVE: DeriveState = {
  source: null,
  mask: null,
  changePoseExpression: false,
  changeOutfit: false,
  strengthOverride: null,
  editMethod: "img2img",
  denoise: null,
};

/** 生成物を元画像にする。紐づけは生成物のものを引き継ぐ。 */
export function sourceFromArtifact(artifact: {
  id: string;
  assigned_project_id?: string | null;
  story_scene_id?: string | null;
  story_character_id?: string | null;
  story_costume_id?: string | null;
}): SourceImage {
  return {
    origin: "artifact",
    ref: { artifact_id: artifact.id },
    previewUrl: artifactContentUrl(artifact.id),
    label: "生成物",
    links: {
      projectId: artifact.assigned_project_id ?? null,
      sceneId: artifact.story_scene_id ?? null,
      characterId: artifact.story_character_id ?? null,
      costumeId: artifact.story_costume_id ?? null,
      extraCast: [],
    },
  };
}

/** 衣装の参照画像を元画像にする。紐づけは、その衣装 (とキャラ、Project) になる。 */
export function sourceFromCostume(
  ref: ImageRef,
  previewUrl: string,
  costume: { id: string; character_id: string },
  projectId: string | null,
): SourceImage {
  return {
    origin: "costume",
    ref,
    previewUrl,
    label: "衣装の参照画像",
    links: { projectId, sceneId: null, characterId: costume.character_id, costumeId: costume.id, extraCast: [] },
  };
}

/** アップロードした画像を元画像にする。紐づけは持たず、今の対象のまま使う。 */
export function sourceFromUpload(uploaded: UploadedImage): SourceImage {
  return {
    origin: "upload",
    ref: uploaded.ref,
    previewUrl: uploaded.previewUrl,
    label: uploaded.label,
    links: { projectId: null, sceneId: null, characterId: null, costumeId: null, extraCast: [] },
  };
}

/** 入力cacheに取り込んだ画像のサムネイル用URL。 */
export function uploadedImage(
  reference: { relative_path: string; sha256: string },
  label: string,
): UploadedImage {
  // APIが返すbyte_sizeなどはJobの参照では未知の項目として弾かれるため、2項目だけを残す。
  const ref = { relative_path: reference.relative_path, sha256: reference.sha256 };
  return { ref, previewUrl: imageReferenceUrl(reference.relative_path), label };
}

/** 今のタブと入力から使うテンプレート。まだ決まらなければ`null`。 */
export function templateOfDerive(mode: Exclude<GenerateMode, "txt2img">, state: DeriveState): string | null {
  if (mode === "edit") return EDIT_METHOD_TEMPLATES[state.editMethod];
  return planForChanges(state.changePoseExpression, state.changeOutfit)?.templateName ?? null;
}

/** 参照強度。手で直していればその値、なければチェックから決めた値。 */
export function referenceStrengthOf(state: DeriveState): number | null {
  const plan = planForChanges(state.changePoseExpression, state.changeOutfit);
  if (plan === null) return null;
  return state.strengthOverride ?? plan.referenceStrength;
}

/** RecipeのdenoiseのUI既定値。 */
export function defaultDenoiseOf(recipe: Recipe | null): number {
  const value = recipe?.defaults.denoise;
  return typeof value === "number" && Number.isFinite(value) ? value : FALLBACK_DENOISE;
}

/** 投入できない理由。投入できるなら`null`。 */
export function deriveBlockedReason(
  mode: Exclude<GenerateMode, "txt2img">,
  state: DeriveState,
  recipe: Recipe | null,
): string | null {
  if (state.source === null) return "元画像を選んでください";
  if (mode === "ref" && templateOfDerive(mode, state) === null) return "変えたい要素を選んでください";
  if (mode === "edit" && state.editMethod === "inpaint" && state.mask === null) return "マスクを描くか、マスク画像をアップロードしてください";
  if (recipe === null) return "この方式のRecipeがありません";
  return null;
}

/** プロンプトを使う方式か。拡大は元画像だけで動く。 */
export function usesPrompt(mode: GenerateMode, state: DeriveState): boolean {
  return !(mode === "edit" && state.editMethod === "upscale");
}

/** 参照・修正の`POST /generation-jobs`の`inputs`。元画像・マスク・denoise・参照強度を足す。 */
export function buildDeriveInputs(
  mode: Exclude<GenerateMode, "txt2img">,
  state: DeriveState,
  form: ImageForm,
  supplement: SupplementTags,
  recipe: Recipe,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = usesPrompt(mode, state) ? buildInputs(form, supplement, recipe) : {};
  if (state.source !== null) inputs.source_image = state.source.ref;
  if (mode === "ref") {
    const strength = referenceStrengthOf(state);
    if (strength !== null) inputs.reference_strength = strength;
  }
  if (mode === "edit" && state.editMethod === "img2img") {
    inputs.denoise = state.denoise ?? defaultDenoiseOf(recipe);
  }
  if (mode === "edit" && state.editMethod === "inpaint" && state.mask !== null) {
    inputs.mask_image = state.mask.ref;
  }
  return Object.fromEntries(Object.entries(inputs).filter(([name]) => acceptsInput(recipe, name)));
}
