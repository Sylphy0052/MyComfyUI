#!/bin/bash
# g18上で実行 (ssh.exe g18 'bash -s' < this): ComfyUIのカスタムノードをコンテナ内で導入する
set -Eeuo pipefail
D=/ssdnas2/data/kfuruhashi
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e HF_HOME=/tmp/hf \
  -v "$D/ComfyUI:/ComfyUI" kfuruhashi-comfyui:cu130 bash -Eeuo pipefail -c '
cd /ComfyUI/custom_nodes
[ -d ComfyUI-Anima_IP-Adapter ] || git clone -q https://github.com/LuciferTC9527/ComfyUI-Anima_IP-Adapter
git -C ComfyUI-Anima_IP-Adapter checkout -q 6b77cd0
[ -d ComfyUI-WD14-Tagger ] || git clone -q https://github.com/pythongosssss/ComfyUI-WD14-Tagger
git -C ComfyUI-WD14-Tagger checkout -q 9e0a6e7
if [ ! -d comfyui-anima-incontext ]; then
  python -c "import huggingface_hub as h; h.snapshot_download(\"darask0/Anima-InContext-Character\", allow_patterns=[\"comfyui-anima-incontext/*\"], local_dir=\"/tmp/ic\")"
  cp -r /tmp/ic/comfyui-anima-incontext .
fi
ls
'
