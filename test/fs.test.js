import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { DriveFs } from '../src/fs.js';
import { MemoryBackend } from '../src/backends/memory.js';
import {
  AlreadyExistsError,
  InvalidPathError,
  NotADirectoryError,
  NotAFileError,
  NotFoundError,
  NotEmptyError,
} from '../src/errors.js';

/** @returns {DriveFs} */
function makeFs() {
  return new DriveFs({ backend: new MemoryBackend() });
}

describe('DriveFs 基本操作', () => {
  /** @type {DriveFs} */
  let fs;
  beforeEach(() => {
    fs = makeFs();
  });

  it('書き込んだ内容をそのまま読み戻せる', async () => {
    const node = await fs.writeFile('/hello.txt', 'こんにちは');
    assert.equal(node.path, '/hello.txt');
    assert.equal(await fs.readText('/hello.txt'), 'こんにちは');
    assert.equal(node.mimeType, 'text/plain');
  });

  it('親フォルダを自動作成する', async () => {
    await fs.writeFile('/a/b/c/deep.txt', 'x');
    assert.ok(await fs.exists('/a'));
    assert.ok(await fs.exists('/a/b/c'));
    assert.equal(await fs.readText('/a/b/c/deep.txt'), 'x');
  });

  it('既定では上書き、overwrite:false ではエラー', async () => {
    await fs.writeFile('/x.txt', 'one');
    await fs.writeFile('/x.txt', 'two');
    assert.equal(await fs.readText('/x.txt'), 'two');
    await assert.rejects(
      () => fs.writeFile('/x.txt', 'three', { overwrite: false }),
      AlreadyExistsError,
    );
  });

  it('追記できる', async () => {
    await fs.writeFile('/log.txt', 'a\n');
    await fs.appendFile('/log.txt', 'b\n');
    assert.equal(await fs.readText('/log.txt'), 'a\nb\n');
  });

  it('JSON を読み書きできる', async () => {
    await fs.writeJson('/conf.json', { ok: true });
    assert.deepEqual(await fs.readJson('/conf.json'), { ok: true });
    await fs.writeFile('/broken.json', '{oops');
    await assert.rejects(() => fs.readJson('/broken.json'), /JSON/);
  });

  it('バイナリも扱える', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    await fs.writeFile('/bin/data.bin', bytes);
    assert.deepEqual(await fs.readFile('/bin/data.bin'), bytes);
  });

  it('touch は既存を変更しない', async () => {
    await fs.writeFile('/t.txt', 'keep');
    await fs.touch('/t.txt');
    assert.equal(await fs.readText('/t.txt'), 'keep');
    await fs.touch('/new.txt');
    assert.equal(await fs.readText('/new.txt'), '');
  });
});


