# 「今日の秘書」開発引き継ぎ資料

このドキュメントは、Web版Claudeとの対話で開発してきた個人向けタスク管理PWA「今日の秘書」を、VSCode上のClaude(Claude Code)で引き継いで開発を続けるための資料です。**まずこのファイルを全部読んでから作業を始めてください。**

---

## 0. Claude Codeへの最初の指示（このセクションを読んだあなたへ）

あなたはこのプロジェクトの開発を引き継ぎます。以下を守ってください。

- **アーキテクチャを尊重する**: ビルドツールなし・フレームワークなしの素のHTML/CSS/JS（vanilla JS）で書かれています。この方針を変えないでください（GitHub Pagesで無ビルド公開するため）。
- **1ファイルに集約**: ロジックは全て `app.js`、スタイルは `styles.css`、DOMは `index.html`。分割やモジュール化はしないでください。
- **変更したら必ず `node --check app.js` で構文チェック**してから完了とすること。
- **Service Workerのキャッシュ版数を必ず上げる**: コードを変更したら `sw.js` の `const CACHE = "hisho-vN"` の数字を+1する。これを忘れると利用者の端末に更新が反映されません（現在の最新は後述）。
- **データ移行を壊さない**: `migrate()` 関数がデータのバージョン移行を担っています。`state` の構造を変えるときは必ず migrate に新バージョンの移行処理を追加すること。既存利用者のデータ（localStorage / スプレッドシート）を壊さないことが最優先。
- **Apps Script（Code.gs）を変更したら、手順書にデプロイ手順を明記**する（後述の「デプロイの罠」参照）。
- 作業後は、利用者（非エンジニア）向けに「GitHubにどのファイルを上げ、Apps Scriptをどう更新するか」の手順を簡潔な日本語で説明すること。

---

## 1. これは何か（プロダクト概要）

**目的**: 「スマホを見れば次にやるべき作業が分かる秘書」。オフラインで動き、データはオンラインのGoogleスプレッドシートに蓄積される。

利用者は1名（このアプリのオーナー、日本語UI）。iPhoneのSafariでホーム画面に追加してPWAとして使用。PCブラウザからも同一URLで使用し、スプレッドシート経由で双方向同期する。

**3つのタブ**
- **今日**: その日の実行画面。タイムライン表示、作業タイマー、見積超過アラート。日付を前後に移動でき、日ごとに「締め」てロックできる。
- **計画**（内部的には `gantt`）: 縦軸タスク×横軸日付のガント。日付マスをタップして実施日(●)/予備日(○)を割り当てる。日別見積合計、進捗率、予定期間バーを表示。
- **課題**（内部的には `plan`）: 課題（=長期目標）とタスク原本の管理。課題ごとにタスクをアコーディオンで展開。検索・アーカイブ・ドラッグ並べ替え。

---

## 2. 技術構成

| 項目 | 内容 |
|---|---|
| フロント | 素のHTML + CSS + JS。ビルドなし、npm依存なし |
| 永続化(端末) | `localStorage`（キー `hisho:data:v1`） |
| 永続化(クラウド) | Google スプレッドシート。Google Apps Script (`Code.gs`) をWebアプリとしてデプロイしたエンドポイントにfetchでPOST/GET |
| オフライン | Service Worker (`sw.js`)。ネットワーク優先＋キャッシュフォールバック |
| PWA | `manifest.webmanifest` + アイコン(icon-180/192/512.png) |
| ホスティング | GitHub Pages（リポジトリ名 `kyou-no-hisho`、ユーザー `nonameshade`） |

**重要な外部依存はゼロ**。CDNもフォントの読み込み程度。したがって `index.html` をブラウザで直接開けばほぼ動作確認できる（Service Workerとスプレッドシート同期を除く）。

---

## 3. ファイル構成

