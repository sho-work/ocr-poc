# ocr-poc

[tesseract.js](https://github.com/naptha/tesseract.js) v7 と Google Cloud Vision API で、どんな写真の文字を読めるかを比べるための PoC です。

- **Tesseract.js**: ブラウザ内で処理します。画像はどこにも送信しません。
- **Cloud Vision**: 選んだときだけ、ローカルの `server.py` を経由して画像を Google に送信します。

## 起動

Python 3 の標準ライブラリだけで動きます。

```bash
python3 server.py
```

http://localhost:8765 を開きます。Tesseract は初回だけ言語データ（jpn は約 2MB）を jsDelivr から取得します。2回目以降はブラウザの IndexedDB にキャッシュされたものを使います。

## Cloud Vision を使うとき

1. Google Cloud で Cloud Vision API を有効にし、API キーを作ります。
2. キーの「API の制限」を **Cloud Vision API のみ** にします。
3. `.env` を作ってキーを書き、サーバーを再起動します。

   ```bash
   cp .env.example .env
   # .env の GOOGLE_CLOUD_VISION_API_KEY= にキーを書く
   ```

4. ページの「OCR エンジン」で Cloud Vision か「両方で比較」を選びます。

使う機能は `DOCUMENT_TEXT_DETECTION` です。従量課金ですが、毎月 1,000 件までは無料枠があります。予算アラートや API の割り当て上限も設定しておくと安心です。

## できること

- **サンプル画像で一括テスト**: くっきり印刷、明朝体、小さい文字、傾き、低コントラスト、ぼかし＋ノイズ、照明ムラ、白抜き、手書き風、縦書き、レシート、英文の 12 パターンをその場で作って認識させ、一致率を出します。
- **実際の写真**: ファイル選択、ドラッグ＆ドロップ、貼り付け、スマホのカメラ撮影に対応しています。
- **文字色で抜き出す**（Tesseract）: SNS 投稿のように写真に白文字を重ねた画像では、白くて彩度の低い画素だけを残します。PSM 11 と組み合わせると効果的です。
- **範囲を指定**: 元画像上をドラッグで囲み、その部分だけを認識します。
- **エンジン比較**: 「両方で比較」を選ぶと、同じ画像を Tesseract と Cloud Vision の両方にかけて実行ログに並べます。ログは TSV でコピーできます。

## API キーの扱い（セキュリティ）

- **キーはブラウザに渡さない**: `server.py` が環境変数または `.env` からキーを読み、Cloud Vision への中継だけを行います。`.env` は `.gitignore` 済みです。
- **中継サーバーを守る**
  - 待ち受けは `127.0.0.1` だけにし、LAN からは使えません。
  - 配信するのは `index.html` と `app.js` だけです。`.env` やソースは 404 を返します。
  - `Host` ヘッダーを確認して、DNS リバインディングを防ぎます。
  - `Origin` ヘッダーと `Content-Type: application/json` を必須にして、他サイトからの POST（CSRF）で課金されるのを防ぎます。
  - リクエストの中身はサーバー側で固定し、文字検出しかできないようにしています。
  - 1 回の起動で送れる件数に上限を設けています（`VISION_MAX_REQUESTS`、既定 100）。
- **ページ側の対策**
  - tesseract.js を SRI（`integrity`）で固定しています。
  - CSP で、スクリプトの読み込み元と通信先を自分自身と jsDelivr に限定しています。
  - インラインスクリプトはやめ、`app.js` に分けています。

本番では、サービスアカウントや Workload Identity を使うサーバー側の実装に置き換えてください。

## 分かったこと（2026-11-03）

| 画像 | 条件 | 一致率 |
|---|---|---|
| SNS 投稿（料理写真に白文字） | Tesseract、PSM 3 | 1% |
| 同上 | Tesseract、白い文字＋PSM 11 | 88% |
| 同上 | 上記＋範囲指定 | 89〜92% |
| SNS 投稿（縁取り付きの大きな縦書き装飾文字） | Tesseract、どの設定でも | 5% 前後 |

Tesseract は書類向けのエンジンなので、写真の中の装飾文字（縁取り・影付き、縦書きと横書きの混在、太い見出しフォント）は苦手です。