describe('DriveFs 並行実行と自己参照の防止', () => {
  it('同じ新規フォルダへ並行書き込みしてもフォルダは 1 つだけ', async () => {
    const fs = makeFs();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => fs.writeFile(`/many/f${i}.txt`, String(i))),
    );
    const rootChildren = await fs.list('/');
    assert.equal(rootChildren.filter((n) => n.name === 'many').length, 1);
    assert.equal((await fs.list('/many')).length, 50);
  });

  it('mv で自分自身の配下へは移動できない', async () => {
    const fs = makeFs();
    await fs.writeFile('/a/f.txt', 'x');
    await assert.rejects(() => fs.mv('/a', '/a/b'), InvalidPathError);
    assert.equal(await fs.readText('/a/f.txt'), 'x');
  });

  it('cp で自分自身の配下へはコピーできない', async () => {
    const fs = makeFs();
    await fs.writeFile('/a/f.txt', 'x');
    await assert.rejects(() => fs.cp('/a', '/a/sub'), InvalidPathError);
    assert.equal(await fs.exists('/a/sub'), false);
  });

  it('cp でフォルダ展開後も同一パスになる場合は EEXIST', async () => {
    const fs = makeFs();
    await fs.writeFile('/a/f.txt', 'x');
    await assert.rejects(() => fs.cp('/a/f.txt', '/a'), AlreadyExistsError);
  });

  it('外部で削除されたフォルダはキャッシュ TTL の経過後に ENOENT になる', async () => {
    const backend = new MemoryBackend();
    const fsA = new DriveFs({ backend, cacheTtlMs: 0 });
    const fsB = new DriveFs({ backend });
    await fsA.writeFile('/a/f.txt', 'x');
    assert.equal(await fsA.exists('/a'), true);
    await fsB.rm('/a', { recursive: true });
    assert.equal(await fsA.exists('/a'), false);
    await assert.rejects(() => fsA.stat('/a'), NotFoundError);
  });

  it('書き込みはキャッシュに依存せず常に最新状態で解決する', async () => {
    const backend = new MemoryBackend();
    const fsA = new DriveFs({ backend }); // TTL 30 秒
    const fsB = new DriveFs({ backend });
    await fsA.mkdir('/a');
    await fsA.stat('/a'); // キャッシュを作る
    await fsB.mv('/a', '/c'); // 外部ハンドルでリネーム

    // 古いパスへの書き込みが「移動先に紛れ込む」ことはない
    await fsA.writeFile('/a/x.txt', 'x');
    assert.deepEqual(await fsB.list('/c'), [], '移動先のフォルダは無傷');
    assert.equal(await fsB.readText('/a/x.txt'), 'x', '要求したパスに作られる');

    // createParents:false なら古いパスは素直に ENOENT
    await fsB.mv('/a', '/d');
    await assert.rejects(
      () => fsA.writeFile('/a/y.txt', 'y', { createParents: false }),
      NotFoundError,
    );
  });

  it('appendFile は親フォルダが無くても自動作成する', async () => {
    const fs = makeFs();
    await fs.appendFile('/deep/app/log.txt', 'line1\n');
    await fs.appendFile('/deep/app/log.txt', 'line2\n');
    assert.equal(await fs.readText('/deep/app/log.txt'), 'line1\nline2\n');
  });

  it('外部で消えたファイルの読み取りは空文字ではなく ENOENT になる', async () => {
    const backend = new MemoryBackend();
    const fsA = new DriveFs({ backend });
    const fsB = new DriveFs({ backend });
    await fsA.writeFile('/e/f.txt', 'content');
    await fsA.stat('/e/f.txt'); // キャッシュを作る
    await fsB.rm('/e/f.txt');
    await assert.rejects(() => fsA.readText('/e/f.txt'), NotFoundError);
  });

  it('同名のファイルとフォルダを並行作成しても共存しない', async () => {
    for (let i = 0; i < 10; i += 1) {
      const fs = makeFs();
      await Promise.allSettled([fs.writeFile('/x', 'file'), fs.mkdir('/x')]);
      const sameName = (await fs.list('/')).filter((n) => n.name === 'x');
      assert.equal(sameName.length, 1, `試行 ${i}: 同名ノードが ${sameName.length} 件`);
    }
  });
});

describe('DriveFs 解決と一覧', () => {
  /** @type {DriveFs} */
  let fs;
  beforeEach(async () => {
    fs = makeFs();
    await fs.writeFile('/docs/a.txt', 'a');
    await fs.writeFile('/docs/sub/b.txt', 'b');
    await fs.writeFile('/root.txt', 'r');
  });

  it('存在しないパスは NotFoundError', async () => {
    await assert.rejects(() => fs.stat('/nope'), NotFoundError);
    assert.equal(await fs.exists('/nope'), false);
    assert.equal(await fs.exists('/docs/a.txt'), true);
  });

  it('ファイルをフォルダとして辿ると NotADirectoryError', async () => {
    await assert.rejects(() => fs.stat('/docs/a.txt/nested'), NotADirectoryError);
  });

  it('フォルダを readFile すると NotAFileError', async () => {
    await assert.rejects(() => fs.readFile('/docs'), NotAFileError);
  });

  it('list はフォルダ優先でソートされる', async () => {
    const entries = await fs.list('/docs');
    assert.deepEqual(
      entries.map((e) => e.name),
      ['sub', 'a.txt'],
    );
    assert.equal(entries[0].path, '/docs/sub');
  });

  it('list recursive は全子孫を返す', async () => {
    const paths = (await fs.list('/', { recursive: true })).map((n) => n.path).sort();
    assert.deepEqual(paths, [
      '/docs',
      '/docs/a.txt',
      '/docs/sub',
      '/docs/sub/b.txt',
      '/root.txt',
    ]);
  });

  it('walk はパスを列挙する', async () => {
    const paths = [];
    for await (const entry of fs.walk('/')) paths.push(entry.path);
    assert.deepEqual(paths.sort(), [
      '/docs',
      '/docs/a.txt',
      '/docs/sub',
      '/docs/sub/b.txt',
      '/root.txt',
    ]);
  });

  it('find で名前・正規表現・種別を絞れる', async () => {
    assert.deepEqual(
      (await fs.find('/', { name: 'b.txt' })).map((n) => n.path),
      ['/docs/sub/b.txt'],
    );
    assert.deepEqual(
      (await fs.find('/', { pattern: /\.txt$/ })).map((n) => n.path).sort(),
      ['/docs/a.txt', '/docs/sub/b.txt', '/root.txt'],
    );
    assert.deepEqual(
      (await fs.find('/', { type: 'folder' })).map((n) => n.path),
      ['/docs', '/docs/sub'],
    );
  });

  it('du はファイル数とバイト数を集計する', async () => {
    const stats = await fs.du('/');
    assert.equal(stats.files, 3);
    assert.equal(stats.folders, 3);
    assert.equal(stats.bytes, 3);
  });

  it('tree はネスト構造を返す', async () => {
    const tree = await fs.tree('/', { maxDepth: 3 });
    assert.equal(tree.type, 'folder');
    assert.deepEqual(
      tree.children.map((c) => c.name),
      ['docs', 'root.txt'],
    );
    assert.deepEqual(
      tree.children[0].children.map((c) => c.name),
      ['sub', 'a.txt'],
    );
  });

  it('パスを正規化して扱う', async () => {
    assert.equal(await fs.readText('/docs/./sub/../a.txt'), 'a');
  });

  it('isTextFile は MIME 型で判定する', async () => {
    assert.equal(await fs.isTextFile('/docs/a.txt'), true);
    await fs.writeFile('/img.png', Buffer.from([1, 2, 3]));
    assert.equal(await fs.isTextFile('/img.png'), false);
  });
});

