# Remote GPUホストの準備

生成Backendを動かすRemote PCの準備手順。構成と判断の根拠は[ADR 0002](../adr/0002-remote-gpu-host.md)に記録する。

手元PC側で必要な設定は接続先URLの変更だけとする。Application APIのコードは変更しない。変えるのはComfyUIを指す`MYCOMFYUI_COMFYUI_BASE_URL`と、`voice-runner`を指す`MYCOMFYUI_VOICE_RUNNER_BASE_URL`である。値は手順7にまとめる。

Remote PCで常駐させるのもComfyUIだけではない。`voice-runner`(既定8770)も常駐させる(手順3)。ComfyUIだけを起動した状態では、画像・動画・音楽は生成できる一方、音声Jobだけが`BACKEND_UNAVAILABLE`で失敗する。

## 前提

- Remote PCと手元PCが同じLANにいる。
- Remote PCのアドレスが変わらない。DHCP予約か固定IPで固定する。hostnameで引く場合は、手元PCから名前解決できることを確かめる。
  - 固定IPにする場合、そのアドレスがルーターのDHCP配布範囲の外にあることを確かめる。範囲内だと他の端末が同じアドレスを受け取って競合し、Jobが不定期に`BACKEND_UNAVAILABLE`で落ちる。
  - 設定直後の疎通テストは`AddressState`が`Preferred`になってから行う。`Tentative`(重複アドレス検出中)の間は失敗する。
  - Remote PCがWSL2 mirroredモードなら、ホスト側のIP変更に再起動なしで追従する。`wsl --shutdown`は通常要らない。追従しないときだけ行う。
- Remote PCにComfyUIが導入済みで、単体で起動できる。

## 0. Remote PCの種別を先に決める

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

mirroredモードには、以降の手順に効く落とし穴が3つある。手順1の「WSL2の場合に追加で確認すること」、手順2の「WSL2の場合」のHyper-V Firewall、同じく手順2の`loopback0`である。いずれも見落とすとLAN全体への無認証公開か、`127.0.0.1`の不通を招く。

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

**Firewallを入れてから待受を広げる。**順序を逆にすると、その間はLAN全体へ無認証で公開される。手順1に記録したとおり、Hyper-V Firewallの既定が`Allow`のまま待受を広げる事故は実機で起きている。本節は上から順に実行すればこの順序になる。待受を広げるコマンドは末尾に置いた。

### 既定が拒否だと確認済みの場合の順序

手順1で**該当する層のすべてが既定拒否である**ことを実測できている場合に限り、待受を広げる操作(手順3の常駐化を含む)を、個別のFirewallルール追加より先に行ってよい。既定拒否の層では、ルールを足していないポートはLANから到達しないため、bindを広げただけでは無認証公開にならない。

確認すべき値は種別で決まる。

- Linux単体: `ufw status verbose`が`Default: deny (incoming)`、またはfirewalldのゾーンtargetが`default`/`%%REJECT%%`/`DROP`
- Windows単体: `Get-NetFirewallProfile`の適用中プロファイルが`Enabled=True`かつ`DefaultInboundAction`が`Block`(または既定値の`NotConfigured`)
- WSL2: 上のWSL内Firewallに加えて、`Get-NetFirewallHyperVVMSetting`の`DefaultInboundAction`が`Block`

2026-09-20のRemote PC(192.168.1.2、WSL2 mirrored)の復旧作業では、Hyper-V Firewallが`DefaultInboundAction=Block`、WSL内ufwが`Default: deny (incoming)`であることを先に実測した上で、voice-runnerの常駐(手順3)を先に行った。同日の構築時の事故はHyper-V Firewallの既定が`Allow`だったケースであり、既定がBlockだと確認できている場合には当てはまらない。

緩和が効くのは既定拒否の確認まで含めて実測したときだけである。次のいずれかに当てはまるなら緩和せず、本節を上から順に実行する。