```
kyou-no-hisho/
├── index.html      # DOM構造。全タブ・全モーダル・全フォームがここに静的に存在し、JSで表示/非表示を切り替える
├── styles.css      # 全スタイル。CSS変数(:root)でカラートークン定義。フェーズごとに末尾へ追記する形で成長してきた
├── app.js          # 全ロジック（約2400行）。状態管理・描画・イベント・同期
├── sw.js           # Service Worker。CACHE版数を変更ごとに上げる
├── manifest.webmanifest
├── Code.gs         # Googleスプレッドシート側に貼り付けるApps Scriptコード（アプリには含めない）
├── icon-180.png / icon-192.png / icon-512.png
└── HANDOFF.md      # このファイル
```

---

## 4. データモデル（`state` オブジェクト）

`localStorage["hisho:data:v1"]` にJSONで保存。現在のスキーマバージョンは **v5**。

```js
state = {
  v: 5,                // スキーマバージョン
  updatedAt: 0,        // 最終更新のエポックms。双方向同期の勝敗判定（後勝ち）に使う
  issues: [],          // 課題（長期目標）
  tasks: [],           // タスク原本（階層構造）
  assignments: [],     // 日付への割り当て（今日タブの実体）
  skips: [],           // 周期タスクの自動予定を外した日
  reserves: [],        // 予備日（手動）
  closedDates: [],     // 締め済みの日付（"YYYY-MM-DD"の配列）
}
```

### issues（課題）
```js
{ id, title, purpose, deadline, targets:[{rank,text}], archived }
```
- `targets` はランク付き目標。例: `[{rank:"S",text:"購入履歴全件レビュー"},{rank:"A",text:"新規レビュー50"}]`
- `archived`: trueで計画タブから消え、配下タスクも非表示になる

### tasks（タスク原本）
```js
{
  id, title,
  parentId,      // 親タスクのid（階層。nullで最上位）
  issueId,       // 紐づく課題のid（null可）
  type,          // "single"(1回限り) | "recurring"(周期) | "irregular"(不定期) | "summary"(子の見出し)
  estimateMin,   // 見積分（summaryは0）
  defStart,      // 既定の開始時刻 "HH:MM"
  planStart, planEnd,  // ガントの予定期間（single/irregularのみ。nullで子から自動算出）
  recurrence,    // 周期ルール（後述、recurringのみ）
  reserveRule,   // 予備日ルール（recurringのみ）
  done,          // 完了フラグ（singleのみ意味を持つ）
  archived,      // アーカイブフラグ
  notes,         // 備考（500字まで。チップに表示）
  createdDate,
}
```

**recurrence の形**:
- `{kind:"everyNDays", n:3, anchor:"YYYY-MM-DD"}`
- `{kind:"weekly", weekdays:[1,3,5]}` （0=日〜6=土）
- `{kind:"monthly", day:15}`
- `{kind:"yearly", month:4, day:1}`

**reserveRule の形**（周期タスクの控えの日）:
- `{mode:"after", n:2}` 実施日のn日後
- `{mode:"before", n:1}` 実施日のn日前
- `{mode:"weekday", weekday:6}` 同じ週の指定曜日

### assignments（日付への割り当て = 今日タブの実体）
```js
{
  id, taskId,    // 元タスクのid（nullなら直接入力の単発。ただし現在はどこから追加してもtask原本を作る方針）
  title,         // 表示名（taskがあればそちら優先: asgTitle()参照）
  date,          // "YYYY-MM-DD"
  start,         // 開始時刻 "HH:MM"
  estimateMin,
  status,        // "todo" | "doing" | "done"
  spentSec,      // 実績秒（doing中はstartedAtからの経過を都度加算して算出: elapsedSec()参照）
  startedAt,     // タイマー開始時のエポックms（doing中のみ）
}
```

**重要な概念の区別**:
- **タスク原本(tasks)** = 「何をやるか」の定義。課題タブで管理。
- **割り当て(assignments)** = 「いつやるか」の実体。カレンダー/今日タブに出る。1つのタスクを複数日に割り当て可能。
- 周期タスクは、該当日に **materializeToday()** で自動的にassignmentを生成する。まだ生成されていない未来分は **dayItems()** が「仮想(virtual)」として合成して返す。

---

## 5. 主要な処理の地図（app.jsを読むときの索引）