describe('DriveFs 削除・移動・コピー', () => {
  /** @type {DriveFs} */
  let fs;
  beforeEach(async () => {
    fs = makeFs();
    await fs.writeFile('/docs/a.txt', 'a');
    await fs.writeFile('/docs/sub/b.txt', 'b');
  });

  it('空でないフォルダは recursive なしでは消せない', async () => {
    await assert.rejects(() => fs.rm('/docs'), NotEmptyError);
    await fs.rm('/docs/a.txt');
    assert.equal(await fs.exists('/docs/a.txt'), false);
  });

  it('recursive で木ごと削除できる', async () => {
    await fs.rm('/docs', { recursive: true });
    assert.equal(await fs.exists('/docs'), false);
    assert.equal(await fs.exists('/docs/sub/b.txt'), false);
  });

  it('force なら存在しなくてもエラーにならない', async () => {
    assert.equal(await fs.rm('/nope', { force: true }), false);
    await assert.rejects(() => fs.rm('/nope'), NotFoundError);
  });

  it('permanently:false ならゴミ箱へ送る', async () => {
    await fs.rm('/docs/a.txt', { permanently: false });
    assert.equal(await fs.exists('/docs/a.txt'), false);
  });

  it('mv でリネームできる', async () => {
    const moved = await fs.mv('/docs/a.txt', '/docs/renamed.txt');
    assert.equal(moved.path, '/docs/renamed.txt');
    assert.equal(await fs.exists('/docs/a.txt'), false);
    assert.equal(await fs.readText('/docs/renamed.txt'), 'a');
  });

  it('mv 先がフォルダなら中に入る', async () => {
    await fs.mv('/docs/a.txt', '/docs/sub');
    assert.equal(await fs.readText('/docs/sub/a.txt'), 'a');
  });

  it('mv でキャッシュが壊れない', async () => {
    await fs.mv('/docs', '/moved');
    assert.equal(await fs.readText('/moved/sub/b.txt'), 'b');
    assert.equal(await fs.exists('/docs'), false);
  });

  it('cp でファイルを複製できる', async () => {
    await fs.cp('/docs/a.txt', '/docs/copy.txt');
    assert.equal(await fs.readText('/docs/copy.txt'), 'a');
    assert.equal(await fs.readText('/docs/a.txt'), 'a');
  });

  it('cp でフォルダを再帰複製できる', async () => {
    await fs.cp('/docs', '/docs-backup');
    assert.equal(await fs.readText('/docs-backup/sub/b.txt'), 'b');
    await fs.writeFile('/docs-backup/sub/b.txt', 'changed');
    assert.equal(await fs.readText('/docs/sub/b.txt'), 'b');
  });

  it('mkdir は既存フォルダでエラーにならない', async () => {
    await fs.mkdir('/docs');
    await fs.mkdir('/brand/new/path');
    assert.equal(
      (await fs.stat('/brand/new/path')).mimeType,
      'application/vnd.google-apps.folder',
    );
  });
});
