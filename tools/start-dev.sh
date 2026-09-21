set -euo pipefail
set -m

trap "jobs -p | sed 's/^/-/' | xargs -r kill --" EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

npm run api:dev &
curl -fsS --retry 60 --retry-all-errors --retry-connrefused --retry-delay 1 --max-time 1 http://127.0.0.1:8000/api/v1/health
npm run dev
