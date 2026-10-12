import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryBackend, toBuffer } from '../src/backends/memory.js';
import { dedupeName } from '../src/backends/base.js';
import { ApiError } from '../src/errors.js';
import { FOLDER_MIME } from '../src/mime.js';

describe('MemoryBackend', () => {
  it('フォルダとファイルを作成して列挙できる', async () => {
    const backend = new MemoryBackend();
    const root = backend.rootId();
    const folder = await backend.createFolder({ name: 'docs', parentId: root });
    await backend.createFile({ name: 'a.txt', parentId: folder.id, content: 'hello' });
    const { nodes } = await backend.listChildren(folder.id);
    assert.deepEqual(
      nodes.map((n) => n.name),
      ['a.txt'],
    );
    assert.equal(folder.mimeType, FOLDER_MIME);
  });

  it('同名ファイルの重複を許す (Drive と同じ)', async () => {
    const backend = new MemoryBackend();
    const root = backend.rootId();
    await backend.createFile({ name: 'same.txt', parentId: root, content: '1' });
    await backend.createFile({ name: 'same.txt', parentId: root, content: '2' });
    const { nodes } = await backend.listChildren(root);
    assert.equal(nodes.length, 2);
  });

  it('unusedName は連番を付ける', async () => {
    const backend = new MemoryBackend();
    const root = backend.rootId();
    await backend.createFile({ name: 'report.txt', parentId: root, content: 'x' });
    assert.equal(await backend.unusedName(root, 'report.txt'), 'report (1).txt');
    assert.equal(await backend.unusedName(root, 'other.txt'), 'other.txt');
  });

  it('ページングできる', async () => {
    const backend = new MemoryBackend();
    const root = backend.rootId();
    for (let i = 0; i < 5; i += 1) {
      await backend.createFile({ name: `f${i}.txt`, parentId: root, content: 'x' });
    }
    const page1 = await backend.listChildren(root, { pageSize: 2 });
    assert.equal(page1.nodes.length, 2);
    assert.ok(page1.nextPageToken);
    const all = await backend.listAllChildren(root);
    assert.equal(all.length, 5);
  });

  it('trash は子孫もまとめてゴミ箱へ入れる', async () => {
    const backend = new MemoryBackend();
    const root = backend.rootId();
    const folder = await backend.createFolder({ name: 'dir', parentId: root });
    const file = await backend.createFile({ name: 'f.txt', parentId: folder.id, content: 'x' });
    await backend.trashNode(folder.id);
    assert.equal(await backend.getNode(folder.id), null);
    assert.equal(await backend.getNode(file.id), null);
    assert.ok(backend.nodes.get(file.id).trashed);
  });

  it('deleteNode は木ごと消す', async () => {
    const backend = new MemoryBackend();
    const root = backend.rootId();
    const folder = await backend.createFolder({ name: 'dir', parentId: root });
    const file = await backend.createFile({ name: 'f.txt', parentId: folder.id, content: 'x' });
    await backend.deleteNode(folder.id);
    assert.equal(backend.nodes.has(folder.id), false);
    assert.equal(backend.nodes.has(file.id), false);
    assert.equal(backend.blobs.has(file.id), false);
  });

  it('Google ネイティブ形式はエクスポート相当を返す', async () => {
    const backend = new MemoryBackend();
    const root = backend.rootId();
    const doc = await backend.createFile({
      name: 'memo',
      parentId: root,
      mimeType: 'application/vnd.google-apps.document',
    });
    const exported = await backend.download(doc.id);
    assert.match(exported.toString('utf8'), /exported/);
  });

  it('failNext で擬似的な失敗を注入できる', async () => {
    const backend = new MemoryBackend();
    backend.failNext('listChildren', { times: 1, status: 503 });
    await assert.rejects(() => backend.listChildren(backend.rootId()), ApiError);
    const result = await backend.listChildren(backend.rootId());
    assert.deepEqual(result.nodes, []);
  });

  it('snapshot / restore で状態を戻せる', async () => {
    const backend = new MemoryBackend();
    const root = backend.rootId();
    await backend.createFile({ name: 'a.txt', parentId: root, content: 'v1' });
    const snapshot = backend.snapshot();
    await backend.createFile({ name: 'b.txt', parentId: root, content: 'v2' });
    assert.equal((await backend.listAllChildren(root)).length, 2);
    backend.restore(snapshot);
    assert.equal((await backend.listAllChildren(root)).length, 1);
  });

  it('toSerializable / fromSerializable で往復できる', async () => {
    const backend = new MemoryBackend();
    const root = backend.rootId();
    const folder = await backend.createFolder({ name: 'dir', parentId: root });
    const file = await backend.createFile({
      name: 'a.bin',
      parentId: folder.id,
      content: Buffer.from([1, 2, 3]),
    });
    const restored = MemoryBackend.fromSerializable(
      JSON.parse(backend.serialize()),
    );
    assert.equal(restored.rootId(), root);
    const node = await restored.getNode(file.id);
    assert.equal(node.name, 'a.bin');
    assert.deepEqual(await restored.download(file.id), Buffer.from([1, 2, 3]));
    // 復元後も新規 ID が衝突しない
    const created = await restored.createFile({ name: 'new.txt', parentId: root, content: 'x' });
    assert.equal(restored.nodes.has(created.id), true);
  });

  it('toBuffer は文字列/バイト列を扱い、他は拒否する', () => {
    assert.deepEqual(toBuffer('abc'), Buffer.from('abc'));
    assert.deepEqual(toBuffer(new Uint8Array([1])), Buffer.from([1]));
    assert.equal(toBuffer(null), null);
    assert.throws(() => toBuffer(123));
  });

  it('dedupeName は連番を返す', () => {
    const taken = new Set(['a.txt', 'a (1).txt']);
    assert.equal(dedupeName((n) => taken.has(n), 'a.txt'), 'a (2).txt');
    assert.equal(dedupeName((n) => taken.has(n), 'b.txt'), 'b.txt');
  });
});
