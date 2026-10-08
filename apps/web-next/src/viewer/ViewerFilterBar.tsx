import { Button, Checkbox, Group, Input, SegmentedControl, SimpleGrid, Stack, TextInput } from "@mantine/core";

import type { ArtifactDecision } from "../api/client";
import { LinkSelects } from "./LinkSelects";
import { NO_LINKS, type ViewerFilters } from "./viewerFilters";

const DECISION_OPTIONS = [
  { value: "all", label: "すべて" },
  { value: "accepted", label: "採用" },
  { value: "rejected", label: "不採用" },
  { value: "undecided", label: "未判定" },
];

export const EMPTY_FILTERS: ViewerFilters = { ...NO_LINKS, decision: null, unassigned: false, from: null, to: null };

/**
 * 画像タブ上部の絞り込み。値はURLにだけ持ち、変えるたびにURLを書き換える。
 * 続けて操作したときに前の変更を消さないよう、`onChange`には変えた項目だけを渡す。
 */
export function ViewerFilterBar({
  filters,
  onChange,
}: {
  filters: ViewerFilters;
  onChange: (patch: Partial<ViewerFilters>) => void;
}) {
  return (
    <Stack gap="xs" data-testid="viewer-filters">
      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="xs" verticalSpacing="xs">
        <LinkSelects
          size="xs"
          value={filters}
          disabled={filters.unassigned}
          onChange={(links) => onChange(links)}
        />
      </SimpleGrid>
      <Group gap="md" align="flex-end" wrap="wrap">
        <Input.Wrapper label="採否" size="xs">
          <SegmentedControl
            size="xs"
            data={DECISION_OPTIONS}
            value={filters.decision ?? "all"}
            onChange={(value) =>
              onChange({ decision: value === "all" ? null : (value as ArtifactDecision) })
            }
          />
        </Input.Wrapper>
        <Checkbox
          size="xs"
          label="紐づけ無し (Project無し)"
          checked={filters.unassigned}
          // Project無しとProjectの絞り込みは同時に使えないので、紐づけの絞り込みを外す。
          onChange={(event) => onChange({ ...NO_LINKS, unassigned: event.currentTarget.checked })}
          mb={6}
        />
        <TextInput
          size="xs"
          type="date"
          label="作成日 (から)"
          value={filters.from ?? ""}
          onChange={(event) => onChange({ from: event.currentTarget.value || null })}
        />
        <TextInput
          size="xs"
          type="date"
          label="作成日 (まで)"
          value={filters.to ?? ""}
          onChange={(event) => onChange({ to: event.currentTarget.value || null })}
        />
        <Button size="xs" variant="default" onClick={() => onChange(EMPTY_FILTERS)}>
          条件をクリア
        </Button>
      </Group>
    </Stack>
  );
}