- 手順1を飛ばした、または片方の層しか見ていない
- 別のPCへ手順を流用しており、そのPCでは既定を確認していない
- 既定拒否を確認したあとにFirewallの設定を変更した

緩和しても、到達元を手元PCへ限定するルールは最終的に必要である。省略してよいのは順序だけであり、ルール自体ではない。

まずFirewallで8188への受信を許可する。到達元は必ず手元PCのアドレスへ限定する。送信元を指定せずにポートを開けると、LAN上の全ホストから到達できる。`<手元PCのIP>`は実際のアドレスへ置き換える。

Windowsの場合、管理者権限のPowerShellで次を実行する。

```powershell
New-NetFirewallRule -DisplayName "ComfyUI LAN" -Direction Inbound -Protocol TCP -LocalPort 8188 -RemoteAddress <手元PCのIP> -Action Allow
```

Linuxでufwを使う場合。`ufw allow 8188/tcp`は送信元を限定しないため使わない。

```bash
sudo ufw allow from <手元PCのIP> to any port 8188 proto tcp
```

ufwを使う場合、IPv6の扱いも確かめる。`/etc/default/ufw`の`IPV6`が`no`だと、ufwはip6tablesを管理しない。この状態では`ufw status verbose`が`Default: deny (incoming)`を返してもIPv4にしか効かず、IPv6経路はカーネルの既定(通常は許可)のまま素通りする。上のルールもIPv4アドレスの指定であり、IPv6には効かない。

```bash
grep IPV6 /etc/default/ufw
ip -6 addr show scope global
```

`IPV6=yes`にして既定のdenyとルールをIPv6へも適用するのを既定とする。`no`のままにするなら、Remote PCがグローバルスコープのIPv6アドレスを持たないことが条件になるが、これは一度確かめれば済むものではない。ルーター側の設定変更やISPからのプレフィックス配布で後からアドレスが付くと、その時点で8188がIPv6経由で無認証のまま到達可能になる。`no`を選ぶなら再確認を運用へ組み込む。

firewalldを使う場合。`--add-rich-rule`は`family="ipv4"`を指定しており、IPv6には効かない。IPv6が素通りするかはゾーンのtargetで決まるため、先に次で確かめる。

```bash
sudo firewall-cmd --get-active-zones
sudo firewall-cmd --zone=<zone> --list-all   # target の値を見る
```

targetが`default`、`%%REJECT%%`、`DROP`のいずれかなら、許可していないIPv6も落ちる。`ACCEPT`ならIPv6は素通りするため、`family="ipv6"`のルールを別に足すか、IPv6を無効にする。

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

WSL内のufwは、上のLinux向けの手順に次の1行を足す。

```bash
sudo ufw allow in on loopback0
```

この行を落とすと`127.0.0.1`が不通になる。mirroredモードには`lo`とは別に`loopback0`があり、`127.0.0.1`宛はそちらを通る。ufwの既定の受信許可は`-i lo`しか対象にしないため、`ufw default deny incoming`だけを入れるとloopbackが落ちる。

この失敗は気付きにくい。プロセスもポートも正常に見え、LAN IP経由(`http://<remote>:8188`)では200が返る一方、`http://127.0.0.1:8188`だけがタイムアウトする。ComfyUIに限らず、Remote PC上で`127.0.0.1`へ繋ぐ既存のスクリプトもすべて止まる。

この1行はプロトコルもポートも限定せず、`loopback0`経由の受信をすべて通す。前提は`loopback0`がループバック専用でLANから到達しないことであり、`ip addr show loopback0`でホストスコープのアドレスだけを持つことを確かめてから入れる。

### Firewallを入れたら待受を広げる

上のFirewall設定(WSL2なら2層とも)を終えてから、次を実行する。

```bash
python main.py --listen 0.0.0.0 --port 8188
```

常駐させる場合は、手順3のservice定義へ同じ引数を入れる。手順3の定義だけを別のPCへ流用すると、Firewallが無いまま待受が広がる。再構築のときも手順2から行う。

