#!/usr/bin/env bash
# Issue #63の受入基準を手元で確かめる。CIには載せず、実装時と回帰確認のときに手で叩く。
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
WORK="$(mktemp -d)"
echo "work dir: ${WORK}"

start_api() {
  # $1: data_root, $2: ログの出力先, 以降: 追加引数
  local data_root="$1" log="$2"
  shift 2
  MYCOMFYUI_DATA_ROOT="${data_root}" uv run --project "${ROOT}/apps/api" \
    python -m mycomfyui_api --port 0 "$@" >"${log}" 2>&1 &
  echo $!
}

wait_for_url() {
  local log="$1" i
  for i in $(seq 1 120); do
    if grep -q "MYCOMFYUI_API_LISTENING" "${log}"; then
      grep -m1 "MYCOMFYUI_API_LISTENING" "${log}" | awk '{print $2}'
      return 0
    fi
    sleep 0.5
  done
  echo "起動行が出ませんでした" >&2
  cat "${log}" >&2
  return 1
}

wait_for_health() {
  local url="$1" i
  for i in $(seq 1 120); do
    if curl -fsS "${url}/api/v1/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

echo "== 1. 既定bindと空のdata_rootからの起動 =="
DATA_A="${WORK}/data-a"
mkdir -p "${DATA_A}"
LOG_A="${WORK}/a.log"
PID_A="$(start_api "${DATA_A}" "${LOG_A}")"
trap 'kill "${PID_A}" 2>/dev/null || true' EXIT
URL_A="$(wait_for_url "${LOG_A}")"
echo "listening: ${URL_A}"
case "${URL_A}" in
  http://127.0.0.1:*) echo "OK 既定bindはloopback" ;;
  *) echo "NG 既定bindがloopbackでない: ${URL_A}"; exit 1 ;;
esac
wait_for_health "${URL_A}" || { echo "NG healthが応答しない"; cat "${LOG_A}"; exit 1; }
echo "health: $(curl -fsS "${URL_A}/api/v1/health")"
echo "recipes: $(curl -fsS "${URL_A}/api/v1/recipes" 2>/dev/null | head -c 120 || echo "(取得せず)")"
test -f "${DATA_A}/db/mycomfyui.sqlite3" && echo "OK DBが作られた" || { echo "NG DBが無い"; exit 1; }
echo "alembic_version: $(sqlite3 "${DATA_A}/db/mycomfyui.sqlite3" 'select version_num from alembic_version' 2>/dev/null || echo '(sqlite3コマンド無し)')"

echo "== 2. 許可originを設定していないときのCORS =="
CORS_NONE="$(curl -sS -o /dev/null -D - -X OPTIONS \
  -H "Origin: http://tauri.localhost" \
  -H "Access-Control-Request-Method: GET" \
  "${URL_A}/api/v1/health" | grep -ci "access-control-allow-origin" || true)"
if [ "${CORS_NONE}" = "0" ]; then
  echo "OK 許可originが空なら許可headerを返さない"
else
  echo "NG 許可originが空なのに許可headerを返した"; exit 1
fi
kill "${PID_A}" 2>/dev/null || true
wait "${PID_A}" 2>/dev/null || true
trap - EXIT

echo "== 3. 許可originを設定したときのCORS =="
LOG_B="${WORK}/b.log"
PID_B="$(start_api "${DATA_A}" "${LOG_B}" --allow-origin http://tauri.localhost)"
trap 'kill "${PID_B}" 2>/dev/null || true' EXIT
URL_B="$(wait_for_url "${LOG_B}")"
wait_for_health "${URL_B}" || { echo "NG healthが応答しない"; cat "${LOG_B}"; exit 1; }
ALLOWED="$(curl -sS -o /dev/null -D - -X OPTIONS \
  -H "Origin: http://tauri.localhost" \
  -H "Access-Control-Request-Method: GET" \
  "${URL_B}/api/v1/health" | grep -i "access-control-allow-origin" || true)"
DENIED="$(curl -sS -o /dev/null -D - -X OPTIONS \
  -H "Origin: http://evil.example" \
  -H "Access-Control-Request-Method: GET" \
  "${URL_B}/api/v1/health" | grep -ci "access-control-allow-origin" || true)"
echo "allowed: ${ALLOWED:-(なし)}"
echo "denied header count: ${DENIED}"
test -n "${ALLOWED}" || { echo "NG 許可originに許可headerが出ない"; exit 1; }
test "${DENIED}" = "0" || { echo "NG 許可外originに許可headerが出た"; exit 1; }
echo "OK 許可originだけに許可headerを返す"
kill "${PID_B}" 2>/dev/null || true
wait "${PID_B}" 2>/dev/null || true
trap - EXIT

echo "== 4. 再起動でmigrationが二重適用されない =="
LOG_C="${WORK}/c.log"
PID_C="$(start_api "${DATA_A}" "${LOG_C}")"
trap 'kill "${PID_C}" 2>/dev/null || true' EXIT
URL_C="$(wait_for_url "${LOG_C}")"
wait_for_health "${URL_C}" || { echo "NG 2回目の起動でhealthが応答しない"; cat "${LOG_C}"; exit 1; }
echo "OK 既存のdata_rootでも起動する"
kill "${PID_C}" 2>/dev/null || true
wait "${PID_C}" 2>/dev/null || true
trap - EXIT

echo "すべて通りました。work dir: ${WORK}"
