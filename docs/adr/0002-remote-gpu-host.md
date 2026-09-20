# ADR 0002:生成BackendのRemote GPUホスト構成

- 状態:採用
- 決定日:2026-09-20
- 対象:Phase 1以降の生成Backend実行境界
- 関連:[ADR 0001](0001-application-stack-and-boundaries.md)

## 結論

Web UI、Application API、SQLite、Artifactストアは利用者の手元PCで動かし、GPUを使う生成BackendはLAN上の別マシン(以下Remote PC)へ置く。Application APIからBackendへの接続はHTTPとWebSocketだけとし、共有ファイルシステムを前提にしない。

Remote PCではComfyUIを常駐させ、TTS(Qwen3-TTS、VoxCPM2、CosyVoice3)とWhisperは要求時に起動して終了後にVRAMを返す。

ComfyUIの待受は`--listen 0.0.0.0`でLANへ直接公開し、ルーターでのポート開放(WAN公開)は行わない。

## 背景

ADR 0001はBackendが手元PCのloopbackにいることを前提に書かれている。`docs/PLAN.md`も同じ前提で、ComfyUIを「起動→1コマンド→停止」で運用すると記述していた。

2026-09-20に手元PCを実測した結果、この前提が成立しないことがわかった(#11)。手元PCのGPUはRTX 4050 Laptop、VRAM 6141 MiB(空き約4.9 GB)である。`ai-media/docs/tts-backends.md`に記録されたVRAM実測値は、Qwen3-TTSが生成peak 5.5 GB、VoxCPM2が7.6 GB、CosyVoice3が5.8 GBであり、いずれも手元PCの空きVRAMを超える。画像生成についても、モデルによっては同じ制約に当たる。

#11では音声Backendに限って「UIとApplication APIを手元PCで動かし、実行は別マシンのGPUへ委ねる」方針を決めた。本ADRはこれをComfyUIを含む生成Backend全体の構成として確定し、文書間の前提を揃える。

## ADR 0001との関係

ADR 0001は制約として「ローカル利用を前提とし、外部ネットワークへAPIを公開しない」を置いている。この制約はMyComfyUI自身のApplication APIとWeb UIの公開範囲に関するものであり、本ADRでは変更しない。

- Application APIは既定どおり`127.0.0.1`だけへbindする。`0.0.0.0`を既定値にしない。
- Web UIは手元PCのloopback originからのみ利用する。
- CORSとWebSocketのOrigin許可範囲も変えない。

本ADRが変えるのは、Application APIが接続する先である。「Backendが同一マシンのloopbackにいる」という前提を外し、接続先URLで手元構成とRemote構成を切り替えられる形にする。ADR 0001のプロセス境界図とAdapterの責務はそのまま維持する。

## 配置

手元PCに置くもの。

|対象|理由|
|---|---|
|Web UI|利用者が操作する画面であり、GPUを使わない|
|Application API、SQLite、Artifactストア|生成履歴の正本を1箇所に集める|
|`ai-media`参照API|Canonの正本が`novel-writer`のある手元PCにある|
|Claude Code CLIによる提案Provider|`adapters/agent/claude_code.py`がsubprocessで起動するため、Application APIと同一マシンが必要|
|ffmpeg|CPU処理であり、入力となるArtifactが手元PCにある|

Remote PCに置くもの。

|対象|常駐|理由|
|---|---|---|
|ComfyUI|する|画像(Anima等)、動画(MiniMax H3)、音楽(ACE-Step)が同一プロセスで完結し、モデルロードの繰り返しを避けられる|
|checkpoint、LoRA、VAE|—|ComfyUIが読む先はRemote PCのファイルシステムに限られる|
|TTSとWhisperのvenv|しない|VRAM実測値がComfyUIとの同時常駐に耐えない。要求時に起動し、終了後にVRAMを返す|
|`voice-runner`(#11)|する|TTSとWhisperを要求時起動する口。runner自身はFastAPIとUvicornだけを持ち、GPUを使わない|

## 接続と生成物の受け渡し

Application APIとBackendの間はHTTPとWebSocketだけで接続する。

ComfyUIの出力は`GET /view`で取得している(`apps/api/src/mycomfyui_api/adapters/comfyui/client.py:293`)。このため、Remote構成でも生成物の受け渡しに共有ファイルシステムは要らない。Artifactは手元PCの`data_root`配下へ保存され、保存先の正本は手元PC側に残る。

`voice-runner`も同じ方針とし、wavと参照音声はHTTP bodyへbase64で載せる(#11)。

進捗監視は`ws://<host>:8188/ws`を使う(`apps/api/src/mycomfyui_api/adapters/comfyui/client.py:243`)。WebSocketが通らない場合は`/history/{prompt_id}`のポーリングへfallbackするが、完了検知が遅れる。Remote構成ではFirewallの設定でWebSocketだけが落ちることがあるため、疎通確認の項目に含める。

## 待受方式

ComfyUIには認証機構がない。待受方式として次の2案を比較した。

|案|接続先|利点|欠点|
|---|---|---|---|
|SSHポートフォワード|`http://127.0.0.1:8188`のまま|ComfyUIのbindを`127.0.0.1`に保てる。LAN上の他ホストから到達できない|常駐運用ではSSHセッションの維持(autossh等)が要る。切断時の失敗がBackend障害と区別しにくい|
|`--listen 0.0.0.0`|`http://<remote>:8188`|設定が単純で、セッション維持の仕組みが要らない|LAN上の任意のホストから任意のWorkflowを実行できる|

`--listen 0.0.0.0`を採用する。ComfyUIを常駐させる運用では、SSHセッションの維持そのものが新しい障害点になり、切断とBackend障害の切り分けが難しくなるためである。利用するLANは利用者が管理する自宅LANに限られる。

次を条件とする。

- ルーターでのポート開放(WAN公開)を行わない。Remote PCのComfyUIはLAN内からのみ到達できる。
- Remote PCのFirewallで8188への到達元を手元PCのアドレスへ限定する。
- ComfyUI本体とカスタムノードのバージョンを把握し、更新を適用する。

### テンプレート制限が及ばない範囲

MyComfyUI側からComfyUIへ渡すWorkflowは同梱テンプレートに限り、利用者由来のJSONをそのまま実行する経路は持たない(ADR 0001、`apps/api/README.md`)。この制約はRemote構成でも変えない。

ただしこれはApplication API層の制約であり、ComfyUI自身を守るものではない。8188へ到達できるホストは、Application APIを経由せず`/prompt`へ直接任意のWorkflowを投入できる。カスタムノードによってはファイルの読み書きや外部通信を伴うため、到達できること自体がRemote PC上での操作を許すことになる。「Application APIを介する限り安全」という読み方はできない。

同じ理由で、ComfyUI本体とカスタムノードの脆弱性はそのまま攻撃面になる。loopback限定の運用では届かなかった経路がLANへ開くため、バージョンを固定したまま放置しない。checkpointの読み込みはpickleを経由するものがあり、信頼できない配布元のモデルファイルを置かない。

### 緩和策の限界

送信元をFirewallで限定する措置はネットワークアドレスに基づくものであり、認証ではない。同一セグメント内でのIP偽装には耐えられない。LANへ侵入された場合や、管理下にないIoT機器が乗っ取られた場合、この措置は迂回されうる。

LANの信頼を前提にできない環境で使う場合は、この判断を見直してSSHポートフォワードへ切り替える。

## 設定

接続先は`MYCOMFYUI_COMFYUI_BASE_URL`で指定する(`apps/api/src/mycomfyui_api/settings.py`)。Remote構成ではRemote PCのURLを指す。Application APIのコードは変更しない。

`MYCOMFYUI_COMFYUI_TIMEOUT_SECONDS`はネットワーク往復と生成物の転送分の余裕を見る。

Remote PCの準備手順は[Remote GPUホストの準備](../operations/remote-gpu-host.md)に置く。

## 影響

- Remote PCが落ちている、またはネットワークが切れている場合、Jobは既存の失敗分類のまま`BACKEND_UNAVAILABLE`(`backend_start`、再試行可)または`BACKEND_DISCONNECTED`(`response_disconnect`、再試行可)になる。新しい失敗コードを追加しない。
- モデル資産はRemote PCに集約する。Recipeが指すモデル名がRemote PC上の実ファイル名と一致しない場合、`MODEL_NOT_FOUND`で失敗する。在庫確認は`/object_info`で行う。
- Phase 3(#12)のi2v/ref2vでは参照画像をComfyUIへ渡す必要がある。手元構成ならファイルパスで渡せたが、Remote構成では`POST /upload/image`による送信経路が要る。現在のComfyUI Adapterはこの経路を持たない。
- Phase 6(#15)のTauri版でも、Application APIはsidecarとして手元PCで動く。Backendの接続先設定だけがデスクトップ設定へ加わる。

## 不採用

|案|理由|
|---|---|
|Application APIごとRemote PCへ置く|ArtifactとSQLiteの正本が手元から離れ、`ai-media`参照APIとClaude Code CLIが同一マシンにいる前提も崩れる|
|生成物をSMB/NFSの共有フォルダ経由で受け取る|`GET /view`で足りる。共有設定という障害点と、OS差を持ち込む必要がない|
|TTSとWhisperもRemote PCで常駐させる|VRAM実測値の合計がComfyUIとの同時常駐に耐えない|
|ComfyUIも要求時起動にする|画像、動画、音楽がすべてComfyUIに載るため起動頻度が高く、モデルロードの待ち時間が積み上がる|
