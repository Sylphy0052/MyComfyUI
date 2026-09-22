set -Eeuo pipefail
set -m

API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-5173}"

# 指定ポートを掴んでいるプロセスを終了させ、LISTEN が消えるまで待つ。
free_port() {
  local port="$1" pids attempt
  # ポートが空いていれば grep が非0で終わるため、pipefail で落ちないよう握り潰す。
  pids="$(ss -ltnHp "sport = :${port}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u | tr '\n' ' ' || true)"
  pids="${pids% }"
  [ -n "$pids" ] || return 0

  echo "[start-dev] port ${port} is held by PID ${pids} -> terminating" >&2
  kill -TERM $pids 2>/dev/null || true
  for attempt in $(seq 1 20); do
    ss -ltnH "sport = :${port}" 2>/dev/null | grep -q . || return 0
    sleep 0.5
  done

  echo "[start-dev] port ${port} still held -> SIGKILL" >&2
  kill -KILL $pids 2>/dev/null || true
  for attempt in $(seq 1 10); do
    ss -ltnH "sport = :${port}" 2>/dev/null | grep -q . || return 0
    sleep 0.5
  done

  echo "[start-dev] failed to free port ${port}" >&2
  return 1
}

# set -m により各ジョブは独立したプロセスグループを持つため、PGID を指定してまとめて落とす。
cleanup() {
  local pgids attempt
  pgids="$(jobs -p | sed 's/^/-/' | tr '\n' ' ')"
  [ -n "${pgids// /}" ] || return 0

  kill -TERM -- $pgids 2>/dev/null || true

  # uvicorn は実行中のバックグラウンドタスクを待つため 1 回目の SIGTERM では終わらない。
  # 2 回目の SIGTERM で強制終了させ、それでも残れば SIGKILL する。
  for attempt in $(seq 1 6); do
    kill -0 -- $pgids 2>/dev/null || return 0
    sleep 0.5
  done
  kill -TERM -- $pgids 2>/dev/null || true
  for attempt in $(seq 1 6); do
    kill -0 -- $pgids 2>/dev/null || return 0
    sleep 0.5
  done
  kill -KILL -- $pgids 2>/dev/null || true
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

free_port "$API_PORT"
free_port "$WEB_PORT"

npm run api:dev &

# Ctrl-C を即座に反映させるため、前面実行ではなく & + wait で待つ
# (bash は前面の子プロセスを待つ間 trap の実行を遅延させるため)。
curl -fsS --retry 60 --retry-all-errors --retry-connrefused --retry-delay 1 --max-time 1 \
  "http://127.0.0.1:${API_PORT}/api/v1/health" &
wait $!

npm run dev &
wait $!
