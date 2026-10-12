/**
 * 認証不要のサンプル: インメモリバックエンドで DriveFs の API を一通り試す。
 *
 *   node examples/quickstart.mjs
 */

import { DriveFs, MemoryBackend, formatBytes } from '../src/index.js';

const fs = new DriveFs({ backend: new MemoryBackend() });

// 書き込み（親フォルダは自動作成）
await fs.mkdir('/projects/app');
await fs.writeFile('/projects/app/README.md', '# サンプル\n');
await fs.writeJson('/projects/app/config.json', { port: 8080, debug: false });
await fs.appendFile('/projects/app/README.md', '\n追記しました\n');

// 読み出し
console.log('--- cat /projects/app/README.md');
console.log(await fs.readText('/projects/app/README.md'));
console.log('--- json');
console.log(await fs.readJson('/projects/app/config.json'));

// 一覧とツリー
console.log('--- ls /projects/app --long');
for (const node of await fs.list('/projects/app')) {
  const type = node.mimeType === 'application/vnd.google-apps.folder' ? 'dir ' : 'file';
  console.log(`  ${type} ${String(formatBytes(node.size ?? 0)).padStart(9)}  ${node.name}`);
}
console.log('--- tree');
console.log(JSON.stringify(await fs.tree('/', { maxDepth: 4 }), null, 2));

// 検索とサイズ集計
console.log('--- find *.json');
console.log((await fs.find('/', { pattern: /\.json$/ })).map((n) => n.path));
console.log('--- du /projects');
console.log(await fs.du('/projects'));

// 移動・コピー・削除
await fs.mv('/projects/app/config.json', '/projects/app/config.prod.json');
await fs.cp('/projects/app', '/backups/app');
console.log('--- /backups/app の中身');
console.log((await fs.list('/backups/app')).map((n) => n.name));
await fs.rm('/backups', { recursive: true });
console.log('削除後の /backups 存在チェック:', await fs.exists('/backups'));
