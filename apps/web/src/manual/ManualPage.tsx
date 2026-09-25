/**
 * 初めて使う人向けの使用マニュアル (Issue #278)。
 * 本体の画面状態や実行中Jobの監視を中断させないため、別ページとして別タブで開く。
 * 画面の文言を変えたときは、ここに引用しているボタン名や見出しも合わせて直す。
 */

import type { ReactNode } from "react";

const SECTIONS: { id: string; title: string }[] = [
  { id: "start", title: "はじめに: 起動のしかた" },
  { id: "layout", title: "画面の見方" },
  { id: "modes", title: "2つのモード" },
  { id: "basic", title: "基本の流れ: 画像を作って選ぶ" },
  { id: "image", title: "画像の変更・派生・スイープ" },
  { id: "media", title: "動画・音楽・音声・合成" },
  { id: "manage", title: "Project・資産・キャラクターの管理" },
  { id: "jobs", title: "Jobキューの見方" },
  { id: "shortcuts", title: "キーボードショートカット" },
  { id: "trouble", title: "困ったとき" },
];

function Section({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const title = SECTIONS.find((section) => section.id === id)?.title;
  return (
    <section id={id} className="panel">
      <h2>{title}</h2>
      {children}
      <p className="manual-back">
        <a href="#top">目次へ戻る</a>
      </p>
    </section>
  );
}

export function ManualPage() {
  return (
    <div className="manual" id="top">
      <header className="manual-header">
        <h1>MyComfyUI 使い方</h1>
        <a className="button-link" href="/">
          画面へ戻る
        </a>
      </header>

      <p className="manual-lead">
        MyComfyUIは、画像・音声・動画・音楽をAIで生成し、できた候補から使うものを選んでいくための画面です。このページでは、初めて使う人が1枚目の画像を作って採用するまでの流れと、各機能の使い方を説明します。画面上のボタン名は「」で囲んで示します。
      </p>

      <nav className="panel manual-toc" aria-label="目次">
        <h2>目次</h2>
        <ol>
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.title}</a>
            </li>
          ))}
        </ol>
      </nav>

      <Section id="start">
        <p>画面を使うには、次の3つが起動している必要があります。</p>
        <ol>
          <li>
            <strong>ComfyUI</strong>: 実際に画像や動画を生成するソフトです。
          </li>
          <li>
            <strong>Application API</strong>: 画面とComfyUIの間を取り持つサーバーです。リポジトリ直下で
            <code>npm run api:dev</code>を実行すると起動します。
          </li>
          <li>
            <strong>画面 (Web UI)</strong>: リポジトリ直下で<code>npm run dev</code>を実行し、ブラウザで
            <code>http://127.0.0.1:5173</code>を開きます。
          </li>
        </ol>
        <p>
          画面上部に「Application API へ接続できません。起動しているか確認してください。」と出る場合は、2のApplication APIが止まっています。
        </p>
      </Section>

      <Section id="layout">
        <p>画面は上部のヘッダーと、その下の3つの領域でできています。</p>
        <dl className="manual-terms">
          <dt>ヘッダー (上部)</dt>
          <dd>
            モードの切替 (「作品制作 (モードB)」「ラボ (モードA)」)、表示色の切替 (「ライト」「ダーク」「システム」)、「ショートカット (?)」、このページを開く「使い方」があります。「進捗通知」は、生成の進み具合を画面へ届ける方法です(「WebSocket」なら即時、「REST同期」なら数秒ごとに確認します。どちらでも使えます)。
          </dd>
          <dt>左: シーン一覧</dt>
          <dd>作業の対象を選ぶ場所です。Project (作品)、Scene (場面)、Shot (カット) の順に選びます。</dd>
          <dt>中央: 生成</dt>
          <dd>生成の内容を入力して投入し、できた候補を比べて採用・却下する場所です。</dd>
          <dt>右: Jobキュー</dt>
          <dd>投入した生成 (Job) の待ち状態や結果を確認する場所です。</dd>
        </dl>
        <p>左右の領域は境目をドラッグすると幅を変えられ、見出しのボタンで折りたためます。</p>
        <h3>用語</h3>
        <dl className="manual-terms">
          <dt>Project</dt>
          <dd>1つの作品のまとまりです。キャラクターや生成の既定値はProjectごとに持ちます。</dd>
          <dt>Scene / Shot</dt>
          <dd>Projectの中の場面とカットです。生成した画像はShotにひもづきます。</dd>
          <dt>Recipe</dt>
          <dd>生成のひな形です。どのモデルや手順で作るかが決まっており、入力欄はRecipeに応じて変わります。</dd>
          <dt>Job</dt>
          <dd>「〜を投入」ボタンで送った生成の1回分です。</dd>
          <dt>候補</dt>
          <dd>Jobでできた画像です。候補ごとに「採用」「却下」を決めます。</dd>
        </dl>
      </Section>

      <Section id="modes">
        <p>ヘッダー左側のボタンで、2つのモードを切り替えます。迷ったら「作品制作 (モードB)」から始めてください。</p>
        <dl className="manual-terms">
          <dt>作品制作 (モードB)</dt>
          <dd>
            1本の作品を順番に仕上げていくための、簡単な画面です。画面上部の工程 (「背景」「キャラクター参照」「音声・BGM」「動画」「仕上げ」)に沿って進みます。入力はプロンプト (作りたい絵の説明) が中心で、細かい設定は隠れています。
          </dd>
          <dt>ラボ (モードA)</dt>
          <dd>
            全機能を使える画面です。ヘッダー右側に「Project」「生成」「資産ブラウザ」「Workflow」が並び、動画・音楽・音声・合成の生成、画像の派生・スイープ、詳しい設定、候補のA/B比較が使えます。
          </dd>
        </dl>
      </Section>

      <Section id="basic">
        <p>作品制作 (モードB) で、画像を1枚作って採用するまでの手順です。</p>
        <ol className="manual-steps">
          <li>
            <strong>対象を選ぶ</strong>: 左の「使用するProject」でProjectを選び、SceneとShotを「選択してください」の欄から選びます。Projectがまだ無い場合は、先にラボ (モードA) の「Project」画面で「新規Project」から作ります (
            <a href="#manage">Project・資産・キャラクターの管理</a>)。Projectを選ばず「なし」のままでも生成はできます。
          </li>
          <li>
            <strong>作りたい絵を書く</strong>: 中央の「プロンプト」欄に、作りたい絵の内容を書きます。
          </li>
          <li>
            <strong>投入する</strong>: 「画像生成を投入」を押します。ボタンが「投入中...」の間は待ちます。
          </li>
          <li>
            <strong>進み具合を見る</strong>: 右のJobキューに、投入したJobが「待機中」「実行中」と表示され、終わると「成功」になります。
          </li>
          <li>
            <strong>候補を選ぶ</strong>: 成功すると、中央の「候補比較」に画像が並びます。気に入った画像は「採用」、使わない画像は「却下」を押します。決め直すときは「判定を戻す」を押します。
          </li>
        </ol>
        <p>
          候補がまだ無いときは「成功したJobの画像がまだありません。」と表示されます。Jobが成功するまで待ってください。
        </p>
        <h3>作品制作の工程を進める</h3>
        <p>
          作品制作 (モードB) の中央上部には、作品を仕上げるまでの5つの工程が並んでいます。各工程の「揃っている」「足りない」で、その工程が済んだかどうかが分かります。「足りない」ときは、何をすればよいかが工程の下に表示されます。
        </p>
        <ol className="manual-steps">
          <li>「背景」: 背景画像を生成し、採用します。</li>
          <li>「キャラクター参照」: 登場人物の参照画像を用意します。</li>
          <li>「音声・BGM」: 「音声」か「BGM」を選び、台詞の音声かBGMを生成します。</li>
          <li>「動画」: 動画を生成します。</li>
          <li>「仕上げ」: 動画・音声・BGMを合成して1本にします。</li>
        </ol>
        <p>
          「次へ: 〜」「戻る: 〜」で工程を移動します。工程の名前を押して直接移ることもできます。1つのShotが済んだら、左の「次のShotへ」で次のカットへ進みます。
        </p>
        <h3>ラボ (モードA) で投入するとき</h3>
        <p>ラボでは、プロンプトのほかに次の設定ができます。</p>
        <ul>
          <li>「Preset」: 「ベース (Recipe)」で生成のひな形を選びます。</li>
          <li>「出力設定」: モデルや生成のパラメータを変えます。</li>
          <li>「バリエーション」: 「バッチ数」で一度に作る回数を決めます (バッチサイズ×バッチ数が合計の枚数です)。</li>
          <li>「投入前に確認」: 実際に送る内容を投入前に確認できます。</li>
          <li>
            「タグを抽出」: 手元の画像から特徴を表すタグを取り出し、「プロンプトへ追加」でプロンプトに足せます。
          </li>
        </ul>
        <p>
          ラボの「候補比較」では、2枚をA/Bに並べて比べられます。画像はドラッグで移動、マウスホイールで拡大縮小し、「pan・zoom同期」を入れると2枚を同じように動かせます。「全画面A/B」で大きく比べ、「コンタクトシート」で一覧画像を作れます。
        </p>
      </Section>

      <Section id="image">
        <p>画像のタブには4つのサブタブがあります。「派生」と「スイープ」はラボ (モードA) だけで使えます。</p>
        <dl className="manual-terms">
          <dt>生成</dt>
          <dd>プロンプトから新しい画像を作ります (<a href="#basic">基本の流れ</a>)。</dd>
          <dt>変更</dt>
          <dd>
            元の画像の一部を変えます。「変えたい要素」で「ポーズ」「表情」「衣装」から選び、「生成したい絵の説明」を書いて「変更を投入」を押します。「使えるRecipeがまだありません。」と出る場合は、ラボでRecipeを登録してから使います。
          </dd>
          <dt>派生</dt>
          <dd>
            元の画像をもとに別の画像を作ります。「プロンプト」と「参照強度」「denoise」などを指定し、「派生生成を投入」を押します。
          </dd>
          <dt>スイープ</dt>
          <dd>
            設定を少しずつ変えた画像をまとめて作り、比べます。「実験名」と「プロンプト断片（1行1候補）」などを入れ、「展開を確認」で作られる組み合わせを確かめてから「確認した実験を作成」を押します。
          </dd>
        </dl>
      </Section>

      <Section id="media">
        <p>ラボ (モードA) の「生成」画面で、タブを切り替えて使います。どれも入力して「〜を投入」を押すと、右のJobキューに入ります。</p>
        <dl className="manual-terms">
          <dt>動画</dt>
          <dd>「プロンプト」「秒数」「幅」「高さ」などを入れて「動画生成を投入」を押します。結果は「生成した動画」に出ます。</dd>
          <dt>音楽</dt>
          <dd>「mood」(雰囲気)、「genre」(ジャンル)、「尺 (秒)」を入れて「音楽生成を投入」を押します。結果は「生成した音楽」に出ます。</dd>
          <dt>音声</dt>
          <dd>
            Shotの台詞を読み上げる音声を作ります。「読む台詞」と「プロファイル」(声の設定) を選び、「音声生成を投入」を押します。成功した音声Jobを選ぶと、「読み検証」で読み間違いや長さの超過を確認できます。
          </dd>
          <dt>合成</dt>
          <dd>
            動画に台詞音声とBGMを重ねて1本にします。「合成する動画」を選び、必要なら台詞音声と「BGM Artifact」「BGM音量」を指定して「合成を投入」を押します。台詞音声とBGMは指定しなくても投入できます。
          </dd>
        </dl>
        <p>
          「seed (-1で自動採番)」は乱数の種です。-1のままなら毎回違う結果になり、同じ数字を入れると同じ条件の結果を再現しやすくなります。
        </p>
      </Section>

      <Section id="manage">
        <p>ラボ (モードA) のヘッダー右側のボタンで画面を切り替えます。</p>
        <dl className="manual-terms">
          <dt>Project</dt>
          <dd>
            作品の作成と整理をします。「新規Project」で作成し、「生成で使う」で生成画面の対象にします。使わなくなったものは「アーカイブ」や「ゴミ箱へ移動」で片付け、「復元」で戻せます。「★ お気に入り」にしたProjectは、選択欄で名前の先頭に★が付きます。Projectを選ぶと詳細が「概要」「キャラクター」「シーン」のタブで開きます。概要は名前・説明・操作・タグ・制作進捗・最近の生成物・書き出しをまとめ、キャラクタータブでは登場人物を「追加」で登録して外見や衣装、声、プロンプトを設定します (プロンプトはAIに補完させられます)。登録したキャラクターの見た目をもとに生成すると、カットをまたいでも同じ人物に見えやすくなります。シーンタブはSceneがあるProjectだけに表示され、Sceneごとに展開してShotと生成済み画像を確認できます。
          </dd>
          <dt>資産ブラウザ</dt>
          <dd>
            これまでに生成した画像などを一覧で見て、検索・タグ付け・別のProjectへの移動ができます。Projectを選んでいないときは、どのProjectにも属さない生成物 (Inbox) を表示します。
          </dd>
          <dt>Workflow</dt>
          <dd>
            ComfyUIのワークフロー (生成手順) を登録・確認するダイアログを開きます。登録済みの版や、そのWorkflowを使うRecipeを確認できます。
          </dd>
        </dl>
        <p>
          ラボの左側では、SceneとShotの「追加」「編集」「削除」、「↑」「↓」やドラッグでの並べ替えができます。削除しても履歴は残り、直後に出る通知の「取り消す」で元に戻せます。
        </p>
      </Section>

      <Section id="jobs">
        <p>右のJobキューで、投入した生成の状態を確認します。</p>
        <dl className="manual-terms">
          <dt>待機中 / 実行中</dt>
          <dd>順番待ち、または生成中です。「取消」で止められます。</dd>
          <dt>成功</dt>
          <dd>生成が終わりました。画像なら「候補比較」に並びます。</dd>
          <dt>失敗</dt>
          <dd>Jobを選ぶと「Job詳細」に失敗理由が表示されます。「再投入に必要な入力」を見て、条件を直して投入し直してください。</dd>
          <dt>取消中 / 取消済み</dt>
          <dd>取り消しの処理中、または取り消し済みです。</dd>
        </dl>
        <p>
          終わったJobは「所属変更」で別のShotへ移せます。「このJobのArtifactも一緒に移動する」を入れると、できた画像も一緒に移ります。
        </p>
      </Section>

      <Section id="shortcuts">
        <p>
          <kbd>?</kbd>キーかヘッダーの「ショートカット (?)」で一覧を開けます。入力欄で文字を打っている間は反応しません。
        </p>
        <h3>作品制作 (モードB)</h3>
        <dl className="manual-keys">
          <dt><kbd>G</kbd></dt>
          <dd>画像生成を投入する</dd>
          <dt><kbd>←</kbd> <kbd>→</kbd></dt>
          <dd>前・次の候補を選ぶ</dd>
          <dt><kbd>A</kbd> / <kbd>X</kbd> / <kbd>U</kbd></dt>
          <dd>採用 / 却下 / 判定を戻す</dd>
          <dt><kbd>N</kbd></dt>
          <dd>次のShotへ移る</dd>
        </dl>
        <h3>ラボの候補比較</h3>
        <dl className="manual-keys">
          <dt><kbd>[</kbd> <kbd>]</kbd></dt>
          <dd>比較のA/Bを操作対象にする</dd>
          <dt><kbd>←</kbd> <kbd>→</kbd></dt>
          <dd>操作対象の側の候補を切り替える</dd>
          <dt><kbd>A</kbd> / <kbd>X</kbd> / <kbd>U</kbd></dt>
          <dd>採用 / 却下 / 判定を戻す</dd>
          <dt><kbd>F</kbd></dt>
          <dd>全画面比較を切り替える</dd>
        </dl>
        <h3>共通</h3>
        <dl className="manual-keys">
          <dt><kbd>Esc</kbd></dt>
          <dd>一覧・全画面を閉じる</dd>
        </dl>
      </Section>

      <Section id="trouble">
        <dl className="manual-terms">
          <dt>「Application API へ接続できません。起動しているか確認してください。」と出る</dt>
          <dd>
            Application APIが止まっています。<code>npm run api:dev</code>で起動してから、画面を再読み込みしてください。
          </dd>
          <dt>「ComfyUIへ接続できません」と出る / 生成が「待機中」のまま進まない</dt>
          <dd>ComfyUIが起動しているか確認してください。</dd>
          <dt>「voice-runnerへ接続できません」と出る</dt>
          <dd>音声生成用のサーバーが止まっています。音声以外の生成はそのまま使えます。</dd>
          <dt>「使えるRecipeがまだありません。」と出る</dt>
          <dd>その機能用のRecipeが登録されていません。ラボ (モードA) で登録してから使います。</dd>
          <dt>Jobが「失敗」になった</dt>
          <dd>右のJobキューでJobを選び、「Job詳細」の失敗理由を確認してください。</dd>
          <dt>入力欄の下に「〜は必須です。」と出る</dt>
          <dd>その項目が空です。値を入れてから投入してください。</dd>
          <dt>ボタンや画面が見当たらない</dt>
          <dd>作品制作 (モードB) では一部の機能を隠しています。ヘッダーで「ラボ (モードA)」に切り替えてください。</dd>
        </dl>
      </Section>
    </div>
  );
}
