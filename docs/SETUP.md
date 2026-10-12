# セットアップ — 認証情報の取得と設定

gdrivefs は 3 通りの認証をサポートします。用途に応じて選んでください。

| 方式 | 向いている場面 | 必要なもの |
| --- | --- | --- |
| OAuth2 リフレッシュトークン | 個人アカウントの Drive を扱う通常のサーバ/CLI | client id / secret / refresh token |
| サービスアカウント | サーバ間連携、共有ドライブ、CI | サービスアカウント JSON |
| 静的アクセストークン | 短命な検証、他システムから受け渡す場合 | `GOOGLE_DRIVE_ACCESS_TOKEN` |

---

## 1. Google Cloud プロジェクトの準備（共通）

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. 「API とサービス → ライブラリ」から **Google Drive API** を有効化
3. 「API とサービス → OAuth 同意画面」を設定（外部 / テストユーザーに自分のアカウントを追加）

---

## 2. OAuth2 リフレッシュトークン方式（推奨）

### 2-1. OAuth クライアントを作る

1. 「API とサービス → 認証情報 → 認証情報を作成 → OAuth クライアント ID」
2. アプリケーションの種類: **デスクトップ アプリ**
3. 表示された `client_id` と `client_secret` を控える

### 2-2. リフレッシュトークンを取得する

ローカルで一度だけ、以下のスクリプトを実行します（このリポジトリの `examples/get-refresh-token.mjs` を使うと楽です）。

```bash
GOOGLE_OAUTH_CLIENT_ID=xxx GOOGLE_OAUTH_CLIENT_SECRET=yyy \
  node examples/get-refresh-token.mjs
```

手動で行う場合:

1. ブラウザで次を開く（`CLIENT_ID` を置換、`redirect_uri` はデスクトップアプリの `http://localhost`）

   ```
   https://accounts.google.com/o/oauth2/v2/auth?client_id=CLIENT_ID&redirect_uri=http://localhost&response_type=code&scope=https://www.googleapis.com/auth/drive&access_type=offline&prompt=consent
   ```

2. 表示された `code` を次のコマンドで交換

   ```bash
   curl -s -X POST https://oauth2.googleapis.com/token \
     -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET \
     -d code=CODE -d grant_type=authorization_code -d redirect_uri=http://localhost
   ```

3. 応答の `refresh_token` を保存（**この値は再発行されません**）

### 2-3. 環境変数を設定

```bash
export GOOGLE_OAUTH_CLIENT_ID=xxx
export GOOGLE_OAUTH_CLIENT_SECRET=yyy
export GOOGLE_OAUTH_REFRESH_TOKEN=zzz
export GOOGLE_DRIVE_ROOT_FOLDER_ID=1AbCdEfGhIjKlMnOpQrStUvWxYz   # 任意。未指定ならマイドライブ直下
```

`GOOGLE_DRIVE_ROOT_FOLDER_ID` は Drive の URL
`https://drive.google.com/drive/folders/`**`<この部分>`** です。指定したフォルダが `/` になります。

---

## 3. サービスアカウント方式（共有ドライブ / CI 向け）

### 3-1. サービスアカウントを作る

1. 「IAM と管理 → サービス アカウント → 作成」
2. 作成後、「キー → 鍵を追加 → 新しい鍵を作成 → JSON」でダウンロード
3. その JSON の `client_email` を控える（例: `gdrivefs@project.iam.gserviceaccount.com`）

### 3-2. Drive 側で共有する

- **マイドライブ**の場合: 対象フォルダを右クリック → 共有 → `client_email` を **編集者** で追加
- **共有ドライブ**の場合: 共有ドライブのメンバーに `client_email` を追加し、
  `GOOGLE_SHARED_DRIVE_ID` に共有ドライブ ID（URL の `/drive/folders/<id>` 部分）を指定

> サービスアカウントは自分の「マイドライブ」を直接持てません。
> 必ずフォルダを共有するか、共有ドライブを使ってください。

```bash
export GOOGLE_SERVICE_ACCOUNT_FILE=/secure/sa.json
export GOOGLE_SHARED_DRIVE_ID=0ABCDefghIJKLmnop     # 共有ドライブを使う場合
# ドメイン全体の委任を使う場合は代理ユーザを指定できる
export GOOGLE_IMPERSONATE_SUBJECT=user@example.com
```

---

## 4. 静的アクセストークン方式（検証用）

```bash
export GOOGLE_DRIVE_ACCESS_TOKEN=$(gcloud auth print-access-token)
gdrivefs about
```

有効期限は約 1 時間です。`GOOGLE_DRIVE_ACCESS_TOKEN_EXPIRES_AT`（UNIX 秒）を指定すると
期限切れ前に自動で再取得を試みますが、通常は上記 2 か 3 の方式を推奨します。

---

## 5. 動作確認

```bash
# 1. 認証が通るか
gdrivefs about

# 2. 書き込み → 読み出し → 削除
gdrivefs mkdir /gdrivefs-check
echo "hello $(date)" | gdrivefs put - /gdrivefs-check/hello.txt
gdrivefs cat /gdrivefs-check/hello.txt
gdrivefs stat /gdrivefs-check/hello.txt
gdrivefs rm -r /gdrivefs-check

# 3. 同期のドライラン
gdrivefs sync ./examples /gdrivefs-sync-check --dry-run
```

スクリプトで一括確認する場合:

```bash
GOOGLE_DRIVE_ROOT_FOLDER_ID=... node examples/live-check.mjs
```

---

## 6. 環境変数一覧

| 変数 | 用途 |
| --- | --- |
| `GOOGLE_DRIVE_ACCESS_TOKEN` | 静的アクセストークン（最優先） |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` | OAuth2 |
| `GOOGLE_SERVICE_ACCOUNT_FILE` / `GOOGLE_SERVICE_ACCOUNT_JSON` | サービスアカウント JSON（パスまたは中身） |
| `GOOGLE_IMPERSONATE_SUBJECT` | サービスアカウントの代理ユーザ |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | `/` に対応させるフォルダ ID |
| `GOOGLE_SHARED_DRIVE_ID` | 共有ドライブ ID |
| `GOOGLE_DRIVE_API_BASE` | API のベース URL（プロキシ経由のとき） |
| `GDRIVEFS_MEMORY` | `1` でインメモリ実装を使う |
| `GDRIVEFS_MEMORY_FILE` | インメモリ実装の状態を保存する JSON ファイル |

`.env.example` に雛形があります。

---

## 7. トラブルシューティング

| 症状 | 原因と対処 |
| --- | --- |
| `EAUTH: 認証情報が見つかりません` | 環境変数が未設定。`gdrivefs --memory` で代替動作は可能 |
| `403 insufficientPermissions` | フォルダが共有されていない。`client_email` に編集権限を付与 |
| `404 File not found` | `GOOGLE_DRIVE_ROOT_FOLDER_ID` が誤り、または権限なし |
| `403 rateLimitExceeded` が続く | gdrivefs は自動リトライします。並列度を下げる（`--concurrency`）と改善 |
| 共有ドライブで何も見えない | `GOOGLE_SHARED_DRIVE_ID` を設定（未指定だとマイドライブを見ます） |
| `invalid_grant` | リフレッシュトークン失効。2-2 を再実行 |
