#!/bin/bash
# g18上のこのディレクトリで実行 (bash nodes.sh): ComfyUIのカスタムノードをコンテナ内で導入する
set -Eeuo pipefail
# ファイルとして実行したときだけ隣のrevisions.shを読む。stdin経由 (bash -s) では隣が無いので、revisions.shを先頭に連結して流す
[ -f "${BASH_SOURCE[0]:-}" ] && . "$(dirname "${BASH_SOURCE[0]}")/revisions.sh"
: "${INCONTEXT_REV:?revisionが未設定。stdinで流すときは cat revisions.sh nodes.sh | ssh.exe g18 'bash -s' のように連結する}"
D=/ssdnas2/data/kfuruhashi
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e HF_HOME=/tmp/hf -e INCONTEXT_REV \
  -v "$D/ComfyUI:/ComfyUI" kfuruhashi-comfyui:cu130 bash -Eeuo pipefail -c '
cd /ComfyUI/custom_nodes
[ -d ComfyUI-Anima_IP-Adapter ] || git clone -q https://github.com/LuciferTC9527/ComfyUI-Anima_IP-Adapter
git -C ComfyUI-Anima_IP-Adapter checkout -q 6b77cd0c367d76402174ace2be50d3cb6aa77855
[ -d ComfyUI-WD14-Tagger ] || git clone -q https://github.com/pythongosssss/ComfyUI-WD14-Tagger
git -C ComfyUI-WD14-Tagger checkout -q 9e0a6e700299182fc05c58b62e7ad9f72182a78b
if [ ! -d comfyui-anima-incontext ]; then
  python -c "import huggingface_hub as h; h.snapshot_download(\"darask0/Anima-InContext-Character\", revision=\"$INCONTEXT_REV\", allow_patterns=[\"comfyui-anima-incontext/*\"], local_dir=\"/tmp/ic\")"
  cp -r /tmp/ic/comfyui-anima-incontext .
fi
ls
'
