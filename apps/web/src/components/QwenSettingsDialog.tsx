import { useEffect, useRef, useState } from "react";

import {
  ApiError,
  api,
  notifyAgentProvidersChanged,
  type QwenSettings,
  type QwenSettingsUpdate,
} from "../api/client";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 開いている間はdialog要素を、閉じたらnullを渡す。トーストの表示先に使う。 */
  onDialogOpenChange: (dialog: HTMLDialogElement | null) => void;
}

/** Qwen (OpenAI互換の推論サーバー) の接続設定を変えるダイアログ (#337)。 */
export function QwenSettingsDialog({
  open,
  onClose,
  onDialogOpenChange,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    onDialogOpenChange(open ? dialog : null);
  }, [open, onDialogOpenChange]);

  return (
    <dialog
      ref={dialogRef}
      className="panel settings-dialog"
      aria-label="設定"
      onClose={() => {
        onDialogOpenChange(null);
        onClose();
      }}
      // 開いている間は、背後の画面のショートカット (採否など) へキーを渡さない。
      onKeyDown={(event) => event.stopPropagation()}
    >
      {/* 開くたびに取り直すため、閉じている間はmountしない。 */}
      {open && <QwenSettingsForm />}
      <button type="button" onClick={onClose}>
        閉じる
      </button>
    </dialog>
  );
}

interface FormValues {
  base_url: string;
  model: string;
  status_url: string;
  /** 空文字は保存しない (環境変数の値を使う)。 */
  supports_images: "" | "true" | "false";
}

function toFormValues(settings: QwenSettings): FormValues {
  const saved = settings.saved;
  return {
    base_url: saved.base_url ?? "",
    model: saved.model ?? "",
    status_url: saved.status_url ?? "",
    supports_images:
      saved.supports_images === true
        ? "true"
        : saved.supports_images === false
          ? "false"
          : "",
  };
}

function toPayload(values: FormValues): QwenSettingsUpdate {
  // 空欄はnullで送り、保存値を消して環境変数の値へ戻す。
  return {
    base_url: values.base_url.trim() || null,
    model: values.model.trim() || null,
    status_url: values.status_url.trim() || null,
    supports_images:
      values.supports_images === "" ? null : values.supports_images === "true",
  };
}

function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return String(error);
  const reasons = Array.isArray(error.details)
    ? error.details
        .map((item) =>
          item && typeof item === "object" && "msg" in item
            ? String(item.msg).replace(/^Value error, /, "")
            : null,
        )
        .filter((reason): reason is string => reason !== null)
    : [];
  const suffix = reasons.length > 0 ? `: ${reasons.join(" / ")}` : "";
  return `${error.message}${suffix} (${error.code})`;
}

function QwenSettingsForm() {
  const [settings, setSettings] = useState<QwenSettings | null>(null);
  const [values, setValues] = useState<FormValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getQwenSettings()
      .then((loaded) => {
        if (!active) return;
        setSettings(loaded);
        setValues(toFormValues(loaded));
      })
      .catch((cause) => {
        if (active) setError(describeError(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  if (!settings || !values) {
    return (
      <section className="stack">
        <h2>Qwenの接続設定</h2>
        {error ? <p role="alert">{error}</p> : <p>読み込み中…</p>}
      </section>
    );
  }

  const defaults = settings.defaults;
  const change = (patch: Partial<FormValues>) => {
    setValues({ ...values, ...patch });
    setNotice(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api.updateQwenSettings(toPayload(values));
      setSettings(saved);
      setValues(toFormValues(saved));
      setNotice("保存しました。次の補完要求から新しい設定を使います。");
      notifyAgentProvidersChanged();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2>Qwenの接続設定</h2>
      <p className="muted">
        空欄の項目は環境変数の値 (欄内の薄い文字) を使います。
      </p>
      <label>
        <span>Base URL</span>
        <input
          type="url"
          value={values.base_url}
          placeholder={defaults.base_url}
          onChange={(event) => change({ base_url: event.target.value })}
        />
      </label>
      <label>
        <span>モデル名</span>
        <input
          value={values.model}
          placeholder={defaults.model}
          onChange={(event) => change({ model: event.target.value })}
        />
      </label>
      <label>
        <span>状態照会URL</span>
        <input
          type="url"
          value={values.status_url}
          placeholder={defaults.status_url ?? "未設定"}
          onChange={(event) => change({ status_url: event.target.value })}
        />
      </label>
      <label>
        <span>画像入力</span>
        <select
          value={values.supports_images}
          onChange={(event) =>
            change({
              supports_images: event.target
                .value as FormValues["supports_images"],
            })
          }
        >
          <option value="">
            既定 ({defaults.supports_images ? "対応" : "非対応"})
          </option>
          <option value="true">対応</option>
          <option value="false">非対応</option>
        </select>
      </label>
      <p className="muted">
        現在の接続先: {settings.effective.base_url} / {settings.effective.model}
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          保存
        </button>
      </div>
    </form>
  );
}