### 状態管理
- `load()` / `persist()` / `save()` — 読み書き。`save()`は`updatedAt`更新＋dirtyフラグ＋同期予約
- `migrate()` — スキーマ移行。**構造変更時は必ずここに追記**

### 参照ヘルパー
- `taskById` / `issueById` / `asgTitle` / `crumbOf`（パンくず）
- `isTaskArchived(t)` — タスク自身 or 所属課題がアーカイブされているか
- `isClosed(dk)` / `execEditable(dk)` — 締め・編集可否（未来と締め済みは編集不可）
- `dayList(dk)`（実assignmentのみ） / `dayItems(dk)`（+周期の仮想予定）
- `occursOn(task,dk)` — 周期タスクがその日に該当するか
- `progressOf(t)` — 進捗率（配下single tasksの見積時間ベース）
- `effPeriod(t)` — ガントの期間（子からロールアップ）

### 描画（renderXxx）
- `renderAll()` — 現在のviewに応じて振り分け。FAB表示制御もここ
- `renderHeader()` — 日付ラベル＋統計
- `renderHero()` / `renderTimeline()` / `renderDayClose()` — 今日タブ
- `renderGantt()` / `updateGanttStickyHeader()` — 計画タブ（2ペイン構造：左=固定名前列 `.g-side`、右=スクロール `.g-scroll`）
- `renderDayDetail()` — ガント下部の日別詳細
- `renderPlan()` / `renderTaskTree()` / `computeVisibleTasks()` — 課題タブ

### 操作
- `startAsg/pauseAsg/finishAsg/reopenAsg/removeAsg` — 今日タブのタイマー操作
- `toggleCell(taskId,dk)` — ガントのマスタップ（空→●→○→空の循環）
- `archiveTask/archiveIssue` + `showSnack()` — アーカイブ（取り消しトースト付き）
- `saveTaskForm/saveIssueForm/saveAsgForm/openTaskForm/openIssueForm/openAsgForm` — フォーム

### イベント（app.js末尾に集約）
- 巨大な `document.addEventListener("click", ...)` で `data-action` 属性を分岐。**新機能のボタンはここに追記**
- `pointerdown/move/up` が **3系統** ある。競合しないよう注意:
  1. 並べ替えドラッグ（`.drag-h`ハンドル、`sortDrag`）
  2. スワイプでアーカイブ（`.swipe-target`、`swipe`）
  3. ガントのマーク移動（`.g-cell.has-mark`、`drag`）
- `input`（検索）、`change`（種類切替・チェックボックス）、`visibilitychange`（復帰時同期・離脱時即送信）、`scroll`（ヘッダー固定）

### 同期（Google Sheets）
- `pushSync()` — アプリ→シート（全stateをJSONで`_sync`タブに保存＋人間可読な複数タブを書き出し）
- `pullSync()` — シート→アプリ（`updatedAt`が新しければ取り込み）
- `fullSync()` — pull→必要ならpush。起動時・復帰時・手動同期で呼ぶ
- `updateSyncWarn()` — 未同期/同期中の固定バー表示

---

## 6. 同期の仕組みと「後勝ち」の注意

全端末が同じスプレッドシートの `_sync`（非表示）タブを介してstate全体を共有する。`updatedAt`（エポックms）を比較し、**後から保存した方が勝つ**単純な方式。2台で同時編集すると片方が消える。UI上は「未同期バー」と「離脱時の即時送信(keepalive)」で事故を減らしているが、根本的には片方ずつ使う前提。

人間が読める形として、同期時に `Issues` / `Tasks` / `Assignments` / `WorkLog` タブも書き出す（`readablePayload()`）。**WorkLog** は日付+タスク単位で予定・実績を蓄積するログ（IDキーで上書き、消えた割り当ての行も保持）。

---

## 7. デプロイの罠（利用者に必ず伝えること）

### GitHub Pages（アプリ本体）
`index.html / styles.css / app.js / sw.js`（＋変更あればmanifest/アイコン）をリポジトリに上書きアップロード。**sw.jsのCACHE版数を上げていれば**、利用者はアプリを開き直すだけで更新される（設定内「最新版に更新」ボタンでも可）。

