#!/usr/bin/env bash
# 開発時のsidecarを用意する。PyInstallerで固めずに`apps/api`をそのまま呼ぶ。
#
# Tauriはexternal binaryの実体が無いと起動しないが、開発のたびに固め直すと待ち時間が伸びる。
# ここでは同期済み仮想環境のPythonへ委譲する実行ファイルを置き、引数と標準出力だけ本番と同じにする。
# Windows向けの配布ではPyInstallerの出力が要る。手順はdocs/operations/desktop-shell.mdに置く。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${REPO_ROOT}/apps/desktop/src-tauri/binaries"
TRIPLE="$(rustc -vV | awk '/^host: /{print $2}')"
PYTHON="${REPO_ROOT}/apps/api/.venv/bin/python"

if [ -z "${TRIPLE}" ]; then
  echo "NG: rustcからhostのtarget tripleを取得できない" >&2
  exit 1
fi

if [ ! -x "${PYTHON}" ]; then
  echo "NG: Application APIの仮想環境が無い: ${PYTHON}" >&2
  echo "   uv sync --locked --project apps/api を先に実行する" >&2
  exit 1
fi

mkdir -p "${BIN_DIR}"
SHIM="${BIN_DIR}/mycomfyui-api-${TRIPLE}"

cat > "${SHIM}" <<EOF
#!/usr/bin/env bash
# 開発用のshim。tools/make-sidecar-shim.shが生成する。編集しても次の生成で消える。
exec "${PYTHON}" -m mycomfyui_api "\$@"
EOF

chmod +x "${SHIM}"
echo "OK: ${SHIM}"
