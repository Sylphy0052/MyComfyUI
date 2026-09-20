# Web UIのAPI接続先を実行時に決める

Tauriは空きloopback portでApplication APIのsidecarを起動するため、接続先をビルド時に固定できない。Web UIは実行時に注入された値を使い、注入がなければ同一originを使う。

## 注入の書式

sidecarを起動する側は、bundleを読み込む前に次のglobalを書き込む。

```js
window.__MYCOMFYUI_API_BASE_URL__ = "http://127.0.0.1:53421";
```

値はoriginまでで足りる。画面側が`/api/v1`を足すため、末尾に`/api/v1`を付けない。末尾の`/`は落としてから扱う。Tauriでは`WebviewWindowBuilder`の初期化scriptのように、最初のscriptより前に走る経路で渡す。sidecarのportは[api-sidecar.md](./api-sidecar.md)の`MYCOMFYUI_API_LISTENING`の行から取る。

注入する側は、同じoriginをAPIの`--allow-origin`へも渡す。別originからの呼び出しになるため、CORSの許可がないとブラウザ側で止まる。

## 注入がない場合

globalが未定義、文字列でない値、空文字、URLとして読めない値、`http`と`https`以外のscheme、loopback以外のhostのいずれかなら、同一originの`/api/v1`へ寄せる。未定義以外はいずれも理由を`console.warn`へ残す。

hostは`localhost`、`127.0.0.0/8`、`::1`だけを受ける。APIは認証を持たずloopbackでだけ待ち受ける前提のため([ADR 0001](../adr/0001-application-stack-and-boundaries.md))、注入値が壊れてもプロンプトや生成物の指定が外部ホストへ出ないようにする。利用者が任意のリモートホストを指定する経路はIssue #64の対象外とする。

これにより次の経路は従来と変わらない。

- 開発時のVite proxy。画面は`/api/v1`を同一originとして呼び、Viteが`http://127.0.0.1:8000`へ中継する。
- Web版の配布。画面とAPIを同じoriginで出す前提は変えない。

## 実装

- `apps/web/src/api/base-url.ts`が解決を持つ。`apiBaseUrl()`は初回呼び出しで解決し、以降は同じ値を返す。
- `apps/web/src/api/client.ts`はすべてのリクエストと成果物のURL組み立てで`apiBaseUrl()`を使う。接続先の定数を他へ置かない。
