import { Button, Group, Loader, Modal, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { apiRequest, type QwenSettings, type QwenSettingsBody } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { notifyError } from "../notifications";

/** `base_url` / `status_url`の上限。APIの`QwenSettingsUpdate`に合わせる。 */
const URL_MAX = 2048;
/** `model`の上限。APIの`QwenSettingsUpdate`に合わせる。 */
const MODEL_MAX = 200;

/** 保存中かをダイアログの外側から見るためのキー。 */
const SAVE_MUTATION_KEY = ["settings", "qwen", "save"] as const;

type FieldName = "base_url" | "model" | "status_url";
type Draft = Record<FieldName, string>;
type Errors = Partial<Record<FieldName, string>>;

/** 空欄は保存値を消す (null)。APIの`OptionalHttpUrl`と同じく、前後の空白を落としてhttp(s)のURLだけを受ける。 */
function parseUrl(raw: string): { value: string | null; error?: string } {
  const value = raw.trim();
  if (value === "") return { value: null };
  if (value.length > URL_MAX) return { value: null, error: `${URL_MAX}文字以内で入力してください。` };
  if (/\s/.test(value)) return { value: null, error: "URLに空白を含められません。" };
  // `new URL`は`http:/host`を`http://host/`へ直して通すが、APIは通さない。`://`を必須にして揃える。
  if (!/^https?:\/\//i.test(value)) return { value: null, error: "http://またはhttps://で始まるURLを指定してください。" };
  try {
    const url = new URL(value);
    const valid = (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" && url.port !== "0";
    if (valid) return { value };
  } catch {
    // URLとして読めなければ下の共通メッセージにする。
  }
  return { value: null, error: "http://またはhttps://で始まるURLを指定してください。" };
}

function parseDraft(draft: Draft): { body: Pick<QwenSettingsBody, FieldName>; errors: Errors } {
  const baseUrl = parseUrl(draft.base_url);
  const statusUrl = parseUrl(draft.status_url);
  const model = draft.model.trim();
  const errors: Errors = {};
  if (baseUrl.error) errors.base_url = baseUrl.error;
  if (statusUrl.error) errors.status_url = statusUrl.error;
  if (model.length > MODEL_MAX) errors.model = `${MODEL_MAX}文字以内で入力してください。`;
  return {
    body: { base_url: baseUrl.value, model: model === "" ? null : model, status_url: statusUrl.value },
    errors,
  };
}

function initialDraft(settings: QwenSettings): Draft {
  const { saved } = settings;
  return { base_url: saved.base_url ?? "", model: saved.model ?? "", status_url: saved.status_url ?? "" };
}

function useSaveQwenSettings(onSaved: () => void) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: SAVE_MUTATION_KEY,
    mutationFn: (body: QwenSettingsBody) =>
      apiRequest<QwenSettings>("/settings/qwen", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      notifications.show({ color: "green", message: "Qwen設定を保存しました" });
      onSaved();
      return client.invalidateQueries({ queryKey: queryKeys.qwenSettings });
    },
    onError: (error) => notifyError("Qwen設定を保存できませんでした", error),
  });
}

const FIELDS: { name: FieldName; label: string }[] = [
  { name: "base_url", label: "接続先URL (base_url)" },
  { name: "model", label: "モデル (model)" },
  { name: "status_url", label: "状態照会URL (status_url)" },
];

/** `settings`は開いた時点の値。フォームの初期値にだけ使い、後から取り直されても入力中の値は変えない。 */
function QwenSettingsForm({ settings, onClose }: { settings: QwenSettings; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(settings));
  const [errors, setErrors] = useState<Errors>({});
  const save = useSaveQwenSettings(onClose);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    const parsed = parseDraft(draft);
    setErrors(parsed.errors);
    if (Object.keys(parsed.errors).length > 0) return;
    // supports_imagesはこのダイアログで変えない。開いた時点の保存値をそのまま送る (effectiveを送ると保存値ができてしまう)。
    // 開いている間に別の画面で変えた値は戻るが、設定を変えるのは利用者1人なので許容する。
    save.mutate({ ...parsed.body, supports_images: settings.saved.supports_images ?? null });
  };

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="sm">
        {FIELDS.map(({ name, label }) => {
          const fallback = settings.defaults[name] ?? "";
          return (
            <TextInput
              key={name}
              label={label}
              value={draft[name]}
              placeholder={fallback}
              description={
                <>
                  空欄なら環境変数の値 ({fallback === "" ? "未設定" : fallback}) を使う
                  <br />
                  現在の実効値: {settings.effective[name] ?? "未設定"}
                </>
              }
              error={errors[name]}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({ ...current, [name]: value }));
                setErrors((current) => ({ ...current, [name]: undefined }));
              }}
            />
          );
        })}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={save.isPending}>
            キャンセル
          </Button>
          <Button type="submit" loading={save.isPending}>
            保存
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/** 開いている間だけ置かれる。閉じると状態ごと消えるので、保存前に閉じた編集は捨てられ、開き直すたびに最新の値を取る。 */
function QwenSettingsLoader({ onClose }: { onClose: () => void }) {
  const query = useQuery({
    queryKey: queryKeys.qwenSettings,
    queryFn: () => apiRequest<QwenSettings>("/settings/qwen"),
    // 残っているcacheで初期化せず、開くたびに取り直した値で初期化する。
    gcTime: 0,
    refetchOnMount: "always",
  });
  if (query.isError) {
    return (
      <Stack gap="sm">
        <Text size="sm" c="red">
          Qwen設定を読めません: {query.error.message}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => void query.refetch()}>
            再読み込み
          </Button>
        </Group>
      </Stack>
    );
  }
  if (!query.data || !query.isFetchedAfterMount) {
    return (
      <Group justify="center" py="md">
        <Loader size="sm" />
      </Group>
    );
  }
  return <QwenSettingsForm settings={query.data} onClose={onClose} />;
}

export function QwenSettingsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  // 保存中は閉じさせない。閉じても要求は止まらず、失敗したときに入力が消えるため。
  const saving = useIsMutating({ mutationKey: SAVE_MUTATION_KEY }) > 0;
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Qwen設定"
      size="md"
      closeOnEscape={!saving}
      closeOnClickOutside={!saving}
      withCloseButton={!saving}
    >
      <QwenSettingsLoader onClose={onClose} />
    </Modal>
  );
}
