import { SegmentedControl, SimpleGrid, Stack, Switch, Text, TextInput, Textarea } from "@mantine/core";

import type { ImageForm, SweepMode } from "./imageForm";
import type { SweepPlan } from "./sweep";

type Update = (update: Partial<ImageForm>) => void;

/**
 * 「詳細」の末尾に置くスイープ。オンにすると軸の入力欄と組み合わせ方を出し、
 * 投入前に件数を見せる。投入できない入力はここに理由を出す。
 */
export function SweepFields({ form, onChange, plan }: { form: ImageForm; onChange: Update; plan: SweepPlan }) {
  return (
    <Stack gap="xs" data-testid="sweep-fields">
      <Switch
        label="スイープ (値を変えて一度に並べる)"
        checked={form.sweepEnabled}
        onChange={(event) => onChange({ sweepEnabled: event.currentTarget.checked })}
      />
      {form.sweepEnabled ? (
        <>
          <Text size="xs" c="dimmed">
            軸の値はカンマ区切りで入れます。空の軸は変えません。seedがランダムのときは、全てのセルで同じseedを使います。
          </Text>
          <SimpleGrid cols={3} spacing="xs">
            <TextInput
              label="スイープ seed"
              size="xs"
              placeholder="1, 2, 3"
              value={form.sweepSeed}
              onChange={(event) => onChange({ sweepSeed: event.currentTarget.value })}
            />
            <TextInput
              label="スイープ cfg"
              size="xs"
              placeholder="3, 4, 5"
              value={form.sweepCfg}
              onChange={(event) => onChange({ sweepCfg: event.currentTarget.value })}
            />
            <TextInput
              label="スイープ steps"
              size="xs"
              placeholder="20, 30"
              value={form.sweepSteps}
              onChange={(event) => onChange({ sweepSteps: event.currentTarget.value })}
            />
          </SimpleGrid>
          <Textarea
            label="プロンプト断片"
            description="タグがカンマを含むため、断片は「|」か改行で区切ります。各断片を末尾に足します。"
            size="xs"
            autosize
            minRows={1}
            maxRows={4}
            placeholder="smile | angry, closed mouth"
            value={form.sweepFragment}
            onChange={(event) => onChange({ sweepFragment: event.currentTarget.value })}
          />
          <SegmentedControl
            size="xs"
            aria-label="組み合わせ方"
            data={[
              { value: "cartesian", label: "全組合せ" },
              { value: "zip", label: "対 (位置を揃える)" },
            ]}
            value={form.sweepMode}
            onChange={(sweepMode) => onChange({ sweepMode: sweepMode as SweepMode })}
          />
          {plan.ok ? (
            <Text size="sm" fw={500} data-testid="sweep-count">
              {plan.summary}
            </Text>
          ) : (
            <Text size="sm" c="red" data-testid="sweep-blocked">
              {plan.reason}
            </Text>
          )}
        </>
      ) : null}
    </Stack>
  );
}
