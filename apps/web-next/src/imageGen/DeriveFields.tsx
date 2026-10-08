import { Button, Checkbox, FileButton, Group, Image, NumberInput, SegmentedControl, Slider, Stack, Text } from "@mantine/core";
import { IconUpload } from "@tabler/icons-react";

import type { Recipe } from "../api/client";
import { notifyError } from "../notifications";
import {
  defaultDenoiseOf,
  planForChanges,
  REFERENCE_STRENGTH_MAX,
  referenceStrengthOf,
  uploadedImage,
  type DeriveState,
  type EditMethod,
  type UploadedImage,
} from "./deriveForm";
import { useUploadInputImage } from "./useImageGen";

type Update = (update: Partial<DeriveState>) => void;

const TEMPLATE_LABELS: Record<string, string> = {
  anima_ref_siglip: "ポーズ・表情の参照 (anima_ref_siglip)",
  anima_ref_incontext: "衣装の参照 (anima_ref_incontext)",
};

/** 参照タブ。「変えたい要素」のチェックから、テンプレートと強度を自動で決める。 */
export function RefFields({ state, onChange }: { state: DeriveState; onChange: Update }) {
  const plan = planForChanges(state.changePoseExpression, state.changeOutfit);
  // チェックを変えたら自動の強度に戻す。前のチェックで手で直した強度を引きずらない。
  const change = (update: Partial<DeriveState>) => onChange({ ...update, strengthOverride: null });
  return (
    <Stack gap="xs" data-testid="ref-fields">
      <Text size="sm" fw={500}>
        変えたい要素
      </Text>
      <Checkbox
        label="ポーズ・表情を変える"
        checked={state.changePoseExpression}
        onChange={(event) => change({ changePoseExpression: event.currentTarget.checked })}
      />
      <Checkbox
        label="衣装を変える"
        checked={state.changeOutfit}
        onChange={(event) => change({ changeOutfit: event.currentTarget.checked })}
      />
      <Text size="xs" c="dimmed" data-testid="ref-plan">
        {plan === null
          ? "どちらかを選ぶと、使う方式と強度が決まります。"
          : `${TEMPLATE_LABELS[plan.templateName] ?? plan.templateName} / 強度 ${referenceStrengthOf(state)}`}
      </Text>
    </Stack>
  );
}

/** 「詳細」に入れる参照強度。手で直すと、チェックから決めた値より優先する。 */
export function RefStrengthField({ state, onChange }: { state: DeriveState; onChange: Update }) {
  const plan = planForChanges(state.changePoseExpression, state.changeOutfit);
  return (
    <NumberInput
      label="参照強度"
      description={plan === null ? "変えたい要素を選ぶと自動で決まります" : `自動の値は${plan.referenceStrength}`}
      size="xs"
      min={0}
      max={REFERENCE_STRENGTH_MAX}
      step={0.1}
      decimalScale={2}
      disabled={plan === null}
      value={referenceStrengthOf(state) ?? ""}
      onChange={(value) => typeof value === "number" && onChange({ strengthOverride: value })}
    />
  );
}

const EDIT_METHODS: { value: EditMethod; label: string }[] = [
  { value: "img2img", label: "全体を変える" },
  { value: "inpaint", label: "一部を描き直す" },
  { value: "upscale", label: "拡大" },
];

/** 修正タブ。方式ごとに、denoise、マスク画像のアップロード、拡大の案内を出す。 */
export function EditFields({
  state,
  onChange,
  reserveMask,
  img2imgRecipe,
}: {
  state: DeriveState;
  onChange: Update;
  /** マスク画像を取り込む前に呼び、返り値へ取り込んだマスクを渡す。 */
  reserveMask: () => (mask: UploadedImage) => void;
  img2imgRecipe: Recipe | null;
}) {
  const upload = useUploadInputImage();
  const denoise = state.denoise ?? defaultDenoiseOf(img2imgRecipe);
  return (
    <Stack gap="xs" data-testid="edit-fields">
      <SegmentedControl
        size="xs"
        data={EDIT_METHODS}
        value={state.editMethod}
        onChange={(editMethod) => onChange({ editMethod: editMethod as EditMethod })}
      />
      {state.editMethod === "img2img" ? (
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            denoise: <span data-testid="denoise-value">{denoise}</span>
          </Text>
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={denoise}
            onChange={(value) => onChange({ denoise: value })}
            thumbLabel="denoise"
            label={null}
          />
          <Text size="xs" c="dimmed">
            0で元画像を維持し、1に近いほど大きく変えます。
          </Text>
        </Stack>
      ) : null}
      {state.editMethod === "inpaint" ? (
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            マスク画像
          </Text>
          <Text size="xs" c="dimmed">
            描き直す範囲を赤で塗った画像をアップロードします (赤いところが修正範囲)。ブラシでの作成は後から足します。
          </Text>
          <Group gap="sm" wrap="nowrap">
            <FileButton
              accept="image/png,image/jpeg,image/webp"
              onChange={(file) => {
                if (file === null) return;
                // mutateの個別コールバックは入力欄を閉じると呼ばれないため、mutateAsyncで受ける。
                const apply = reserveMask();
                upload.mutateAsync(file).then(
                  (reference) => apply(uploadedImage(reference, file.name)),
                  (error: unknown) => notifyError(`${file.name}を取り込めません`, error),
                );
              }}
            >
              {(props) => (
                <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />} loading={upload.isPending}>
                  マスク画像をアップロード
                </Button>
              )}
            </FileButton>
            {state.mask !== null ? (
              <>
                <Image src={state.mask.previewUrl} alt="アップロードしたマスク画像" h={64} w="auto" fit="contain" data-testid="mask-preview" />
                <Button size="compact-xs" variant="default" onClick={() => onChange({ mask: null })}>
                  外す
                </Button>
              </>
            ) : null}
          </Group>
        </Stack>
      ) : null}
      {state.editMethod === "upscale" ? (
        <Text size="xs" c="dimmed">
          元画像をそのまま拡大します。プロンプトは使いません。
        </Text>
      ) : null}
    </Stack>
  );
}
