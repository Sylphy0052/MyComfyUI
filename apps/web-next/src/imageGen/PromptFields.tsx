import { ActionIcon, Badge, Button, Group, Stack, Text, Textarea } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";

import { isExcluded } from "./promptTags";

/**
 * 補完タグ。読み取り専用で、外したいタグだけを×で外せる。外したタグは下に並べ、まとめて戻せる。
 */
function SupplementTagList({
  label,
  tags,
  excluded,
  onChangeExcluded,
}: {
  label: string;
  tags: string[];
  excluded: string[];
  onChangeExcluded: (excluded: string[]) => void;
}) {
  const kept = tags.filter((tag) => !isExcluded(tag, excluded));
  const removed = tags.filter((tag) => isExcluded(tag, excluded));
  return (
    <Stack gap={4} data-testid={`supplement-${label}`}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      {tags.length === 0 ? (
        <Text size="xs" c="dimmed">
          対象を選ぶと、Projectの設定からタグが入ります。
        </Text>
      ) : null}
      <Group gap={4}>
        {kept.map((tag) => (
          <Badge
            key={tag}
            variant="light"
            tt="none"
            pr={2}
            data-tag={tag}
            rightSection={
              <ActionIcon
                size="xs"
                variant="transparent"
                aria-label={`${tag}を外す`}
                onClick={() => onChangeExcluded([...excluded, tag])}
              >
                <IconX size={12} />
              </ActionIcon>
            }
          >
            {tag}
          </Badge>
        ))}
      </Group>
      {removed.length > 0 ? (
        <Group gap={4}>
          <Text size="xs" c="dimmed">
            外したタグ: {removed.join(", ")}
          </Text>
          <Button size="compact-xs" variant="subtle" onClick={() => onChangeExcluded([])}>
            すべて戻す
          </Button>
        </Group>
      ) : null}
    </Stack>
  );
}

export function PromptFields({
  supplementPositive,
  supplementNegative,
  excludedPositive,
  excludedNegative,
  positiveFree,
  negativeFree,
  composedPositive,
  composedNegative,
  assist,
  onChange,
}: {
  supplementPositive: string[];
  supplementNegative: string[];
  excludedPositive: string[];
  excludedNegative: string[];
  positiveFree: string;
  negativeFree: string;
  composedPositive: string;
  composedNegative: string;
  /** 自由欄の下に置く、日本語からの変換と「直す」。 */
  assist?: ReactNode;
  onChange: (
    update: Partial<{
      excludedPositive: string[];
      excludedNegative: string[];
      positiveFree: string;
      negativeFree: string;
    }>,
  ) => void;
}) {
  return (
    <Stack gap="sm">
      <SupplementTagList
        label="補完タグ"
        tags={supplementPositive}
        excluded={excludedPositive}
        onChangeExcluded={(excluded) => onChange({ excludedPositive: excluded })}
      />
      <Textarea
        label="プロンプト (自由欄)"
        description="タグはカンマか改行で区切る。補完タグと重なるタグは1つにして投入する"
        value={positiveFree}
        onChange={(event) => onChange({ positiveFree: event.currentTarget.value })}
        autosize
        minRows={3}
        maxRows={10}
      />
      {assist}
      <SupplementTagList
        label="補完ネガティブ"
        tags={supplementNegative}
        excluded={excludedNegative}
        onChangeExcluded={(excluded) => onChange({ excludedNegative: excluded })}
      />
      <Textarea
        label="ネガティブ (自由欄)"
        value={negativeFree}
        onChange={(event) => onChange({ negativeFree: event.currentTarget.value })}
        autosize
        minRows={2}
        maxRows={6}
      />
      <Stack gap={2}>
        <Text size="xs" c="dimmed">
          投入するプロンプト
        </Text>
        <Text size="xs" data-testid="composed-positive" style={{ wordBreak: "break-word" }}>
          {composedPositive || "(空)"}
        </Text>
        <Text size="xs" c="dimmed">
          投入するネガティブ
        </Text>
        <Text size="xs" data-testid="composed-negative" style={{ wordBreak: "break-word" }}>
          {composedNegative || "(空)"}
        </Text>
      </Stack>
    </Stack>
  );
}
