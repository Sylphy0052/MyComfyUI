# Remote GPUホストの準備

生成Backendを動かすRemote PCの準備手順。構成と判断の根拠は[ADR 0002](../adr/0002-remote-gpu-host.md)に記録する。

手元PC側で必要な設定は`MYCOMFYUI_COMFYUI_BASE_URL`の変更だけとする。Application APIのコードは変更しない。

## 前提

- Remote PCと手元PCが同じLANにいる。
- Remote PCのアドレスが変わらない。DHCP予約か固定IPで固定する。hostnameで引く場合は、手元PCから名前解決できることを確かめる。
- Remote PCにComfyUIが導入済みで、単体で起動できる。

## Remote PCの種別を先に決める

手順1と手順2の内容は、Remote PCが次のどれかで変わる。先に確かめてから進む。

|種別|判定|Firewallの層|
|---|---|---|
|Linux単体|`uname -r`に`microsoft`を含まない|ufwまたはfirewalld|
|Windows単体|—|Windows Firewall|
|WSL2|`uname -r`に`microsoft`を含む|Hyper-V FirewallとWSL内Firewallの2層|

WSL2の場合、さらにネットワークモードを確かめる。

```bash
uname -r                      # microsoft-standard-WSL2 を含むか
ip -4 addr show eth0 | grep inet   # LANと同じセグメントのIPを持つか
```

`eth0`がLANと同じセグメントのIP(例: `192.168.1.2/24`)を持つならmirroredモードである。この場合、WSLはWindowsホストのLAN IPを直接持つため、`netsh interface portproxy`は要らない。`172.x.x.x`のような別セグメントならNATモードであり、本手順書の範囲外とする。

mirroredモードには、以降の手順に効く落とし穴が3つある。手順1の修正、手順2のFirewall、手順2の`loopback0`である。いずれも見落とすとLAN全体への無認証公開か、`127.0.0.1`の不通を招く。

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

### WSL2の場合に追加で確認すること

WSL2 mirroredモードでは、WSL宛の受信を**Hyper-V Firewall**が司る。上の`Get-NetFirewallProfile`はこの層を映さないため、2コマンドだけでは「WSL宛の受信が既定Allow」を見逃す。その状態で手順2を実行すると、LAN全体へ無認証で公開される。

管理者権限のPowerShellで次を実行する。

```powershell
Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore | Select-Object Name, Enabled, DefaultInboundAction
```

`DefaultInboundAction`が`Allow`なら、手順2でBlockへ変えるまで待受を広げない。

`Get-NetFirewallProfile`が`DefaultInboundAction: NotConfigured`を返すこともある。これは既定値(Block)で動いていることを意味するが、Hyper-V Firewallの既定とは別物である。両方を確かめる。

2026-09-20に構築したRemote PCでは、`Get-NetFirewallProfile`が3プロファイルとも`Enabled=True`かつ`NotConfigured`である一方、Hyper-V Firewallは`DefaultInboundAction=Allow`だった。手順書の2コマンドだけでは検出できない状態である。

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

### WSL2の場合

2層とも設定する。片方だけでは足りない。

`New-NetFirewallRule`はmirroredモードのWSL宛トラフィックを制御しない。`New-NetFirewallHyperVRule`とVMCreatorIdを使う。VMCreatorIdはWSLに割り当てられた識別子であり、次で確認してから使う。

```powershell
Get-NetFirewallHyperVVMCreator
```

返ってきたWSLのVMCreatorIdを、以下の`<VMCreatorId>`へ入れる。

```powershell
Set-NetFirewallHyperVVMSetting -Name '<VMCreatorId>' -DefaultInboundAction Block
New-NetFirewallHyperVRule -Name "ComfyUI-8188" -DisplayName "ComfyUI LAN (from <手元PCのIP>)" -Direction Inbound -VMCreatorId '<VMCreatorId>' -Protocol TCP -LocalPorts 8188 -RemoteAddresses <手元PCのIP> -Action Allow
```

作成後、`EnforcementStatus`が`OK`で`RemoteAddresses`が意図したアドレスであることを確かめる。

WSL内のufwは、上のLinux向けレシピに次の1行を足す。

```bash
sudo ufw allow in on loopback0
```

この行を落とすと`127.0.0.1`が不通になる。mirroredモードには`lo`とは別に`loopback0`があり、`127.0.0.1`宛はそちらを通る。ufwの既定の受信許可は`-i lo`しか対象にしないため、`ufw default deny incoming`だけを入れるとloopbackが落ちる。

この失敗は気付きにくい。プロセスもポートも正常に見え、LAN IP経由(`http://<remote>:8188`)では200が返る一方、`http://127.0.0.1:8188`だけがタイムアウトする。ComfyUIに限らず、Remote PC上で`127.0.0.1`へ繋ぐ既存のスクリプトもすべて止まる。

設定後、手元PC以外の端末から`curl http://<remote>:8188/system_stats`が失敗することを確かめる。Remote PC上で`curl http://127.0.0.1:8188/system_stats`が200を返すことも併せて確かめる。

ルーターでのポート開放(WAN公開)は行わない。

### ComfyUI以外のポート

Remote PCへ置くサービスは8188だけではない。`voice-runner`(既定8770)と、`novel-writer`側の`ai-media`参照API(既定8765)も同じマシンで動く。いずれも認証機構を持たない。

