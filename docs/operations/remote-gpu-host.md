# Remote GPUホストの準備

生成Backendを動かすRemote PCの準備手順。構成と判断の根拠は[ADR 0002](../adr/0002-remote-gpu-host.md)に記録する。

手元PC側で必要な設定は`MYCOMFYUI_COMFYUI_BASE_URL`の変更だけとする。Application APIのコードは変更しない。

## 前提

- Remote PCと手元PCが同じLANにいる。
- Remote PCのアドレスが変わらない。DHCP予約か固定IPで固定する。hostnameで引く場合は、手元PCから名前解決できることを確かめる。
- Remote PCにComfyUIが導入済みで、単体で起動できる。

## 1. Firewallが効いていることを確かめる

ComfyUIには認証機構がない。到達できる範囲がそのまま実行できる範囲になるため、待受を広げる前にFirewallの状態を確認する。無効になっているPCで手順2を先に実行すると、意図した「手元PCだけが到達できる」状態ではなく、LAN全体へ無認証で公開される。

Windowsでは、管理者権限のPowerShellで次を実行する。適用中のプロファイル(Domain/Private/Public)で`Enabled`が`True`、`DefaultInboundAction`が`Block`であることを確かめる。ネットワークプロファイルが意図と違う場合は先に直す。

```powershell
Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultInboundAction
Get-NetConnectionProfile
```

Linuxでは使っているFirewallに応じて次を確認する。

```bash
sudo ufw status verbose        # ufw。Status: active と Default: deny (incoming)
sudo firewall-cmd --state      # firewalld
```

どちらも動いていない場合、この手順書の前提が崩れる。Firewallを有効にしてから先へ進む。

## 2. ComfyUIをLAN待受で起動する

ComfyUIは既定で`127.0.0.1`へbindするため、そのままでは手元PCから到達できない。

```bash
python main.py --listen 0.0.0.0 --port 8188
```

Firewallで8188への受信を許可する。到達元は必ず手元PCのアドレスへ限定する。送信元を指定せずにポートを開けると、LAN上の全ホストから到達できる。`<手元PCのIP>`は実際のアドレスへ置き換える。

Windowsの場合、管理者権限のPowerShellで次を実行する。

```powershell
New-NetFirewallRule -DisplayName "ComfyUI LAN" -Direction Inbound -Protocol TCP -LocalPort 8188 -RemoteAddress <手元PCのIP> -Action Allow
```

Linuxでufwを使う場合。`ufw allow 8188/tcp`は送信元を限定しないため使わない。

```bash
sudo ufw allow from <手元PCのIP> to any port 8188 proto tcp
```

firewalldを使う場合。

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="<手元PCのIP>" port port="8188" protocol="tcp" accept'
sudo firewall-cmd --reload
```

設定後、手元PC以外の端末から`curl http://<remote>:8188/system_stats`が失敗することを確かめる。

ルーターでのポート開放(WAN公開)は行わない。

この送信元制限はネットワークアドレスに基づくものであり、認証ではない。同一セグメント内でのIP偽装には耐えられない。判断の前提は[ADR 0002](../adr/0002-remote-gpu-host.md)に記録する。

## 3. 常駐させる

ComfyUIは常駐させる。TTSとWhisperは常駐させない(手順6)。

Linuxではsystemdのuser unitを作る。`<user>`と各pathは実際の環境へ置き換える。

```ini
# ~/.config/systemd/user/comfyui.service
[Unit]
Description=ComfyUI
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/<user>/ComfyUI
ExecStart=/home/<user>/ComfyUI/venv/bin/python main.py --listen 0.0.0.0 --port 8188
Restart=on-failure
RestartSec=10
StandardOutput=append:/home/<user>/ComfyUI/logs/comfyui.log
StandardError=append:/home/<user>/ComfyUI/logs/comfyui.err

[Install]
WantedBy=default.target
```

```bash
mkdir -p ~/ComfyUI/logs && chmod 700 ~/ComfyUI/logs
systemctl --user daemon-reload
systemctl --user enable --now comfyui
loginctl enable-linger $USER   # ログアウト後も動かす
```

Windowsではタスクスケジューラに「ログオン時」トリガのタスクを登録する。

```powershell
$action = New-ScheduledTaskAction -Execute "C:\ComfyUI\venv\Scripts\python.exe" `
  -Argument "main.py --listen 0.0.0.0 --port 8188" -WorkingDirectory "C:\ComfyUI"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "ComfyUI" -Action $action -Trigger $trigger