設定後、手元PC以外の端末から8188へ到達できないことを確かめる。

```bash
curl --max-time 5 -sS http://<remote>:8188/system_stats; echo "exit=$?"
```

到達元制限が効いていれば接続が張れず、`exit=28`(タイムアウト)または`exit=7`(接続拒否)になる。**HTTPステータスが返ってきたら到達できている。**`curl`は4xxや5xxを受け取っても既定では非0で終わらないため、本文が返ったかどうかで判断する。

**Remote PC自身からこのテストを行っても意味がない。**自ホスト宛のパケットは送信元アドレスに関わらず`lo`を通り、Firewallの層まで届かない。送信元をdocker0などへ変えても結果は同じで、応答が返ってくる。通ったことを制限の失敗と読み違えないよう、必ず別の端末から実行する。

WSL2 mirroredモードでも同じであることを2026-09-20に実測した。送信元をdocker0のアドレスにしてRemote PC自身のLAN IPへ繋ぐとJSONが返るが、`ip route get <remote> from <docker0のIP>`は`local ... dev lo`を返しており、Hyper-V Firewallの層には届いていない。

Remote PC上で`curl http://127.0.0.1:8188/system_stats`が200を返すことも併せて確かめる。

ルーターでのポート開放(WAN公開)は行わない。

この送信元制限はネットワークアドレスに基づくものであり、認証ではない。同一セグメント内でのIP偽装には耐えられない。判断の前提は[ADR 0002](../adr/0002-remote-gpu-host.md)に記録する。

### ComfyUI以外のポートも同じ扱いにする

手順2と対になる作業である。ComfyUI以外のサービスをRemote PCで動かすなら必ず行う。動かさないなら飛ばしてよい。

Remote PCへ置くサービスは8188だけではない。`voice-runner`(既定8770)と、`novel-writer`側の`ai-media`参照API(既定8765)も同じマシンで動く。いずれも認証機構を持たない。

この2つは手元PCのApplication APIから接続する([ADR 0002](../adr/0002-remote-gpu-host.md)の配置表)。つまり8188と同じく待受を広げる必要があり、同じく到達元を限定する必要がある。「手元PCから接続しないから`127.0.0.1`のままでよい」が当てはまるのは、Remote PC内だけで完結する別のサービスである。

本節は到達元の制限までを扱う。`voice-runner`本体を起動して常駐させる手順は手順3にある。本節を終えてから手順3のrunner常駐へ進む。

8188の手順をポート番号だけ変えて同じように適用する。

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

提案Providerに`qwen`を使う場合は、OpenAI互換の推論サーバー(既定8000)も同じ扱いにする。このサーバーも認証機構を持たず、手元PCのApplication APIから接続する。使わないなら広げない。

```powershell
# WSL2の場合。8188と同じVMCreatorIdを使う
New-NetFirewallHyperVRule -Name "qwen-8000" -DisplayName "Qwen inference server (from <手元PCのIP>)" -Direction Inbound -VMCreatorId '<VMCreatorId>' -Protocol TCP -LocalPorts 8000 -RemoteAddresses <手元PCのIP> -Action Allow
```

```bash
sudo ufw allow from <手元PCのIP> to any port 8000 proto tcp
```

設定後、待受と到達元制限を別々に確かめる。

まずRemote PCで待受を棚卸しする。これはbindアドレスしか見ないため、送信元制限が効いているかは分からない。広げたポートだけが`0.0.0.0`で待っていることを見る。`127.0.0.1`や`::1`で待っているものは外から到達しない。

```bash
ss -tlnp | grep -E ':(8000|8188|8765|8770)\b'
```

次に、手元PC以外の端末から到達できないことを確かめる。Firewallの到達元制限はこれでしか検証できない。

```bash
for port in 8000 8765 8770; do
  curl --max-time 5 -sS "http://<remote>:$port/"; echo "port=$port exit=$?"
done
```