この2つは手元PCのApplication APIから接続する([ADR 0002](../adr/0002-remote-gpu-host.md)の配置表)。つまり8188と同じく待受を広げる必要があり、同じく到達元を限定する必要がある。「手元PCから接続しないから`127.0.0.1`のままでよい」が当てはまるのは、Remote PC内だけで完結する別のサービスである。

8188のレシピをポート番号だけ変えて同じように適用する。

```powershell
# WSL2の場合。8188と同じVMCreatorIdを使う
New-NetFirewallHyperVRule -Name "voice-runner-8770" -DisplayName "voice-runner LAN (from <手元PCのIP>)" -Direction Inbound -VMCreatorId '<VMCreatorId>' -Protocol TCP -LocalPorts 8770 -RemoteAddresses <手元PCのIP> -Action Allow
New-NetFirewallHyperVRule -Name "ai-media-8765" -DisplayName "ai-media reference API (from <手元PCのIP>)" -Direction Inbound -VMCreatorId '<VMCreatorId>' -Protocol TCP -LocalPorts 8765 -RemoteAddresses <手元PCのIP> -Action Allow
```

```bash
# ufw。`ufw allow 8770/tcp` のように送信元を書かないルールは作らない
sudo ufw allow from <手元PCのIP> to any port 8770 proto tcp
sudo ufw allow from <手元PCのIP> to any port 8765 proto tcp
```

firewalldの場合は8188と同じ`--add-rich-rule`をポート番号だけ変えて足す。

設定後、次の2つを確かめる。前者だけでは送信元制限が効いているかは分からない。

- Remote PCで`ss -tlnp | grep -E '8188|8765|8770'`を実行し、広げたポートだけが`0.0.0.0`で待っていること。`127.0.0.1`や`::1`で待っているものは外から到達しない
- **手元PC以外の端末**から`curl http://<remote>:8770/`と`curl http://<remote>:8765/`が失敗すること。Firewallの到達元制限はこれでしか検証できない

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
ExecStart=/home/<user>/ComfyUI/.venv/bin/python main.py --listen 0.0.0.0 --port 8188
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

ComfyUIはINFOを標準エラーへ出す。障害調査で見るのは`comfyui.err`であり、`comfyui.log`はほぼ空になる。

ログにはプロンプトと生成物のpathが残る。Remote PCを他の利用者と共有する場合、ログの出力先ディレクトリを本人だけが読める権限にする。

常駐させる以上、ComfyUI本体とカスタムノードは更新せずに放置しない。LANへ待受を広げた分だけ、これらの脆弱性がそのまま攻撃面になる([ADR 0002](../adr/0002-remote-gpu-host.md))。

## 4. モデル資産を集約する

checkpoint、LoRA、VAEはRemote PCから読める場所へ置く。手元PCには置かない。

満たすべきことは、ComfyUIがRemote PCのファイルシステムからモデルを読めることであり、1つのディレクトリへ物理的に集めることではない。既に別の場所にモデルがある場合、`extra_model_paths.yaml`で参照を足してよい。Windows側のportable ComfyUIと共有しているモデル群がある構成では、`models/`配下へコピーすると数百GB規模の重複と既存ワークフローの破壊になる。

参照を足す場合、そのディレクトリに置かれたモデルファイルの入手元を確認する。checkpointの読み込みはpickleを経由するものがあり、由来の分からないファイルを読ませない([ADR 0002](../adr/0002-remote-gpu-host.md))。

どちらの方法でも、`/object_info`が目的のモデル名を列挙できていれば足りる。

```bash
curl http://127.0.0.1:8188/object_info/UNETLoader
```

Recipeが指すモデル名(`apps/api/src/mycomfyui_api/bootstrap.py`の`DEFAULT_VALUES`)とRemote PC上の実ファイル名が一致している必要がある。一致しない場合、Jobは`MODEL_NOT_FOUND`で失敗する。突き合わせるのは`unet_name`(UNETLoader)、`clip_name`(CLIPLoader)、`vae_name`(VAELoader)の3件である。

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

用意したvenvのpathは`tools/voice-runner/engines.yaml`の`python`と一致している必要がある。一致しない場合、`voice-runner`はBackendを起動できない。venvを置いてから、このファイルの`engines.python`と`asr.python`を実機のpathへ合わせる。

ASRはtransformersの`pipeline`で動かす(`tools/voice-runner/workers/asr_worker.py`)。`openai/whisper-large-v3-turbo`をそのまま読む構成であり、faster-whisperは前提にしない。faster-whisperを使う場合はCTranslate2形式への変換が別途要る。

CosyVoice3には3点の注意がある。

- `openai-whisper==20231117`は`pkg_resources`が無い環境でビルドに失敗する。`uv pip install --no-build-isolation`で入れる。
- `deepspeed`は学習用であり、`voice-runner`が行う推論には要らない。CUDAツールキット(nvcc)が無い環境ではimport時に`CUDA_HOME does not exist`でtransformersごと落ちるため、除去する。
- 実行時に`PYTHONPATH=third_party/Matcha-TTS`が要る(upstreamの仕様)。

venvを作ったら、起動せずにimportだけを確かめる。

```bash
~/qwen-tts/.venv/bin/python -c "import qwen_tts"
~/voxcpm/.venv/bin/python -c "import voxcpm"
~/whisper/.venv/bin/python -c "import transformers, torch; print(torch.cuda.is_available())"
PYTHONPATH=third_party/Matcha-TTS ~/cosyvoice/.venv/bin/python -c "from cosyvoice.cli.cosyvoice import CosyVoice2"
```

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