### Apps Script（Code.gsを変更した場合のみ）
これが最大の罠。以下を必ず守るよう手順書に書く:
1. スプレッドシート →「拡張機能」→「Apps Script」
2. Code.gsを貼り替え、`const SECRET` を利用者の合言葉に設定
3. **「デプロイ」→「デプロイを管理」→ 鉛筆アイコン → バージョン「新バージョン」→「デプロイ」**
4. ⚠️「新しいデプロイ」を選ぶと **URLが変わってしまい**、アプリ側の設定URLと合わなくなる。必ず「デプロイを管理」から既存デプロイを更新すること。

---

## 8. これまでの開発経緯（フェーズ史）

段階的に開発してきた。各フェーズの主な内容:

- **フェーズ1**: 今日タブのMVP（タイムライン・タイマー・超過アラート）
- **フェーズ2**: Google Sheets同期（Apps Script方式）、オフライン対応
- **フェーズ3a/b/c**: 計画機能（階層タスク・カレンダー割り当て・ガント・進捗率・周期タスク）
- **フェーズ4**: 双方向同期、カレンダーとガント統合、課題タブ化、「きょう→今日」表記統一
- **フェーズ5**: ガント2ペイン化（位置ずれ根本修正）、予備日、不定期タスク、マークのドラッグ移動
- **フェーズ6**: 拡大無効化、設定モーダル化、入力欄サイズ修正、タスク追加の原本一本化、折りたたみ
- **フェーズ7**: 課題アコーディオン化、ドラッグ並べ替え、サマリータスク、月ラベル横書き、名前チップ
- **フェーズ8**: 未同期バー、ボタン配置統一(キャンセル左/保存右)、ミニタイマー、挿入ライン方式ドラッグ、課題の色分け廃止
- **フェーズ9**: 日付ナビ、締め機能、DailyLog、パンくず、チップのスクロール追随
- **フェーズ10**: WorkLog（日付+タスク単位ログ）、未来日の自動予定表示、日跨ぎタイマー
- **フェーズ11**: 備考(notes)、チップのトグル/4秒、時刻の重複省略、未予定タスクのオレンジ表示、保存後スクロール ＋ アーカイブ機能・検索・絞り込み
- **フェーズ12**: フェーズ11の再統合（Git実体とのズレ修正。※下記の教訓参照）
- **フェーズ13**（最新）: 超過通知を1開始1回に、同期バナー修正、「アーカイブを表示」化、保存/削除後スクロール強化、スワイプ改善（はみ出し・戻りアニメ・ちらつき解消）、課題のアーカイブ、日付ヘッダー上部固定

**現在のSchema版: v5 / Service Worker CACHE版: 下記コマンドで確認**
```
grep 'const CACHE' sw.js
```

**このHANDOFF作成時点の最新: Schema v5 / CACHE `hisho-v15`**

### 教訓（重要）
フェーズ12で、Web版Claudeの会話履歴とGitHub上の実体がズレる事故が起きた（会話から一部フェーズが抜け、古いベースに機能を追加してデグレ）。**今後は、作業開始前に現在のGitHub上の最新ファイルを正としてスタートすること。** このHANDOFFと同梱のコードが最新の正のはず。もし利用者が「Gitにはこうなっている」と言う場合、利用者のファイルを優先する。

---

## 9. 未実装のアイデア（もし提案を求められたら）

- 実績データ（WorkLog）を使った見積精度の振り返り（予定vs実績の乖離分析）
- iOSのPWA通知制約の回避策（現状バックグラウンド通知に制約あり。作業中は画面を開いたままにする運用）
- 同時編集コンフリクトのマージ（現状は後勝ち）

---

## 10. 動作確認の仕方

```bash
# 構文チェック（変更後は必ず）
node --check app.js && node --check sw.js

# ローカルで動かす（Service Worker/同期以外）
# index.htmlをブラウザで直接開くか、簡易サーバを立てる:
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

スプレッドシート同期まで含めて試すには、利用者のApps Script URLと合言葉が必要（設定画面 ⚙ から入力）。開発中は同期をオフのまま（URL未設定）でも全機能がlocalStorageで動作する。
