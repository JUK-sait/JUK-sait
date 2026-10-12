import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DriveFs } from '../src/fs.js';
import { DriveSync } from '../src/sync.js';
import { MemoryBackend } from '../src/backends/memory.js';

/** テストごとに使い捨ての作業ディレクトリを用意する。 */
async function makeWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'gdrivefs-sync-'));
  const localRoot = path.join(root, 'local');
  await mkdir(localRoot, { recursive: true });
  return { root, localRoot };
}

describe('DriveSync', () => {
  /** @type {DriveFs} */
  let fs;
  /** @type {string} */
  let root;
  /** @type {string} */
  let localRoot;
  /** @type {DriveSync} */
  let sync;

  beforeEach(async () => {
    fs = new DriveFs({ backend: new MemoryBackend() });
    ({ root, localRoot } = await makeWorkspace());
    sync = new DriveSync({ fs, localRoot, remoteRoot: '/backup' });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('push: ローカルのファイルをアップロードする', async () => {
    await writeFile(path.join(localRoot, 'a.txt'), 'hello');
    await mkdir(path.join(localRoot, 'nested'));
    await writeFile(path.join(localRoot, 'nested', 'b.txt'), 'world');

    const report = await sync.sync({ direction: 'push' });
    assert.equal(report.summary.uploaded, 2);
    assert.equal(await fs.readText('/backup/a.txt'), 'hello');
    assert.equal(await fs.readText('/backup/nested/b.txt'), 'world');

    const manifest = JSON.parse(
      await readFile(path.join(localRoot, '.gdrivefs-manifest.json'), 'utf8'),
    );
    assert.ok(manifest.entries['a.txt']);
    assert.ok(manifest.entries['nested/b.txt']);
  });

  it('2 回目の push では何も起きない', async () => {
    await writeFile(path.join(localRoot, 'a.txt'), 'hello');
    await sync.sync({ direction: 'push' });
    const second = await sync.sync({ direction: 'push' });
    assert.equal(second.summary.planned, 0);
  });

  it('pull: リモートのみのファイルをダウンロードする', async () => {
    await fs.writeFile('/backup/remote.txt', 'from-drive');
    const report = await sync.sync({ direction: 'pull' });
    assert.equal(report.summary.downloaded, 1);
    assert.equal(await readFile(path.join(localRoot, 'remote.txt'), 'utf8'), 'from-drive');
  });

  it('片側だけの変更はその方向に伝播する', async () => {
    await writeFile(path.join(localRoot, 'a.txt'), 'v1');
    await fs.writeFile('/backup/b.txt', 'v1');
    await sync.sync({ direction: 'both' });

    await writeFile(path.join(localRoot, 'a.txt'), 'v2-local');
    await fs.writeFile('/backup/b.txt', 'v2-remote');

    const report = await sync.sync({ direction: 'both' });
    assert.equal(report.summary.uploaded, 1);
    assert.equal(report.summary.downloaded, 1);
    assert.equal(await fs.readText('/backup/a.txt'), 'v2-local');
    assert.equal(await readFile(path.join(localRoot, 'b.txt'), 'utf8'), 'v2-remote');
  });

  it('両側で変更されたら既定では衝突としてスキップする', async () => {
    await writeFile(path.join(localRoot, 'a.txt'), 'v1');
    await sync.sync({ direction: 'push' });
    await writeFile(path.join(localRoot, 'a.txt'), 'local-change');
    await fs.writeFile('/backup/a.txt', 'remote-change');

    const report = await sync.sync({ direction: 'both' });
    assert.equal(report.summary.conflicts, 1);
    assert.equal(report.conflicts[0].relativePath, 'a.txt');
    assert.equal(await fs.readText('/backup/a.txt'), 'remote-change');
    assert.equal(await readFile(path.join(localRoot, 'a.txt'), 'utf8'), 'local-change');
  });

  it('onConflict: local ならローカルで上書きする', async () => {
    await writeFile(path.join(localRoot, 'a.txt'), 'v1');
    await sync.sync({ direction: 'push' });
    await writeFile(path.join(localRoot, 'a.txt'), 'local-change');
    await fs.writeFile('/backup/a.txt', 'remote-change');

    const report = await sync.sync({ direction: 'both', onConflict: 'local' });
    assert.equal(report.summary.uploaded, 1);
    assert.equal(await fs.readText('/backup/a.txt'), 'local-change');
  });

  it('onConflict: remote ならリモートで上書きする', async () => {
    await writeFile(path.join(localRoot, 'a.txt'), 'v1');
    await sync.sync({ direction: 'push' });
    await writeFile(path.join(localRoot, 'a.txt'), 'local-change');
    await fs.writeFile('/backup/a.txt', 'remote-change');

    const report = await sync.sync({ direction: 'both', onConflict: 'remote' });
    assert.equal(report.summary.downloaded, 1);
    assert.equal(await readFile(path.join(localRoot, 'a.txt'), 'utf8'), 'remote-change');
  });

  it('削除は delete オプションを付けたときだけ伝播する', async () => {
    await writeFile(path.join(localRoot, 'a.txt'), 'x');
    await writeFile(path.join(localRoot, 'b.txt'), 'y');
    await sync.sync({ direction: 'both' });

    await fs.rm('/backup/a.txt');
    await rm(path.join(localRoot, 'b.txt'));

    const withoutDelete = await sync.sync({ direction: 'both' });
    assert.equal(withoutDelete.summary.deletedLocal, 0);
    assert.equal(withoutDelete.summary.deletedRemote, 0);
    assert.equal(await readFile(path.join(localRoot, 'a.txt'), 'utf8'), 'x');

    const withDelete = await sync.sync({ direction: 'both', delete: true });
    assert.equal(withDelete.summary.deletedLocal, 1);
    assert.equal(withDelete.summary.deletedRemote, 1);
    await assert.rejects(() => readFile(path.join(localRoot, 'a.txt')));
    assert.equal(await fs.exists('/backup/b.txt'), false);
  });

  it('dry-run は何も変更しない', async () => {
    await writeFile(path.join(localRoot, 'a.txt'), 'x');
    const report = await sync.sync({ direction: 'push', dryRun: true });
    assert.equal(report.dryRun, true);
    assert.equal(report.summary.planned, 1);
    assert.equal(report.summary.uploaded, 0);
    assert.equal(await fs.exists('/backup/a.txt'), false);
  });

  it('マニフェスト無しで両側にある場合は内容比較できる', async () => {
    await writeFile(path.join(localRoot, 'same.txt'), 'identical');
    await fs.writeFile('/backup/same.txt', 'identical');
    const withoutVerify = await sync.sync({ direction: 'both', dryRun: true });
    assert.equal(withoutVerify.summary.conflicts, 1, '既定では判定不能として衝突扱い');

    const withVerify = await sync.sync({
      direction: 'both',
      dryRun: true,
      verifyContent: true,
    });
    assert.equal(withVerify.summary.conflicts, 0);
    assert.equal(withVerify.summary.planned, 0);
  });

  it('除外パターンは同期しない', async () => {
    await mkdir(path.join(localRoot, 'node_modules'));
    await writeFile(path.join(localRoot, 'node_modules', 'x.js'), 'x');
    await writeFile(path.join(localRoot, '.DS_Store'), 'junk');
    await writeFile(path.join(localRoot, 'keep.txt'), 'keep');

    const report = await sync.sync({ direction: 'push' });
    assert.equal(report.summary.uploaded, 1);
    assert.equal(await fs.exists('/backup/node_modules/x.js'), false);
    assert.equal(await fs.exists('/backup/.DS_Store'), false);
  });

  it('status は変更の内訳を返す', async () => {
    await writeFile(path.join(localRoot, 'local-only.txt'), 'a');
    await fs.writeFile('/backup/remote-only.txt', 'b');
    const { summary, changes } = await sync.status();
    assert.equal(summary['local-only'], 1);
    assert.equal(summary['remote-only'], 1);
    assert.equal(changes.length, 2);
  });

  it('サブディレクトリを含むツリーを往復できる', async () => {
    await mkdir(path.join(localRoot, 'x', 'y'), { recursive: true });
    await writeFile(path.join(localRoot, 'x', 'y', 'deep.txt'), 'deep');
    await sync.sync({ direction: 'push' });

    // 別ディレクトリへ復元する (同じマニフェストを使い回すと削除扱いになるため)
    const restoredRoot = path.join(root, 'restored');
    const restoreSync = new DriveSync({ fs, localRoot: restoredRoot, remoteRoot: '/backup' });
    const report = await restoreSync.sync({ direction: 'pull' });
    assert.equal(report.summary.downloaded, 1);
    assert.equal(await readFile(path.join(restoredRoot, 'x/y/deep.txt'), 'utf8'), 'deep');
  });

  it('ローカルで消したファイルは delete 無しでは残す', async () => {
    await mkdir(path.join(localRoot, 'x'), { recursive: true });
    await writeFile(path.join(localRoot, 'x', 'keep.txt'), 'keep');
    await sync.sync({ direction: 'push' });
    await rm(path.join(localRoot, 'x'), { recursive: true });

    const report = await sync.sync({ direction: 'pull' });
    assert.equal(report.summary.skipped, 1);
    assert.equal(await fs.readText('/backup/x/keep.txt'), 'keep');
  });

  it('リモートのフォルダは同期対象にしない (エラーにならない)', async () => {
    await fs.mkdir('/backup/nested');
    await fs.writeFile('/backup/nested/file.txt', 'x');
    await writeFile(path.join(localRoot, 'keep.txt'), 'keep');

    const report = await sync.sync({ direction: 'both' });
    assert.equal(report.summary.errors, 0);
    assert.equal(report.summary.downloaded, 1);
    assert.equal(await readFile(path.join(localRoot, 'nested/file.txt'), 'utf8'), 'x');
    assert.equal((await sync.status()).summary['remote-only'], undefined);
  });

  it('remoteRoot が変わったマニフェストはリセットして警告する', async () => {
    await writeFile(path.join(localRoot, 'a.txt'), 'x');
    await sync.sync({ direction: 'push' });

    const otherSync = new DriveSync({ fs, localRoot, remoteRoot: '/other' });
    const report = await otherSync.sync({ direction: 'both', delete: true });
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /remoteRoot/);
    assert.equal(report.summary.deletedLocal, 0);
    assert.equal(await readFile(path.join(localRoot, 'a.txt'), 'utf8'), 'x');
    assert.equal(await fs.readText('/other/a.txt'), 'x');
  });

  it('マニフェストは同期対象から除外される', async () => {
    await writeFile(path.join(localRoot, 'a.txt'), 'x');
    await sync.sync({ direction: 'push' });
    const files = await readdir(localRoot);
    assert.deepEqual(files.sort(), ['.gdrivefs-manifest.json', 'a.txt']);
    assert.equal(await fs.exists('/backup/.gdrivefs-manifest.json'), false);
  });
});
