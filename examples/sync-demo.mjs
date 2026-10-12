/**
 * 同期のサンプル（認証不要）。
 *
 *   node examples/sync-demo.mjs
 *
 * 一時ディレクトリにローカル側を作り、インメモリの Drive とミラーする。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DriveFs, DriveSync, MemoryBackend } from '../src/index.js';

const fs = new DriveFs({ backend: new MemoryBackend() });
const localRoot = await mkdtemp(path.join(tmpdir(), 'gdrivefs-demo-'));

// ローカル側を用意
await mkdir(path.join(localRoot, 'reports'), { recursive: true });
await writeFile(path.join(localRoot, 'reports', '2024-q1.csv'), 'month,sales\n1,100\n');
await writeFile(path.join(localRoot, 'notes.txt'), 'メモ\n');

const sync = new DriveSync({ fs, localRoot, remoteRoot: '/mirror' });

// 1. 何が起きるかを確認（dry-run）
console.log('--- dry-run');
console.log(await sync.sync({ dryRun: true }));

// 2. 実行
console.log('--- 実行');
console.log((await sync.sync({ direction: 'push' })).summary);

// 3. リモート側だけを変更して pull する
await fs.writeFile('/mirror/remote-only.txt', 'Drive 側で作られたファイル');
console.log('--- pull');
console.log((await sync.sync({ direction: 'pull' })).summary);
console.log('ローカルに降りてきたファイル:', (await fs.list('/mirror')).map((n) => n.name));

// 4. 差分が無いことを確認
console.log('--- 差分確認');
console.log((await sync.status()).summary);

await rm(localRoot, { recursive: true, force: true });