8188と同じく、`exit=28`または`exit=7`なら到達できていない。応答本文が返ったら到達できている。動かしていないサービスのポートは`exit=7`になるため、待受の棚卸しと併せて読む。

## 3. 常駐させる

常駐させるのはComfyUIと`voice-runner`の2つである。TTSとWhisperのBackendは常駐させない(手順6)。`voice-runner`が要求時に起動し、終了後にプロセスを落としてVRAMを返す。この配置は[ADR 0002](../adr/0002-remote-gpu-host.md)の配置表に記録する。

### ComfyUIを常駐させる

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

カスタムノードにはgit管理下にないものが混じる。HuggingFaceなどからファイルを取得して配置したものがこれにあたり、`git log`では版が分からない。配布元URLと取得時のrevisionを別途記録しておく。ComfyUI Managerの管理対象外になるため、更新確認は手動で行う。

### voice-runnerを常駐させる

`voice-runner`は音声生成(TTS)と読み検証(ASR)のBackendを束ねるHTTPサービスであり、既定で8770を使う。起動と停止はComfyUIと同じく外部運用であり、**Application APIはrunnerのプロセスを起動しない**。この手順を飛ばすと、音声Jobだけが`BACKEND_UNAVAILABLE`で失敗する。runner自身の構成は[voice-runnerのREADME](../../tools/voice-runner/README.md)に記録する。

**先に8770のFirewallルールを入れる。**「ComfyUI以外のポートも同じ扱いにする」の8770向けルール(到達元を手元PCのIPへ限定)を入れてから、以下の常駐設定を行う。`--host 0.0.0.0`はComfyUIと同じく無認証公開である。順序を逆にすると、その間はLAN上の全ホストが生成を投入できる。runnerには認証もrate limitも同時実行数の上限もなく、Application API側の直列キューもrunnerを直接叩かれると迂回される。

例外は手順2の「既定が拒否だと確認済みの場合の順序」の条件を満たすときだけである。該当する層のすべてが既定拒否だと実測できていれば、ルール追加より先に常駐設定を行ってよい。その場合も8770のルール自体は最終的に要る。入れるまで手元PCからrunnerへ到達できない。

runnerはMyComfyUIのリポジトリから起動する。Remote PCへリポジトリをcloneし、uvを入れておく。runner自身のvenvにはFastAPIとUvicornとPyYAMLしか入らないため、GPUもモデルも要らない。

Linuxではsystemdのuser unitを作る。`<user>`と各pathは実際の環境へ置き換える。

```ini
# ~/.config/systemd/user/voice-runner.service
[Unit]
Description=MyComfyUI voice-runner
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/<user>/MyComfyUI
ExecStart=/home/<user>/.local/bin/uv run --project tools/voice-runner uvicorn voice_runner.app:app --host 0.0.0.0 --port 8770
Restart=on-failure
RestartSec=10
StandardOutput=append:/home/<user>/MyComfyUI/logs/voice-runner.log
StandardError=append:/home/<user>/MyComfyUI/logs/voice-runner.err

[Install]
WantedBy=default.target
```

```bash
mkdir -p ~/MyComfyUI/logs && chmod 700 ~/MyComfyUI/logs
systemctl --user daemon-reload
systemctl --user enable --now voice-runner
```

ComfyUIと同じく`loginctl enable-linger $USER`が要る。ComfyUIの手順で済ませていれば重ねて実行しなくてよい。

上の`~/MyComfyUI/logs`はcloneしたリポジトリの作業ディレクトリの中にある。リポジトリの`.gitignore`はリポジトリ直下の`/logs/`を追跡対象外にしてあるため、ここへ出力しても`git status`は汚れず、`git pull`の妨げにもならない。これを既定とする。後述のWindowsの`C:\MyComfyUI\logs`も同じ扱いである。

