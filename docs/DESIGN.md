# 設計ドキュメント

## 1. 何を解決するシステムか

Google Drive の API は **ID ベース**（`files/{fileId}`）で、階層は `parents` の集合として表現される。
そのため素朴に使うと「フォルダ ID を辿る」「同名重複をどう扱うか」「親フォルダが無い」といった
問題がアプリ側に漏れ出す。

gdrivefs はその差分を 1 か所（`DriveFs`）に閉じ込め、利用者には **パスベースのファイル API**
だけを見せる。Google Drive 固有の制約は「意味論の差異」として明示的に扱う（後述 §5）。

## 2. レイヤ構成

```
┌─────────────────────────────────────────────────────────────┐
│ CLI (src/cli.js, bin/gdrivefs.js)                            │
│   ls / cat / put / get / rm / mv / cp / find / du / tree /   │
│   mkdir / sync / about + --json 出力                          │
├─────────────────────────────────────────────────────────────┤
│ 高レベル API (src/fs.js: DriveFs)                            │
│   パス解決・親フォルダ自動生成・上書き規則・再帰削除・       │
│   walk/find/tree/du・パス単位ロック・解決結果キャッシュ      │
├─────────────────────────────────────────────────────────────┤
│ 同期 (src/sync.js: DriveSync)                                │
│   ローカル走査・マニフェスト差分・衝突検出・双方向ミラー      │
├─────────────────────────────────────────────────────────────┤
│ バックエンド抽象 (src/backends/base.js: DriveBackend)        │
│   rootId/getNode/listChildren/createFile/updateFile/         │
│   deleteNode/download + trashNode/findChild/about (任意)     │
├──────────────────────────┬──────────────────────────────────┤
│ GoogleDriveBackend       │ MemoryBackend                     │
│  REST v3 を fetch で直接  │  テスト/オフライン用              │
│  リトライ・401 再取得     │  永続化 (--memory-file) 対応      │
├──────────────────────────┴──────────────────────────────────┤
│ 共通部品: errors / path / mime / bytes / util / auth          │
└─────────────────────────────────────────────────────────────┘
```

依存ゼロ（`fetch`, `node:crypto`, `node:fs` のみ）。`googleapis` パッケージは不要。

## 3. 主要な設計判断

### 3-1. バックエンドを差し替え可能にする

`DriveBackend` は「ID ベースのプリミティブ」だけを要求し、パス解決や上書き規則は上位層が持つ。
これにより

- 実 Drive なしで全ロジックをテストできる（CI がネットワーク不要）
- 共有ドライブやプロキシなど API の差異をバックエンド側に閉じ込められる
- 将来のローカル FS 実装や S3 実装を同じ API で足せる

### 3-2. パス解決は「親フォルダの子リスト」キャッシュ

Google Drive にはパス一括解決 API が無いため、gdrivefs は **親フォルダ ID ごとに子の
`名前 → ノード` 表**を TTL 付き（既定 30 秒、`cacheTtlMs`）でキャッシュする（`_childrenOf`）。

- パス `/a/b/c.txt` の解決は「子リストを名前で引く」操作 3 回。コールドキャッシュ時は
  ディレクトリ数分（= 3 リクエスト）、TTL 内の再解決は **0 リクエスト**
- 子リストは `trashed = false` のみを含むため、ゴミ箱入りのフォルダは「存在しない」と判定される
- 同名が複数ある場合は最初の 1 件を採用する（§5）
- **書き込み系（writeFile / mkdir / mv / rm / cp / appendFile）は `fresh: true`** で
  キャッシュを迂回し、常に最新の一覧で解決する。これにより「外部でリネームされた古いパスへ
  書き込むと移動先に紛れ込む」事故を防ぐ
- 読み取り系（`stat` / `exists` / `list`）は TTL 内のキャッシュを使うため、外部変更は
  最大 `cacheTtlMs` 遅れて見える。厳密性が必要なら `cacheTtlMs: 0` を指定する
- キャッシュは `maxCacheEntries`（既定 5000）で古い順に破棄される

`listChildren` は Google バックエンドでは `q = 'parent' in parents and trashed = false` の
1 リクエストに落ちる（`fields` で必要項目のみ取得）。