```

ログオンせずに動かす場合はNSSMでサービス化する。

```powershell
nssm install ComfyUI C:\ComfyUI\venv\Scripts\python.exe "main.py --listen 0.0.0.0 --port 8188"
nssm set ComfyUI AppDirectory C:\ComfyUI
nssm set ComfyUI AppStdout C:\ComfyUI\logs\comfyui.log
nssm set ComfyUI AppStderr C:\ComfyUI\logs\comfyui.err
nssm start ComfyUI
```

いずれの場合も、標準出力と標準エラーをファイルへ残す。Jobが`BACKEND_UNAVAILABLE`や`EXECUTION_FAILED`で失敗したとき、原因はComfyUI側のログにしか出ない。

ログにはプロンプトと生成物のpathが残る。Remote PCを他の利用者と共有する場合、ログの出力先ディレクトリを本人だけが読める権限にする。

常駐させる以上、ComfyUI本体とカスタムノードは更新せずに放置しない。LANへ待受を広げた分だけ、これらの脆弱性がそのまま攻撃面になる([ADR 0002](../adr/0002-remote-gpu-host.md))。

## 4. モデル資産を集約する

checkpoint、LoRA、VAEはRemote PCの`models/`配下へ置く。手元PCには置かない。

Recipeが指すモデル名(`apps/api/src/mycomfyui_api/bootstrap.py`)とRemote PC上の実ファイル名が一致している必要がある。一致しない場合、Jobは`MODEL_NOT_FOUND`で失敗する。

## 5. 疎通を確認する

手元PCから次を確認する。`<remote>`はRemote PCのアドレスへ置き換える。

|確認|コマンド|見るところ|
|---|---|---|
|疎通とGPU認識|`curl http://<remote>:8188/system_stats`|GPU名とVRAM。`engine_version`の取得元でもある|
|モデル在庫|`curl http://<remote>:8188/object_info/UNETLoader`|手順4で置いたモデル名が選択肢に出るか|
|投入|`curl -X POST http://<remote>:8188/prompt -d @workflow.json`|`prompt_id`が返るか|
|履歴|`curl http://<remote>:8188/history/<prompt_id>`|完了後に出力が載るか|
|生成物の取得|`curl "http://<remote>:8188/view?filename=...&type=output"`|画像バイト列が返るか|
|進捗監視|`websocat "ws://<remote>:8188/ws?clientId=test"`|接続が確立し、実行中にメッセージが届くか|

`/object_info`は利用可能なモデル名の列挙に使う(`apps/api/src/mycomfyui_api/adapters/comfyui/client.py:156`)。選択肢を取得できない場合、Jobは在庫を確認できないまま実行せずに失敗する。

WebSocketが通らない場合、Adapterは`/history/{prompt_id}`のポーリングへ切り替わるため生成自体は動くが、完了検知が遅れる。Firewallの設定でWebSocketだけが落ちていないかをここで確かめる。

## 6. TTSとWhisperのvenvを置く

Qwen3-TTS、VoxCPM2、CosyVoice3、WhisperのvenvをRemote PCへ用意する。起動はしない。`voice-runner`(#11)が要求時に起動し、終了後にプロセスを落としてVRAMを返す。

ComfyUIと同時に常駐させない。VRAMの実測値は`ai-media/docs/tts-backends.md`に記録がある。

## 7. 手元PCの接続先を変える

```dotenv
MYCOMFYUI_COMFYUI_BASE_URL=http://<remote>:8188
MYCOMFYUI_COMFYUI_TIMEOUT_SECONDS=900
```

タイムアウトはネットワーク往復と生成物の転送分の余裕を見る。既定は600秒。

設定の詳細は[Application APIのREADME](../../apps/api/README.md)を参照する。

## 失敗したときに見るところ

|症状|失敗コード|確認|
|---|---|---|
|Jobがすぐ失敗する|`BACKEND_UNAVAILABLE`|手順1と手順2のFirewallと待受、Remote PCの電源、アドレスの変化|
|実行中に失敗する|`BACKEND_DISCONNECTED`|ネットワークの切断、ComfyUIプロセスの落ち、手順3のログ|
|モデルが見つからない|`MODEL_NOT_FOUND`|手順4のファイル名とRecipeの指す名前|
|完了検知が遅い|—|手順5のWebSocket。ポーリングへ落ちていないか|
