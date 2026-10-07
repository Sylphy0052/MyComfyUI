# 計算機サーバg18のバックエンド

アプリが使うGPUバックエンドのうち、ComfyUIとQwen (OpenAI互換の推論サーバ) をg18のDockerコンテナで動かすための構成。voice-runnerの構成は`tools/voice-runner/docker/`にある。運用の決まり (置き場所、GPUの空き確認、公開範囲) は`AGENTS.md`の「計算機サーバ」節に従う。

g18上の配置は次のとおり。`/ssdnas2`はNFSで、ほかの計算機サーバからも同じ内容が見える。

- `/ssdnas2/data/kfuruhashi/ComfyUI`: ComfyUI本体 (commit `6a8dcf51`) とカスタムノード
- `/ssdnas2/data/kfuruhashi/comfyui-models`: ComfyUIのモデル
- `/ssdnas2/data/kfuruhashi/llm-models`: QwenのGGUF
- `/ssdnas2/data/kfuruhashi/docker/{comfyui,qwen}`: このディレクトリの`comfyui/`と`qwen/`の配置先

## ComfyUI

`comfyui/`を`/ssdnas2/data/kfuruhashi/docker/comfyui`へ置き、g18上で実行する。

1. イメージを作る: `docker build -t kfuruhashi-comfyui:cu130 .`。python:3.12-slimにCUDA 13.0版のtorchとComfyUIの依存を入れる。tritonがカーネルをビルドするため`gcc`と`libc6-dev`が要る。WD14 Taggerのため`onnxruntime`も入れる
2. カスタムノードを入れる: `bash nodes.sh`
   - `ComfyUI-Anima_IP-Adapter` (`6b77cd0`)
   - `ComfyUI-WD14-Tagger` (`9e0a6e7`)
   - `comfyui-anima-incontext` (HF `darask0/Anima-InContext-Character`に同梱)
3. `comfyui-anima-incontext`にパッチを当てる: `docker run --rm --user "$(id -u):$(id -g)" -v /ssdnas2/data/kfuruhashi/ComfyUI:/ComfyUI -v "$PWD:/w" kfuruhashi-comfyui:cu130 python /w/incontext-patch.py`
   - ComfyUI `8d534945` (2026-09-27) 以降、attentionの差し替え関数には`preferred_attention`などの引数が追加で渡される。q/k/vは`AttentionTensorContainer`に包まれて届く
   - パッチを当てないと、`anima_ref_incontext`が`'AttentionTensorContainer' object has no attribute 'shape'`で失敗する
   - 当て済みかどうかは目印の`# patched: AttentionTensorContainer`で判定する。何度実行してもよい
4. 足りないモデルをHFから取得する: `bash models.sh`。InContext LoRA、ACE-Step、4x-UltraSharp、SD1.5、ControlNet canny、SigLIP2を取得する
5. 起動する: `./run.sh <GPU番号>`。空いているGPUを先に`nvidia-smi`で確かめる
   - `127.0.0.1:18188`にだけ公開する
   - コンテナは`--init`付きで起動する。付けないとpythonがPID 1になり、`docker stop`が`PID is zombie`で失敗する
   - `--user`で自分のUIDとして書き込む。付けないと、NFS上のファイルがroot所有になる
6. 使い終えたら止める: `docker stop kfuruhashi-comfyui`

`extra_model_paths.yaml`は、`comfyui-models`の各ディレクトリをComfyUIへ対応付ける。

### テンプレートの動作確認

`templates-run.py`は、`apps/api/src/mycomfyui_api/adapters/comfyui/templates/`のテンプレートを1本ずつ`/prompt`へ投入し、結果を表示する。画像と音声の入力だけを差し替え、ほかの値はテンプレートの既定値のまま流す。repoのcheckoutを`$REPO`として、g18上で次のように実行する。

```bash
docker run --rm --network host --user "$(id -u):$(id -g)" \
  -v "$REPO/tools/gpu-server/comfyui:/w" -w /w \
  -v "$REPO/apps/api/src/mycomfyui_api/adapters/comfyui/templates:/templates:ro" -e TEMPLATES_DIR=/templates \
  -v /ssdnas2/data/kfuruhashi/ComfyUI/input:/input \
  kfuruhashi-comfyui:cu130 python -u templates-run.py [テンプレート名 ...]
```

2026-10-07にGPU 3 (A100 80GB) で11本を実行し、すべて成功した。所要時間は次のとおり。

- wd14_tagger: 19s
- image_upscale: 3s
- sd15_controlnet: 15s
- anima_txt2img: 54s
- anima_img2img: 6s
- anima_inpaint: 6s
- anima_ref_siglip: 15s
- anima_ref_incontext: 43s
- ace_step_bgm: 24s
- minimax_h3_i2v: 141s
- minimax_h3_ref2v: 172s

## Qwen

`qwen/run.sh`を`/ssdnas2/data/kfuruhashi/docker/qwen`へ置き、`./run.sh <GPU番号>`で起動する。

- 推論サーバは`ghcr.io/ggml-org/llama.cpp:server-cuda`
- モデルは`unsloth/Qwen3.8-27B-GGUF`の`UD-IQ3_S` (約12GB)。`/ssdnas2/data/kfuruhashi/llm-models/Qwen3.8-27B-UD-IQ3_S.gguf`に置く
- モデル名 (alias) は`qwen3.8-27b-ud-iq3s`。コンテキスト長は16384
- OpenAI互換APIを`127.0.0.1:18000`にだけ公開する。応答には`reasoning_content`が付く
- 使い終えたら`docker stop kfuruhashi-qwen`で止める

## 手元のApplication APIから繋ぐ

WSLの`ssh`はg18に届かない。そのため`ssh.exe`でポートを転送する。手元の`8000`番はApplication API自身が使うので、Qwenは`18000`番のまま転送する。voice-runnerはg18の`127.0.0.1:18770`で待ち受けるので、手元の既定値`8770`番へ転送する。

```bash
ssh.exe -N -L 18188:127.0.0.1:18188 -L 18000:127.0.0.1:18000 -L 8770:127.0.0.1:18770 g18
```

Application APIの環境変数は次のとおり。

- `MYCOMFYUI_COMFYUI_BASE_URL=http://127.0.0.1:18188`
- `MYCOMFYUI_AGENT_QWEN_BASE_URL=http://127.0.0.1:18000/v1`
- `MYCOMFYUI_AGENT_QWEN_MODEL=qwen3.8-27b-ud-iq3s`
- `MYCOMFYUI_VOICE_RUNNER_BASE_URL=http://127.0.0.1:8770`