### 3-3. 上書き規則は「upsert」

`writeFile` は既定で **同名があれば内容を更新**（`files.update`）、無ければ作成（`files.create`）。
POSIX の `open(O_CREAT|O_TRUNC)` に近い。厳密な「新規のみ」が必要な場合は `overwrite: false`。

空文字での上書き（切り詰め）は、Google バックエンドでは **空の media パートを含む multipart** で送る
（`emptyUploadStrategy: 'multipart'`、既定）。Drive が空 media を拒否する環境では
`emptyUploadStrategy: 'metadata-only'` にすると本文を送らない従来動作に戻せる。
既存ファイルが Google ネイティブ形式 (Docs/Sheets 等) の場合、`mimeType` は呼び出し側が
明示しない限り送らない（勝手に形式を変えないため）。

### 3-4. 同一パスへの同時実行はプロセス内で直列化

`_withLock` は **パスをキー** にして、ファイル書き込みとフォルダ作成を同じロックで直列化する。
これにより

- 同じ新規フォルダへの並行書き込みで Drive 上に同名フォルダが量産されない
- 同じ名前でファイル作成とフォルダ作成が並行しても、後勝ちの片方だけが残る
  （もう片方は `EISDIR` / `ENOTDIR`）

（複数プロセス/マシン間の排他は行わない。§5 参照。）

### 3-5. リトライとレート制限

- 429 / 5xx / ネットワーク例外 → 指数バックオフ（base 400ms、最大 30s、ジッタ付き）で最大 4 回
- 200 応答でも本文が JSON でない場合（プロキシの HTML 等）は `ApiError` にして原因を明示
- `Retry-After` ヘッダがあればそちらを優先
- 401 → `tokenProvider.invalidate()` して **1 度だけ** 再試行（無効トークンで往復しない）
- 403 など恒久エラーは即座に `ApiError`（`status` / `reason` / `retryable` 付き）

### 3-6. 同期はマニフェスト方式

マニフェストには `remoteRoot` を記録し、**指定が変わっていたら差分情報をリセットする**。
別のリモートを指すマニフェストを流用すると「リモートで削除された」と誤判定して
ローカルを消してしまうため、安全側に倒して警告 (`report.warnings`) を返す。

`.gdrivefs-manifest.json` に「前回同期時のローカルハッシュ（sha256）とリモート指紋」を保存し、
3 者比較（前回 / 現在ローカル / 現在リモート）で

| 状態 | 既定の動作 |
| --- | --- |
| ローカルのみ | アップロード |
| リモートのみ | ダウンロード |
| ローカルで変更 | アップロード |
| リモートで変更 | ダウンロード |
| 両方で変更 | **衝突**（`--conflict skip` でスキップ、`local`/`remote`/`newest` で解決） |
| リモートで削除 | `--delete` 指定時のみローカル削除 |
| ローカルで削除 | `--delete` 指定時のみリモート削除 |

同期対象は **ファイルのみ**（フォルダはパスから自動作成される）。
リモート指紋は `md5Checksum`（Drive が返す）を優先し、無ければ `modifiedTime` + `size`。
マニフェストが無く両側に存在する場合は判定不能なので衝突扱いにする
（`--verify-content` を付けると内容ハッシュ比較で同一判定できる）。

## 4. 公開 API の要約

```js
// 生成
createDriveFs({ rootFolderId, sharedDriveId, env, fetchImpl })
createBackend({ ... })                       // バックエンドだけ
new DriveFs({ backend, cacheTtlMs })

// 読み取り
await fs.stat(path) / exists(path) / list(path, {recursive}) / readFile(path)
await fs.readText(path) / readJson(path) / isTextFile(path)
for await (const {path, node} of fs.walk(path)) { }
await fs.find(path, {name, pattern, type}) / du(path) / tree(path, {maxDepth})

// 書き込み
await fs.mkdir(path)
await fs.writeFile(path, data, {overwrite, mimeType, createParents})
await fs.writeJson(path, value) / appendFile(path, data) / touch(path)
await fs.rm(path, {recursive, force, permanently})
await fs.mv(from, to, {overwrite}) / cp(from, to, {recursive, overwrite})

// 同期
new DriveSync({ fs, localRoot, remoteRoot, manifestPath, excludes, concurrency })
await sync.status() / compare({verifyContent}) / sync({direction, dryRun, delete, onConflict})
```

