# gdrivefs — Google Drive をファイルシステムとして読み書きするシステム

Google Drive のフォルダを **`/projects/app/config.json` のようなパスで読み書き**できる
Node.js ライブラリ + CLI です。依存パッケージはゼロ（`fetch` と `node:crypto` のみ）。

```
gdrivefs put ./dist /deploy/web --json      # アップロード
gdrivefs cat /deploy/web/index.html         # 読み出し
gdrivefs sync ./data /backup --delete       # 双方向ミラー
```

## 特徴

| 機能 | 説明 |
| --- | --- |
| パスベース API | ルートフォルダ配下を POSIX 風パス (`/a/b.txt`) で扱う。親フォルダは自動作成 |
| 読み書き | `readFile` / `writeFile` / `appendFile` / `mkdir` / `rm` / `mv` / `cp` / `tree` / `find` / `du` |
| 双方向同期 | ローカルディレクトリと Drive をマニフェスト差分でミラー（削除・衝突検出つき） |
| 認証 3 方式 | OAuth2 リフレッシュトークン / サービスアカウント (JWT RS256) / 静的アクセストークン |
| 共有ドライブ | `sharedDriveId` で corpora=drive に対応 |
| 耐障害性 | 429/5xx を指数バックオフで再試行、401 はトークン再取得、`Retry-After` 尊重 |
| Google ネイティブ形式 | Docs/Sheets/Slides は自動でエクスポートして取得 |
| 差し替え可能なバックエンド | 実 Drive 実装とインメモリ実装。**認証なしで全テストが動く** |

## インストール

```bash
git clone https://github.com/JUK-sait/JUK-sait.git gdrivefs
cd gdrivefs
npm test          # 認証不要。129 件のテストが走ります
npm link          # `gdrivefs` コマンドを PATH に入れる場合
```

## クイックスタート（オフライン）

```bash
# 認証なしで CLI の挙動を確認（状態はファイルに保存される）
gdrivefs --memory --memory-file /tmp/drive.json mkdir /demo
gdrivefs --memory --memory-file /tmp/drive.json put README.md /demo/
gdrivefs --memory --memory-file /tmp/drive.json ls /demo --long
```

## クイックスタート（実 Drive）

```bash
export GOOGLE_OAUTH_CLIENT_ID=...
export GOOGLE_OAUTH_CLIENT_SECRET=...
export GOOGLE_OAUTH_REFRESH_TOKEN=...
export GOOGLE_DRIVE_ROOT_FOLDER_ID=1AbCdEf...   # このフォルダが `/` になる

gdrivefs about
gdrivefs mkdir /logs
echo hello | gdrivefs put - /logs/hello.txt
gdrivefs cat /logs/hello.txt
```

認証情報の作り方は [docs/SETUP.md](docs/SETUP.md) を参照してください。

## ライブラリとして使う

```js
import { createDriveFs } from 'gdrivefs';

const fs = createDriveFs({ rootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID });

await fs.mkdir('/reports/2024');
await fs.writeJson('/reports/2024/summary.json', { ok: true });
console.log(await fs.readJson('/reports/2024/summary.json'));

for await (const { path, node } of fs.walk('/reports')) {
  console.log(path, node.size ?? '-');
}
```

テストやオフライン開発ではインメモリバックエンドを使います。

```js
import { DriveFs, MemoryBackend } from 'gdrivefs';

const fs = new DriveFs({ backend: new MemoryBackend() });
await fs.writeFile('/a/b.txt', 'hello');
```

## 同期

```js
import { createDriveFs, DriveSync } from 'gdrivefs';

const fs = createDriveFs();
const sync = new DriveSync({ fs, localRoot: './data', remoteRoot: '/backup' });

console.log(await sync.status());                        // 差分の内訳
await sync.sync({ dryRun: true });                       // 何が起きるか確認
await sync.sync({ direction: 'both', delete: true });    // 実行
```

CLI からも同じことができます。

```bash
gdrivefs sync ./data /backup --dry-run --json
gdrivefs sync ./data /backup --direction push --delete
gdrivefs sync /backup ./data --direction pull --conflict remote
```

> `--delete` のリモート削除は **完全削除**（ゴミ箱を経由しません）。
> まず `--dry-run` で実行内容を確認することを推奨します。

## CLI コマンド一覧

| コマンド | 内容 |
| --- | --- |
| `ls [path...]` | 一覧 (`--long`, `--recursive`, `--json`) |
| `tree [path]` | ツリー表示 (`--depth N`) |
| `cat <path>` | 内容を標準出力 (`--binary` で生バイト) |
| `stat <path>` | メタデータ |
| `find <path>` | 再帰検索 (`--name`, `--pattern`, `--type file\|folder`) |
| `du <path>` | 合計サイズ |
| `mkdir <path...>` | フォルダ作成（親も自動作成） |
| `put <local...> <remote>` | アップロード（ディレクトリは再帰、`-` で標準入力） |
| `get <remote...> [local]` | ダウンロード（フォルダは再帰） |
| `rm <path...>` | 削除 (`-r`, `-f`, `--trash` でゴミ箱へ) |
| `mv <src> <dst>` / `cp <src> <dst>` | 移動 / コピー |
| `sync <local> <remote>` | 双方向ミラー |
| `about` | 認証ユーザと容量 |

共通オプション: `--root <folderId>` / `--shared-drive <id>` / `--memory` / `--json` / `--quiet` / `--api-base <url>`

## ドキュメント

- [docs/SETUP.md](docs/SETUP.md) — 認証情報の取得手順（OAuth2 / サービスアカウント / 共有ドライブ）
- [docs/DESIGN.md](docs/DESIGN.md) — アーキテクチャ、API 仕様、Drive 固有の制約と設計判断
- [examples/](examples/) — 実行可能なサンプル（オフライン版と実 Drive 版）

## テスト

```bash
npm test              # node:test による 129 件
npm run lint          # 全ファイルの構文チェック
npm run test:coverage
```

ネットワークもクレデンシャルも不要です（実 Drive バックエンドは `fetch` をモックして検証）。

## ライセンス

MIT