リポジトリ外へ出したい場合は`~/.local/share/mycomfyui/logs`のようなpathへ置き換えてよい。unitの`StandardOutput`と`StandardError`、および`mkdir`のpathを揃えて変える。`WorkingDirectory`はリポジトリのままにする。`uv run --project tools/voice-runner`がリポジトリ内の相対pathを前提にしているためである。

WindowsではNSSMでサービス化する。pathは実際の環境へ置き換える。

```powershell
nssm install voice-runner C:\Users\<user>\.local\bin\uv.exe "run --project tools/voice-runner uvicorn voice_runner.app:app --host 0.0.0.0 --port 8770"
nssm set voice-runner AppDirectory C:\MyComfyUI
nssm set voice-runner AppStdout C:\MyComfyUI\logs\voice-runner.log
nssm set voice-runner AppStderr C:\MyComfyUI\logs\voice-runner.err
nssm start voice-runner
```

runner自身のログに残るのは、uvicornのアクセスログと、HTTPへ翻訳されなかった例外のstack traceである。合成するテキストと参照音声はHTTP bodyで渡るため、ログファイルには載らない。Backendが失敗したときの標準エラーも、末尾2000文字がHTTP応答の`detail`へ載るだけでログには出ない(`tools/voice-runner/src/voice_runner/process.py`)。

それでも出力先ディレクトリは、ComfyUIのログと同じく本人だけが読める権限にする。アクセスログには投入の時刻と回数が残り、stack traceには一時ファイルのpathが混じる。Linuxの手順に入れた`chmod 700`はこのためであり、Windowsでも同じく出力先のACLを本人だけへ絞る。

起動したら、Remote PC上で待受とhealthを確かめる。

```bash
ss -tlnp | grep :8770
curl http://127.0.0.1:8770/v1/health
```

`/v1/health`はモデルをロードせず、engineのPython実行ファイルがあるかどうかだけを見る。手順6のvenvが揃う前でも、起動しているかどうかの確認には使える。engineが利用不可で返る場合は手順6を終えてからrunnerを再起動する。

生成が通るのは、手順6のvenvが`tools/voice-runner/engines.yaml`の`python`と一致してからである。runnerが上がっているだけでは音声Jobは成功しない。

手元PCからの疎通確認は手順5と同じく別の端末から行う。到達元制限を確かめる手順は「ComfyUI以外のポートも同じ扱いにする」に置いた。

## 4. モデル資産を配置する

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

ComfyUIと同時に常駐させない。VRAMの実測値は`<novel-writer>/tools/ai-media/docs/tts-backends.md`に記録がある。以降、この配下を`ai-media`と呼ぶ。独立したリポジトリではなく、`novel-writer`の作業ディレクトリの中にある。

**新しくvenvを作る前に、既にあるものを探す。**`novel-writer/tools/ai-media/`配下と利用者のhomeに、これらのvenvが既に置かれていることがある。重複して作ると数十GBを無駄にし、`engines.yaml`がどちらを指しているか分からなくなる。

```bash
ls -d ~/qwen-tts/.venv ~/voxcpm/.venv 2>/dev/null
ls -d <novel-writer>/tools/ai-media/tools/*/.venv 2>/dev/null
```

用意したvenvのpathは`tools/voice-runner/engines.yaml`の`python`と一致している必要がある。一致しない場合、`voice-runner`はBackendを起動できない。**`engines.yaml`を実機へ合わせるのではなく、まず実機が`engines.yaml`の指すpathを満たしているかを確かめる。**値の出典は`<novel-writer>/tools/ai-media/config/local-tools.yaml`であり、勝手に別の場所へ作ると出典から外れる。

ASRは専用のvenvを作らない。`engines.yaml`の`asr.python`はQwen3-TTSのvenvを指す。`<novel-writer>/tools/ai-media/tools/asr/transcribe.py`が、HFキャッシュ済みの`openai/whisper-large-v3-turbo`をtransformersの`pipeline`で読む設計であり、既存環境へ書き込まない。faster-whisperは使わない。

