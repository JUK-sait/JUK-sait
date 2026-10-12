import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { main, parseArgv } from '../src/cli.js';
import { DriveFs } from '../src/fs.js';
import { MemoryBackend } from '../src/backends/memory.js';

/** 出力を集めるフェイクストリーム。 */
function collector() {
  const chunks = [];
  return {
    write: (text) => {
      chunks.push(String(text));
      return true;
    },
    text: () => chunks.join(''),
  };
}

describe('parseArgv', () => {
  it('コマンドと位置引数を取り出す', () => {
    const parsed = parseArgv(['ls', '/a', '/b']);
    assert.equal(parsed.command, 'ls');
    assert.deepEqual(parsed.positionals, ['/a', '/b']);
  });

  it('長いオプションを解釈する', () => {
    const parsed = parseArgv(['ls', '--long', '--depth=3', '--name', 'x']);
    assert.equal(parsed.flags.has('long'), true);
    assert.equal(parsed.options.depth, '3');
    assert.equal(parsed.options.name, 'x');
  });

  it('短いオプションを解釈する', () => {
    const parsed = parseArgv(['rm', '-rf', '/x']);
    assert.equal(parsed.flags.has('recursive'), true);
    assert.equal(parsed.flags.has('force'), true);
    assert.deepEqual(parsed.positionals, ['/x']);
  });

  it('不明なオプションはエラー', () => {
    assert.throws(() => parseArgv(['ls', '--nope']), /不明なオプション/);
    assert.throws(() => parseArgv(['ls', '-z']), /不明なオプション/);
    assert.throws(() => parseArgv(['ls', '--root']), /値が必要です/);
  });

  it('-- 以降は位置引数として扱う', () => {
    const parsed = parseArgv(['rm', '--', '--weird-name']);
    assert.deepEqual(parsed.positionals, ['--weird-name']);

describe('CLI 実行', () => {
  /** @type {DriveFs} */
  let fs;
  /** @type {string} */
  let cwd;
  let stdout;
  let stderr;

  /** CLI を実行する。 */
  async function run(args, { stdin } = {}) {
    return main(args, {
      stdout,
      stderr,
      cwd,
      env: {},
      makeFs: () => fs,
      stdin: stdin ? Readable.from([stdin]) : undefined,
    });
  }

  beforeEach(async () => {
    fs = new DriveFs({ backend: new MemoryBackend() });
    cwd = await mkdtemp(path.join(tmpdir(), 'gdrivefs-cli-'));
    stdout = collector();
    stderr = collector();
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('help と version を表示する', async () => {
    assert.equal(await run(['help']), 0);
    assert.match(stdout.text(), /gdrivefs .* — Google Drive/);
    stdout = collector();
    assert.equal(await run(['--version']), 0);
    assert.match(stdout.text(), /^gdrivefs \d+\.\d+\.\d+/);
  });

  it('コマンド無しは使用法エラー (終了コード 2)', async () => {
    assert.equal(await run([]), 2);
    assert.match(stdout.text(), /使い方:/);
  });

  it('不明なコマンドは終了コード 2', async () => {
    assert.equal(await run(['frobnicate']), 2);
    assert.match(stderr.text(), /不明なコマンド/);
  });

  it('mkdir → put → ls → cat の流れが動く', async () => {
    await writeFile(path.join(cwd, 'note.txt'), 'content');
    assert.equal(await run(['mkdir', '/docs']), 0);
    assert.equal(await run(['put', 'note.txt', '/docs']), 0);

    stdout = collector();
    assert.equal(await run(['ls', '/docs']), 0);
    assert.equal(stdout.text().trim(), 'note.txt');

    stdout = collector();
    assert.equal(await run(['cat', '/docs/note.txt']), 0);
    assert.equal(stdout.text().trim(), 'content');
  });

  it('put - で標準入力からアップロードできる', async () => {
    assert.equal(await run(['put', '-', '/stdin.txt'], { stdin: 'from-stdin' }), 0);
    assert.equal(await fs.readText('/stdin.txt'), 'from-stdin');
  });

  it('put はディレクトリを再帰的に上げる', async () => {
    await mkdir(path.join(cwd, 'src', 'sub'), { recursive: true });
    await writeFile(path.join(cwd, 'src', 'a.txt'), 'a');
    await writeFile(path.join(cwd, 'src', 'sub', 'b.txt'), 'b');
    assert.equal(await run(['put', 'src', '/upload']), 0);
    assert.equal(await fs.readText('/upload/a.txt'), 'a');
    assert.equal(await fs.readText('/upload/sub/b.txt'), 'b');
  });

  it('get はローカルへダウンロードする', async () => {
    await fs.writeFile('/remote/x.txt', 'x');
    await fs.writeFile('/remote/y.txt', 'y');
    assert.equal(await run(['get', '/remote', 'out']), 0);
    assert.equal(await readFile(path.join(cwd, 'out', 'remote', 'x.txt'), 'utf8'), 'x');
    assert.equal(await readFile(path.join(cwd, 'out', 'remote', 'y.txt'), 'utf8'), 'y');
  });

  it('get は絶対パスのローカル宛先も受け付ける', async () => {
    await fs.writeFile('/remote/x.txt', 'x');
    const dest = path.join(cwd, 'abs-dest');
    assert.equal(await run(['get', '/remote', dest]), 0);
    assert.equal(await readFile(path.join(dest, 'remote', 'x.txt'), 'utf8'), 'x');
  });

  it('--json は機械可読な出力になる', async () => {
    await fs.writeFile('/data/a.txt', 'a');
    assert.equal(await run(['ls', '/data', '--json']), 0);
    const parsed = JSON.parse(stdout.text());
    assert.equal(parsed[0].name, 'a.txt');
    assert.equal(parsed[0].type, 'file');
    assert.equal(parsed[0].path, '/data/a.txt');
  });


  it('stat / find / du / tree が動作する', async () => {
    await fs.writeFile('/data/a.txt', 'abc');
    await fs.writeFile('/data/sub/b.txt', 'de');

    assert.equal(await run(['stat', '/data/a.txt']), 0);
    assert.match(stdout.text(), /size:\s+3 B/);

    stdout = collector();
    assert.equal(await run(['find', '/', '--pattern', '\\.txt$']), 0);
    assert.equal(stdout.text().trim().split('\n').length, 2);

    stdout = collector();
    assert.equal(await run(['du', '/data']), 0);
    assert.match(stdout.text(), /2 ファイル/);

    stdout = collector();
    assert.equal(await run(['tree', '/data']), 0);
    assert.match(stdout.text(), /a\.txt/);
    assert.match(stdout.text(), /sub\//);
  });

  it('mv / cp / rm が動作する', async () => {
    await fs.writeFile('/docs/a.txt', 'a');
    assert.equal(await run(['mv', '/docs/a.txt', '/docs/b.txt']), 0);
    assert.equal(await fs.exists('/docs/b.txt'), true);
    assert.equal(await run(['cp', '/docs/b.txt', '/docs/c.txt']), 0);
    assert.equal(await fs.readText('/docs/c.txt'), 'a');
    assert.equal(await run(['rm', '/docs/c.txt']), 0);
    assert.equal(await fs.exists('/docs/c.txt'), false);
  });

  it('rm は recursive 無しで空でないフォルダを拒否する (終了コード 1)', async () => {
    await fs.writeFile('/docs/a.txt', 'a');
    assert.equal(await run(['rm', '/docs']), 1);
    assert.match(stderr.text(), /ENOTEMPTY/);
    assert.equal(await run(['rm', '-r', '/docs']), 0);
    assert.equal(await fs.exists('/docs'), false);
  });

  it('存在しないパスは終了コード 1 とエラー表示', async () => {
    assert.equal(await run(['cat', '/missing.txt']), 1);
    assert.match(stderr.text(), /ENOENT/);
  });

  it('引数不足は使用法エラー (終了コード 2)', async () => {
    assert.equal(await run(['mv', '/only-one']), 2);
    assert.match(stderr.text(), /EUSAGE/);
    assert.equal(await run(['cat']), 2);
  });

  it('sync は dry-run と通常実行の両方で動く', async () => {
    await writeFile(path.join(cwd, 'data.txt'), 'v1');
    assert.equal(await run(['sync', '.', '/backup', '--dry-run', '--json']), 0);
    let report = JSON.parse(stdout.text());
    assert.equal(report.dryRun, true);
    assert.equal(report.summary.planned, 1);
    assert.equal(await fs.exists('/backup/data.txt'), false);

    stdout = collector();
    assert.equal(await run(['sync', '.', '/backup', '--json']), 0);
    report = JSON.parse(stdout.text());
    assert.equal(report.summary.uploaded, 1);
    assert.equal(await fs.readText('/backup/data.txt'), 'v1');

    stdout = collector();
    assert.equal(await run(['sync', '.', '/backup']), 0);
    assert.match(stdout.text(), /完了: 送信 0/);
  });

  it('オプションの値が不正なら終了コード 2', async () => {
    assert.equal(await run(['sync', '.', '/backup', '--direction', 'bogus']), 2);
    assert.match(stderr.text(), /--direction/);
    stderr = collector();
    assert.equal(await run(['find', '/', '--type', 'weird']), 2);
    assert.match(stderr.text(), /--type/);
    stderr = collector();
    assert.equal(await run(['sync', '.', '/backup', '--concurrency', 'abc']), 2);
    assert.match(stderr.text(), /--concurrency/);
  });

  it('未作成のローカルディレクトリは空として同期できる', async () => {
    assert.equal(await run(['sync', 'no-such-dir', '/backup']), 0);
    assert.match(stdout.text(), /完了: 送信 0/);
  });

  it('ファイルシステム由来のエラーはスタックを出さず簡潔に表示する', async () => {
    assert.equal(await run(['put', 'no-such-local.txt', '/x.txt']), 1);
    assert.match(stderr.text(), /エラー \[ENOENT\]/);
    assert.doesNotMatch(stderr.text(), /at async/);
  });

  it('about はユーザ情報を表示する', async () => {
    assert.equal(await run(['about']), 0);
    assert.match(stdout.text(), /Memory User/);
  });
});

  });
});
