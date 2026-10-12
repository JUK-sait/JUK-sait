/**
 * 実 Google Drive に対する疎通確認スクリプト。
 *
 *   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... GOOGLE_OAUTH_REFRESH_TOKEN=... \
 *   GOOGLE_DRIVE_ROOT_FOLDER_ID=... node examples/live-check.mjs [リモートのルートパス]
 *
 * 実行内容:
 *   1. about() でアカウントと容量を表示
 *   2. `<root>/gdrivefs-live-check` を作成
 *   3. テキスト / JSON / バイナリを書き込み、読み戻して内容を検証
 *   4. 一覧・検索・サイズ集計
 *   5. 後始末（削除）
 */

import { createDriveFs, formatBytes } from '../src/index.js';

const base = process.argv[2] ?? '/gdrivefs-live-check';
const fs = createDriveFs({});

const log = (...args) => console.log(...args);
let failures = 0;

/** 期待値と比較して結果を表示する。 */
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : ` (actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)})`}`);
}

const info = await fs.backend.about();
log(`ユーザ: ${info?.user?.emailAddress ?? '不明'}`);
if (info?.storageQuota) {
  log(
    `使用量: ${formatBytes(info.storageQuota.usage)} / ${
      Number(info.storageQuota.limit) > 0 ? formatBytes(info.storageQuota.limit) : '無制限'
    }`,
  );
}

try {
  await fs.mkdir(`${base}/nested/deep`);
  const text = `hello at ${new Date().toISOString()}\n`;
  await fs.writeFile(`${base}/nested/hello.txt`, text);
  await fs.writeJson(`${base}/nested/deep/config.json`, { ok: true, count: 3 });
  await fs.writeFile(`${base}/nested/deep/blob.bin`, Buffer.from([0, 1, 2, 3, 255]));

  check('テキストが一致する', await fs.readText(`${base}/nested/hello.txt`), text);
  check('JSON が一致する', await fs.readJson(`${base}/nested/deep/config.json`), {
    ok: true,
    count: 3,
  });
  check(
    'バイナリが一致する',
    [...(await fs.readFile(`${base}/nested/deep/blob.bin`))],
    [0, 1, 2, 3, 255],
  );

  const listed = (await fs.list(`${base}/nested`)).map((n) => n.name);
  log(`一覧: ${listed.join(', ')}`);
  check('一覧に hello.txt が含まれる', listed.includes('hello.txt'), true);

  const found = (await fs.find(base, { pattern: /\.json$/ })).map((n) => n.path);
  check('find で config.json が見つかる', found.length, 1);

  const usage = await fs.du(base);
  log(`du: ${usage.files} ファイル / ${usage.folders} フォルダ / ${formatBytes(usage.bytes)}`);

  const stat = await fs.stat(`${base}/nested/hello.txt`);
  log(`URL: ${stat.webViewLink ?? '(なし)'}`);
} finally {
  const removed = await fs.rm(base, { recursive: true, force: true });
  log(removed ? `後始末: ${base} を削除しました` : `後始末: ${base} は存在しませんでした`);
}

if (failures > 0) {
  console.error(`\n${failures} 件の検証に失敗しました`);
  process.exitCode = 1;
} else {
  log('\nすべての検証に成功しました');
}