venvには推論に使わない依存を入れない。既に入っているものも、推論経路で使わないなら除く。常駐ホストでは使わない依存がそのまま攻撃面になる。ただし`engines.yaml`が指す正本のvenvは既に要件を満たしているため、動いているvenvから依存を外して回る必要はない。自分で新しく作るvenvに対して適用する。

CosyVoice3の実行には`PYTHONPATH`が要る。`engines.yaml`の`home`からの相対で次を指定する。

```
PYTHONPATH=CosyVoice:CosyVoice/third_party/Matcha-TTS
```

用意できたら、起動せずにimportだけを確かめる。pathは`engines.yaml`の値に合わせる。

```bash
~/qwen-tts/.venv/bin/python -c "import qwen_tts"
~/voxcpm/.venv/bin/python -c "import voxcpm"
~/qwen-tts/.venv/bin/python -c "import transformers, torch; print(torch.cuda.is_available())"
cd <cosyvoice-home> && PYTHONPATH=CosyVoice:CosyVoice/third_party/Matcha-TTS .venv/bin/python -c "from cosyvoice.cli.cosyvoice import CosyVoice2"
```

importまで確認できたら、手順3の「voice-runnerを常駐させる」へ戻る。venvを置いただけでは音声Jobは通らない。venvを使う側のrunnerが上がっていない限り、Application APIは接続先へ到達できない。

## 7. 手元PCの接続先を変える

```dotenv
MYCOMFYUI_COMFYUI_BASE_URL=http://<remote>:8188
MYCOMFYUI_COMFYUI_TIMEOUT_SECONDS=900
MYCOMFYUI_VOICE_RUNNER_BASE_URL=http://<remote>:8770
```

提案Providerに`qwen`を使う場合、または画像から抽出したタグを整理する場合は、推論サーバーの接続先も同じように向ける。画像そのものの解析はComfyUIの`WD14Tagger|pysssss`が行うため、視覚言語モデルは要らない。

```dotenv
MYCOMFYUI_AGENT_QWEN_BASE_URL=http://<remote>:8000/v1
MYCOMFYUI_AGENT_QWEN_MODEL=<推論サーバーへ載せたモデル名>
```

推論サーバーを常駐させず、接続を受けてから起動する構成では、状態照会口の接続先も指定する。

```dotenv
MYCOMFYUI_AGENT_QWEN_STATUS_URL=http://<remote>:8002/status
```

ComfyUIのタイムアウトはネットワーク往復と生成物の転送分の余裕を見る。既定は600秒。

`MYCOMFYUI_VOICE_RUNNER_BASE_URL`の既定値は`http://127.0.0.1:8770`であり、手元完結構成ではそのままでよい。Remote構成でこの行を落とすと、手元PCの8770へ繋ぎにいって接続を拒否される。冒頭に挙げた症状が出たときは、手順3のrunner常駐と併せてこの値を確かめる。

`MYCOMFYUI_VOICE_RUNNER_TIMEOUT_SECONDS`は1台詞あたりの実行上限であり、既定は300秒。Backendのプロセス起動とモデルロードを含む値のため、Remote構成にしたことだけを理由に変えない。実測で足りなければ上げる。

`MYCOMFYUI_AGENT_QWEN_BASE_URL`の既定値は`http://127.0.0.1:8000/v1`である。パス末尾の`/v1`まで含めて指定する。提案Providerとタグの整理はこの値へ`/chat/completions`を足して呼ぶ。

`MYCOMFYUI_AGENT_QWEN_STATUS_URL`は既定で未設定であり、推論サーバーを常駐させる構成では設定しなくてよい。未設定の場合、Application APIは`MYCOMFYUI_AGENT_QWEN_BASE_URL`へ`/models`を足して到達性を確かめる。推論サーバーが起きていない間は提案Provider一覧で`qwen`が`available: false`になる。

