# Remote GPUホストの準備

生成Backendを動かすRemote PCの準備手順。構成と判断の根拠は[ADR 0002](../adr/0002-remote-gpu-host.md)に記録する。

手元PC側で必要な設定は`MYCOMFYUI_COMFYUI_BASE_URL`の変更だけとする。Application APIのコードは変更しない。

## 前提

- Remote PCと手元PCが同じLANにいる。
- Remote PCのアドレスが変わらない。DHCP予約か固定IPで固定する。hostnameで引く場合は、手元PCから名前解決できることを確かめる。
- Remote PCにComfyUIが導入済みで、単体で起動できる。

## 1. ComfyUIをLAN待受で起動する

ComfyUIは既定で`127.0.0.1`へbindするため、そのままでは手元PCから到達できない。

```bash
python main.py --listen 0.0.0.0 --port 8188
```

Firewallで8188への受信を許可する。到達元は手元PCのアドレスへ限定する。

Windowsの場合、管理者権限のPowerShellで次を実行する。`<手元PCのIP>`は実際のアドレスへ置き換える。

```powershell
New-NetFirewallRule -DisplayName "ComfyUI LAN" -Direction Inbound -Protocol TCP -LocalPort 8188 -RemoteAddress <手元PCのIP> -Action Allow
```

ルーターでのポート開放(WAN公開)は行わない。ComfyUIには認証機構がないため、到達できる範囲がそのまま実行できる範囲になる。

## 2. 常駐させる

ComfyUIは常駐させる。TTSとWhisperは常駐させない(手順5)。

Windowsではタスクスケジューラで「ログオン時」に起動するタスクを登録するか、NSSMでサービス化する。Linuxではsystemdのuser unitを作り、`systemctl --user enable --now`で有効にする。

いずれの場合も、標準出力と標準エラーをファイルへ残す。Jobが`BACKEND_UNAVAILABLE`や`EXECUTION_FAILED`で失敗したとき、原因はComfyUI側のログにしか出ない。

## 3. モデル資産を集約する

checkpoint、LoRA、VAEはRemote PCの`models/`配下へ置く。手元PCには置かない。

Recipeが指すモデル名(`apps/api/src/mycomfyui_api/bootstrap.py`)とRemote PC上の実ファイル名が一致している必要がある。一致しない場合、Jobは`MODEL_NOT_FOUND`で失敗する。

## 4. 疎通を確認する

手元PCから次を確認する。`<remote>`はRemote PCのアドレスへ置き換える。

|確認|コマンド|見るところ|
|---|---|---|
|疎通とGPU認識|`curl http://<remote>:8188/system_stats`|GPU名とVRAM。`engine_version`の取得元でもある|
|モデル在庫|`curl http://<remote>:8188/object_info/UNETLoader`|手順3で置いたモデル名が選択肢に出るか|
|投入|`curl -X POST http://<remote>:8188/prompt -d @workflow.json`|`prompt_id`が返るか|
|履歴|`curl http://<remote>:8188/history/<prompt_id>`|完了後に出力が載るか|
|生成物の取得|`curl "http://<remote>:8188/view?filename=...&type=output"`|画像バイト列が返るか|
|進捗監視|`websocat "ws://<remote>:8188/ws?clientId=test"`|接続が確立し、実行中にメッセージが届くか|

`/object_info`は利用可能なモデル名の列挙に使う(`apps/api/src/mycomfyui_api/adapters/comfyui/client.py:154`)。選択肢を取得できない場合、Jobは在庫を確認できないまま実行せずに失敗する。

WebSocketが通らない場合、Adapterは`/history/{prompt_id}`のポーリングへ切り替わるため生成自体は動くが、完了検知が遅れる。Firewallの設定でWebSocketだけが落ちていないかをここで確かめる。

## 5. TTSとWhisperのvenvを置く

Qwen3-TTS、VoxCPM2、CosyVoice3、WhisperのvenvをRemote PCへ用意する。起動はしない。`voice-runner`(#11)が要求時に起動し、終了後にプロセスを落としてVRAMを返す。

ComfyUIと同時に常駐させない。VRAMの実測値は`ai-media/docs/tts-backends.md`に記録がある。

## 6. 手元PCの接続先を変える

```dotenv
MYCOMFYUI_COMFYUI_BASE_URL=http://<remote>:8188
MYCOMFYUI_COMFYUI_TIMEOUT_SECONDS=900
```

タイムアウトはネットワーク往復と生成物の転送分の余裕を見る。既定は600秒。

設定の詳細は[Application APIのREADME](../../apps/api/README.md)を参照する。

## 失敗したときに見るところ

|症状|失敗コード|確認|
|---|---|---|
|Jobがすぐ失敗する|`BACKEND_UNAVAILABLE`|手順1のFirewallと待受、Remote PCの電源、アドレスの変化|
|実行中に失敗する|`BACKEND_DISCONNECTED`|ネットワークの切断、ComfyUIプロセスの落ち、手順2のログ|
|モデルが見つからない|`MODEL_NOT_FOUND`|手順3のファイル名とRecipeの指す名前|
|完了検知が遅い|—|手順4のWebSocket。ポーリングへ落ちていないか|
