#!/usr/bin/env bash
# シェルがsidecarへ渡す引数と、読み取る標準出力の書式を確かめる。
# Tauriのビルドが要らない範囲だけを見るため、GUIを立てずに実行できる。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIPLE="$(rustc -vV | awk '/^host: /{print $2}')"
SIDECAR="${REPO_ROOT}/apps/desktop/src-tauri/binaries/mycomfyui-api-${TRIPLE}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

if [ ! -x "${SIDECAR}" ]; then
  echo "NG: sidecarが無い: ${SIDECAR}" >&2
  echo "   bash tools/make-sidecar-shim.sh で用意する" >&2
  exit 1
fi

DATA_ROOT="${WORK}/data"
LOG="${WORK}/sidecar.log"

# シェルが渡す引数と同じ並びにする(apps/desktop/src-tauri/src/sidecar.rs)。
"${SIDECAR}" \
  --port 0 \
  --data-root "${DATA_ROOT}" \
  --allow-origin http://tauri.localhost \
  --allow-origin https://tauri.localhost \
  --allow-origin tauri://localhost \
  >"${LOG}" 2>&1 &
PID=$!
trap 'kill "${PID}" 2>/dev/null; rm -rf "${WORK}"' EXIT

URL=""
for _ in $(seq 1 120); do
  URL="$(grep -m1 '^MYCOMFYUI_API_LISTENING ' "${LOG}" 2>/dev/null | awk '{print $2}')"
  [ -n "${URL}" ] && break
  kill -0 "${PID}" 2>/dev/null || break
  sleep 0.5
done

if [ -z "${URL}" ]; then
  echo "NG: MYCOMFYUI_API_LISTENINGの行が出ない" >&2
  cat "${LOG}" >&2
  exit 1
fi
echo "listening: ${URL}"

case "${URL}" in
  http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
  *) echo "NG: 待ち受け先がloopbackのhttpでない: ${URL}" >&2; exit 1 ;;
esac

HEALTHY=""
for _ in $(seq 1 120); do
  if curl -fsS "${URL}/api/v1/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 0.25
done
test -n "${HEALTHY}" || { echo "NG: healthが200を返さない" >&2; cat "${LOG}" >&2; exit 1; }
echo "OK: healthが200を返した"

# シェルはWebViewのoriginを許可originとして渡す。
ALLOWED="$(curl -sS -o /dev/null -D - -X OPTIONS \
  -H "Origin: http://tauri.localhost" \
  -H "Access-Control-Request-Method: GET" \
  "${URL}/api/v1/health" | grep -ci '^access-control-allow-origin:')"
DENIED="$(curl -sS -o /dev/null -D - -X OPTIONS \
  -H "Origin: http://evil.example" \
  -H "Access-Control-Request-Method: GET" \
  "${URL}/api/v1/health" | grep -ci '^access-control-allow-origin:')"
test "${ALLOWED}" != "0" || { echo "NG: WebViewのoriginに許可headerが出ない" >&2; exit 1; }
test "${DENIED}" = "0" || { echo "NG: 許可外のoriginに許可headerが出た" >&2; exit 1; }
echo "OK: 許可originだけにCORSのheaderが出た"

test -f "${DATA_ROOT}/db/mycomfyui.sqlite3" \
  && echo "OK: data_rootへDBを作った" \
  || { echo "NG: data_rootにDBが無い" >&2; exit 1; }

# シェルは自分が起動した子だけを止める。停止後にportが空くことを確かめる。
kill "${PID}" 2>/dev/null
for _ in $(seq 1 40); do
  kill -0 "${PID}" 2>/dev/null || break
  sleep 0.25
done
if curl -fsS --max-time 2 "${URL}/api/v1/health" >/dev/null 2>&1; then
  echo "NG: 停止したのにhealthが応答する" >&2
  exit 1
fi
echo "OK: 停止後は応答しない"

echo "すべて確認できた"