接続を受けてから推論サーバーを起動する構成では、この`/models`が問題になる。到達性を確かめるための接続そのものが起動の引き金を引くためである。可用性を表示するたびにGPUを占有するうえ、起動を待てずに`available: false`と表示することにもなる。状態照会口を設定すると、Application APIは`/models`を叩かず、次の形のJSONを読む。

```json
{"qwen": {"ready": true, "sleeping": false},
 "comfyui": {"active": false},
 "starting": false}
```

- `ready`は推論要求を今すぐ受け付けられることを表す。偽なら起動を待つ時間がかかる
- `sleeping`はVRAMを解放した休止状態を表す。判別できない場合は`null`でよい
- `comfyui.active`は、Qwenの起動によって停止する側が動いていることを表す
- `starting`は起動処理が進行中であることを表す

照会口を設定した場合、`qwen`の`available`は「今すぐ応答できるか」ではなく「要求すれば応答させられるか」を表す。照会口が応答するかぎり、推論サーバーが停止中でも`available: true`とし、起動の待ち時間と、起動がComfyUIの停止を伴うことは一覧の`backend`で表す。照会口へ到達できない場合だけ`available: false`になる。

照会口は接続を受けても推論サーバーを起動しないものとする。起動する実装を指すと、`/models`を叩いていたときと同じ問題が起きる。

どの構成でも、`qwen`が使えないことが他のProviderと生成Jobへ影響することはない。

画像タグ抽出はComfyUI(8188)へWorkflowとして投入する。選択した画像は`/upload/image`でRemote GPU HostのComfyUIへ転送され、`input/mycomfyui-tagger/`へ置かれる。ComfyUIはinputのファイルを消すAPIを持たないため、このディレクトリは溜まり続ける。生成に使う素材とは混ざらないので、不要になったらディレクトリごと消してよい。抽出したタグは既定で推論サーバーへ渡して整理するが、この段は任意であり、繋がらない場合はWD14 Taggerが出したタグをそのまま返す。整理を行わない場合は`MYCOMFYUI_IMAGE_TAGGER_REFINE=false`とする。

設定の詳細は[Application APIのREADME](../../apps/api/README.md)を参照する。

## 失敗したときに見るところ

|症状|失敗コード|確認|
|---|---|---|
|Jobがすぐ失敗する|`BACKEND_UNAVAILABLE`|手順1と手順2のFirewallと待受、Remote PCの電源、アドレスの変化|
|音声Jobだけが失敗する|`BACKEND_UNAVAILABLE`|手順3の`voice-runner`常駐、手順7の`MYCOMFYUI_VOICE_RUNNER_BASE_URL`、「ComfyUI以外のポートも同じ扱いにする」の8770|
|`qwen`の提案だけが失敗する|`AGENT_UNAVAILABLE`|推論サーバーの起動、手順7の`MYCOMFYUI_AGENT_QWEN_BASE_URL`と`MYCOMFYUI_AGENT_QWEN_MODEL`、「ComfyUI以外のポートも同じ扱いにする」の8000|
|`qwen`が選べない(`available: false`)|-|状態照会口を使う構成なら手順7の`MYCOMFYUI_AGENT_QWEN_STATUS_URL`と、照会口への到達可否。使わない構成なら推論サーバーの起動|
|画像タグ抽出が失敗する|`IMAGE_TAGGER_ERROR`|ComfyUIの起動、WD14 Taggerノードの導入、`MYCOMFYUI_IMAGE_TAGGER_MODEL`が`/object_info`の選択肢にあること、手順7の`MYCOMFYUI_COMFYUI_BASE_URL`|
|実行中に失敗する|`BACKEND_DISCONNECTED`|ネットワークの切断、ComfyUIプロセスの落ち、手順3のログ|
|モデルが見つからない|`MODEL_NOT_FOUND`|手順4のファイル名とRecipeの指す名前|
|完了検知が遅い|—|手順5のWebSocket。ポーリングへ落ちていないか|
