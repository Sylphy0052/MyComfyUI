import { Button, Checkbox, Group, Paper, Select, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconWand } from "@tabler/icons-react";
import { useEffect, useState } from "react";

import { notifyError } from "../notifications";
import { MediaThumb } from "./MediaThumb";
import { mergeTags, normalizeTag, useExtractImageTags } from "./tagExtract";

/**
 * 画像からタグを抽出し、チェックしたものだけを`tags`へ足す。手動で実行し、保存は呼び出し側の保存ボタンが確定する。
 * `imageKeys`が複数あるときは、抽出する画像を選べる。
 */
export function TagExtractor({
  imageKeys,
  tags,
  onChange,
  emptyHint,
  targetLabel,
}: {
  /** 抽出できる画像のmedia key。 */
  imageKeys: string[];
  /** 追加先のタグ (現在の入力値)。 */
  tags: string[];
  onChange: (tags: string[]) => void;
  /** `imageKeys`が空のときの案内。 */
  emptyHint: string;
  /** 追加先の名前。ボタンの文言に使う。 */
  targetLabel: string;
}) {
  const extract = useExtractImageTags();
  const [picked, setPicked] = useState<string | null>(null);
  // 既定は全て選択。外したものだけを正規化したタグで持つ。
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());

  const imageKey = picked !== null && imageKeys.includes(picked) ? picked : (imageKeys[0] ?? null);

  // 対象の画像が変わったら、前の画像の抽出結果は捨てる。
  const { reset } = extract;
  useEffect(() => {
    reset();
    setUnchecked(new Set());
  }, [imageKey, reset]);

  const run = () => {
    if (imageKey === null) return;
    setUnchecked(new Set());
    extract.mutate(imageKey, { onError: (error) => notifyError("タグを抽出できません", error) });
  };

  const existing = new Set(tags.map(normalizeTag));
  const extracted = extract.data ?? null;
  const selectable = (extracted ?? []).filter((tag) => !existing.has(normalizeTag(tag)));
  const selected = selectable.filter((tag) => !unchecked.has(normalizeTag(tag)));

  const toggle = (tag: string, checked: boolean) =>
    setUnchecked((previous) => {
      const next = new Set(previous);
      if (checked) next.delete(normalizeTag(tag));
      else next.add(normalizeTag(tag));
      return next;
    });

  const add = () => {
    const merged = mergeTags(tags, selected);
    onChange(merged.tags);
    if (merged.truncated > 0) {
      notifications.show({ color: "yellow", message: `タグの上限を超えるため、${merged.truncated}件は追加していません` });
    }
    // 追加した結果は閉じる。もう一度見たいときは再度抽出する。
    reset();
    setUnchecked(new Set());
  };

  return (
    <Stack gap="xs" data-testid="tag-extractor">
      <Group align="flex-end" gap="sm">
        {imageKeys.length > 1 ? (
          <Select
            label="抽出する画像"
            size="xs"
            allowDeselect={false}
            data={imageKeys.map((key, index) => ({ value: key, label: `${index + 1}枚目${index === 0 ? " (代表)" : ""}` }))}
            value={imageKey}
            onChange={setPicked}
          />
        ) : null}
        {imageKey !== null ? <MediaThumb mediaKey={imageKey} size={40} /> : null}
        <Button
          size="xs"
          variant="light"
          leftSection={<IconWand size={14} />}
          loading={extract.isPending}
          disabled={imageKey === null}
          onClick={run}
        >
          画像からタグを抽出
        </Button>
        {imageKey === null ? (
          <Text size="xs" c="dimmed">
            {emptyHint}
          </Text>
        ) : null}
      </Group>
      {extracted !== null ? (
        <Paper withBorder p="xs" data-testid="tag-extract-result">
          {extracted.length === 0 ? (
            <Text size="sm" c="dimmed">
              抽出されたタグはありません。
            </Text>
          ) : (
            <Stack gap="xs">
              <Group gap="md">
                {extracted.map((tag) => {
                  const already = existing.has(normalizeTag(tag));
                  return (
                    <Checkbox
                      key={tag}
                      size="xs"
                      label={already ? `${tag} (追加済み)` : tag}
                      checked={!already && !unchecked.has(normalizeTag(tag))}
                      disabled={already}
                      onChange={(event) => toggle(tag, event.currentTarget.checked)}
                    />
                  );
                })}
              </Group>
              <Group justify="space-between">
                <Text size="xs" c="dimmed">
                  追加しただけでは保存されません。保存ボタンで確定します。
                </Text>
                <Button size="xs" disabled={selected.length === 0} onClick={add}>
                  {`${targetLabel}へ追加 (${selected.length})`}
                </Button>
              </Group>
            </Stack>
          )}
        </Paper>
      ) : null}
    </Stack>
  );
}
