# 今日の秘書

個人向けタスク管理PWA。オフラインで動作し、Googleスプレッドシートにデータを蓄積する。
素のHTML/CSS/JS（ビルドなし）で作られ、GitHub Pagesで公開している。

## 開発を引き継ぐ場合
**まず `HANDOFF.md` を読んでください。** プロダクト概要・データモデル・処理の地図・開発経緯・デプロイ手順がすべて書いてあります。
`CLAUDE.md` には遵守すべき開発ルールを記載しています（Claude Codeは自動で参照します）。

## ローカルで動かす
```bash
python3 -m http.server 8000
# http://localhost:8000 を開く
```
同期を使わなければ（設定でURL未入力なら）localStorageだけで全機能が動作します。

## 構成
- `index.html` / `styles.css` / `app.js` / `sw.js` — アプリ本体
- `manifest.webmanifest` / `icon-*.png` — PWA
- `Code.gs` — スプレッドシート側に貼るGoogle Apps Script（アプリには含めない）
- `docs/` — フェーズごとの変更手順書（履歴）

## デプロイ
アプリ: 上記4ファイル（＋変更あればmanifest/アイコン）をGitHub Pagesのリポジトリに上書き。**変更時は `sw.js` のCACHE版数を+1する。**
Apps Script: `Code.gs` を変更したら「デプロイを管理→新バージョン」で更新（「新しいデプロイ」はURLが変わるので不可）。