## 5. 境界と既知の制約

Drive は POSIX ファイルシステムではない。以下は **意図的にサポートしない / 制約として明示する**。

| 項目 | 状況 |
| --- | --- |
| 権限・共有 (ACL) | 扱わない。`permissions` API は未実装。必要なら `GoogleDriveBackend` を拡張 |
| 原子的 rename | Drive の更新は結果整合であり、`mv` は「追加 + 親解除」の 2 段階。完全な原子性は保証しない |
| 同名重複 | Drive は同名を許す。パス解決は **最初に見つかった 1 件** を返す。重複は `list()` で検出可能 |
| ショートカット | `shortcutDetails` は取得するが、解決は自動では追跡しない |
| Google ネイティブ形式 | ダウンロードはエクスポート（既定は Office 形式 / PDF）。書き込みはメタデータ作成のみ（内容は Drive 側で編集） |
| 巨大ファイル | `Buffer` を丸ごとメモリに載せる。数百 MB 超は分割アップロード（resumable）未実装 |
| 変更監視 | `changes` API / push 通知は未実装。ポーリング（`status()`）で代替 |
| リビジョン | `revisions` API 未対応。世代管理は同期マニフェストに一本化 |
| プロセス間ロック | 同一パスへの同時実行はプロセス内でのみ直列化。複数プロセス/マシンからの同時書き込みは Drive 側の挙動に従う |
| 自己参照の移動/コピー | `mv`/`cp` はフォルダを自分の配下へ入れる操作を `EINVALIDPATH` で拒否する |
| キャッシュ | 子リストキャッシュは TTL 内の外部変更（削除/リネーム/ゴミ箱）を見ない。読み取りは最大 `cacheTtlMs` 遅れる（書き込みは常に fresh）。`cacheTtlMs: 0` で無効化、`maxCacheEntries`（既定 5000）で上限管理 |
| 同期の削除 | `sync --delete` のリモート削除は **完全削除**（ゴミ箱を経由しない）。取り消せないため `--dry-run` での確認を推奨 |
| 同期の検出粒度 | マニフェストのハッシュはスキャン時点の値。スキャン〜転送中の変更は次回同期まで検出されない |
| マニフェストの同一性 | `remoteRoot` と `rootId`（ルートフォルダ ID）を記録し、どちらかが変わったら差分をリセットして警告する |
| レート制限 | 1 ユーザあたり約 12,000 リクエスト/分。`concurrency` で並列度を調整可能 |
| シンボリックリンク | 概念が無い。`cp -r` 相当は実体コピー |
| パス長 | 1 セグメント UTF-8 255 バイト、深さ 100 段まで（`src/path.js` で検証） |

## 6. テスト戦略

| 対象 | 方法 |
| --- | --- |
| パス・MIME・エラー | 純関数の単体テスト |
| `DriveFs` | `MemoryBackend` で読み書き・削除・移動・検索・ツリーを検証 |
| `DriveSync` | 一時ディレクトリ + `MemoryBackend`。push/pull/衝突/削除伝播/dry-run |
| `GoogleDriveBackend` | `fetchImpl` をモックし、URL・クエリ・multipart ボディ・リトライ・401 再取得を検証 |
| 認証 | JWT を実際に生成して `crypto.verify` で検証。トークンキャッシュも検証 |
| CLI | `main(argv, io)` にフェイク stdout/stdin を注入し、終了コードと出力を検証 |

実 Drive に対する結合確認は `examples/live-check.mjs`（クレデンシャルがある場合のみ）で行う。

## 7. 今後の拡張候補

1. resumable upload / ストリーム入出力（大容量対応）
2. `permissions` による共有操作（`fs.chmod` 相当）
3. `changes` API を使った差分同期（マニフェスト走査の高速化）
4. 部分同期のフィルタ（glob による include/exclude）
5. TypeScript 型定義 (`.d.ts`) の同梱
