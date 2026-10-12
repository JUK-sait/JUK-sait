/**
 * `gdrivefs` CLI。
 *
 * 使い方の全体像:
 * ```
 * gdrivefs ls /projects --long
 * gdrivefs put ./dist /deploy/web --json
 * gdrivefs get /backup/db.sqlite ./local
 * gdrivefs sync ./data /drive/backup --direction both --delete --dry-run
 * ```
 *
 * `main(argv, io)` は副作用を注入できる形にしてあるため、テストからは
 * `io.makeFs` にインメモリ実装を渡してネットワーク無しで検証できる。
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DriveFs } from './fs.js';
import { DriveSync } from './sync.js';
import { MemoryBackend } from './backends/memory.js';
import { createBackend } from './index.js';
import { FOLDER_MIME } from './mime.js';
import { formatBytes } from './util.js';
import { DriveFsError } from './errors.js';

export const VERSION = '0.1.0';

/** 真偽値として扱うオプション。 */
const BOOLEAN_FLAGS = new Set([
  'recursive',
  'force',
  'json',
  'quiet',
  'help',
  'version',
  'trash',
  'dry-run',
  'delete',
  'delete-local',
  'delete-remote',
  'memory',
  'long',
  'verify-content',
  'binary',
]);

/** 値を取るオプション。 */
const VALUE_FLAGS = new Set([
  'root',
  'shared-drive',
  'depth',
  'name',
  'pattern',
  'type',
  'direction',
  'conflict',
  'api-base',
  'env-file',
  'concurrency',
  'memory-file',
]);

/** 短いオプションの別名。 */
const SHORT_ALIASES = { r: 'recursive', f: 'force', q: 'quiet', h: 'help', l: 'long', v: 'version' };

/**
 * 引数を解析する。
 * @param {string[]} argv
 * @returns {{ command: string|null, positionals: string[], flags: Set<string>, options: Record<string, string> }}
 */
export function parseArgv(argv) {
  const flags = new Set();
  /** @type {Record<string,string>} */
  const options = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      const key = eq === -1 ? body : body.slice(0, eq);
      const inline = eq === -1 ? undefined : body.slice(eq + 1);
      if (BOOLEAN_FLAGS.has(key)) {
        flags.add(key);
        if (inline !== undefined) {
          if (inline === 'false') flags.delete(key);
          else flags.add(key);
        }
        continue;
      }
      if (VALUE_FLAGS.has(key)) {
        if (inline !== undefined) {
          options[key] = inline;
        } else {
          i += 1;
          if (i >= argv.length) throw new DriveFsError(`--${key} には値が必要です`, { code: 'EUSAGE' });
          options[key] = argv[i];
        }
        continue;
      }
      throw new DriveFsError(`不明なオプションです: --${key}`, { code: 'EUSAGE' });
    }
    if (token.startsWith('-') && token.length > 1) {
      for (const char of token.slice(1)) {
        const name = SHORT_ALIASES[char];
        if (!name) throw new DriveFsError(`不明なオプションです: -${char}`, { code: 'EUSAGE' });
        flags.add(name);
      }
      continue;
    }
    positionals.push(token);
  }

  const [command, ...rest] = positionals;
  return { command: command ?? null, positionals: rest, flags, options };
}

/** 標準出力・エラー出力の薄いラッパ。 */
export class Console {
  /** @param {{ stdout?: any, stderr?: any }} [io] */
  constructor(io = {}) {
    this.stdout = io.stdout ?? process.stdout;
    this.stderr = io.stderr ?? process.stderr;
  }

  out(text = '') {
    this.stdout.write(`${text}\n`);
  }

  err(text = '') {
    this.stderr.write(`${text}\n`);
  }
}
/** 使い方の説明。 */
export const HELP = `gdrivefs ${VERSION} — Google Drive のフォルダをファイルシステムのように読み書きする

使い方:
  gdrivefs <コマンド> [引数...] [オプション]

読み取り:
  ls [path...]            直下の一覧 (--long, --recursive, --json)
  tree [path]             ツリー表示 (--depth N)
  cat <path>              内容を標準出力へ (--binary で生バイト)
  stat <path>             メタデータ表示
  find <path>             再帰検索 (--name X, --pattern RE, --type file|folder)
  du <path>               合計サイズ

書き込み:
  mkdir <path...>         フォルダ作成 (親も自動作成)
  put <local...> <remote> アップロード (ディレクトリは再帰, "-" で標準入力)
  get <remote...> [local] ダウンロード (--recursive)
  rm <path...>            削除 (--recursive, --force, --trash)
  mv <src> <dst>          移動/リネーム
  cp <src> <dst>          コピー (--recursive)

同期:
  sync <localDir> <remotePath>   双方向ミラー
     --direction push|pull|both   (既定 both)
     --delete                     両側の削除を伝播
     --dry-run                    実行内容の確認のみ
     --conflict skip|local|remote|newest (既定 skip)
     --verify-content             内容ハッシュで同一判定

その他:
  about                   認証ユーザと容量
  help / --version

共通オプション:
  --root <folderId>       ルートにする Drive フォルダ ID
  --shared-drive <id>     共有ドライブ ID
  --memory                インメモリ実装で動作 (認証不要・検証用)
  --json                  出力を JSON にする
  --quiet                 進捗表示を抑制
  --api-base <url>        Drive API のベース URL (プロキシ/テスト用)
`;

/**
 * CLI のエントリポイント。
 * @param {string[]} argv
 * @param {{ stdout?: any, stderr?: any, stdin?: any, env?: Record<string,string|undefined>, cwd?: string, makeFs?: () => DriveFs }} [io]
 * @returns {Promise<number>} 終了コード
 */
export async function main(argv, io = {}) {
  const out = new Console(io);
  const env = io.env ?? process.env;

  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    out.err(error.message);
    out.err('`gdrivefs help` を参照してください。');
    return 2;
  }
  const { command, positionals, flags, options } = parsed;

  if (flags.has('version') || command === 'version') {
    out.out(`gdrivefs ${VERSION}`);
    return 0;
  }
  if (command === 'help' || flags.has('help') || !command) {
    out.out(HELP);
    return command ? 0 : 2;
  }

  /** @type {DriveFs} */
  let fs;
  let persist;
  try {
    if (io.makeFs) {
      fs = io.makeFs();
    } else {
      ({ fs, persist } = await buildFsContext({ flags, options, env }));
    }
  } catch (error) {
    out.err(`初期化に失敗しました: ${error.message}`);
    return 1;
  }

  const context = { fs, out, flags, options, positionals, io, env };
  try {
    switch (command) {
      case 'ls':
        return await cmdLs(context);
      case 'tree':
        return await cmdTree(context);
      case 'cat':
        return await cmdCat(context);
      case 'stat':
        return await cmdStat(context);
      case 'find':
        return await cmdFind(context);
      case 'du':
        return await cmdDu(context);
      case 'mkdir':
        return await cmdMkdir(context);
      case 'put':
        return await cmdPut(context);
      case 'get':
        return await cmdGet(context);
      case 'rm':
        return await cmdRm(context);
      case 'mv':
        return await cmdMv(context);
      case 'cp':
        return await cmdCp(context);
      case 'sync':
        return await cmdSync(context);
      case 'about':
        return await cmdAbout(context);
      default:
        out.err(`不明なコマンドです: ${command}`);
        out.err('`gdrivefs help` を参照してください。');
        return 2;
    }
  } catch (error) {
    if (error instanceof DriveFsError) {
      out.err(`エラー [${error.code}] ${error.message}`);
      if (error.code === 'EUSAGE') {
        out.err('`gdrivefs help` を参照してください。');
        return 2;
      }
    } else {
      out.err(`予期しないエラー: ${error?.stack ?? error}`);
    }
    return 1;
  } finally {
    if (persist) await persist();
  }
}

/** フォルダかどうか。 */
function isFolder(node) {
  return node?.mimeType === FOLDER_MIME;
}

/** 1 行表示。 */
function nodeLine(node, long = false) {
  const suffix = isFolder(node) ? '/' : '';
  if (!long) return `${node.name}${suffix}`;
  const type = isFolder(node) ? 'dir ' : 'file';
  const size = isFolder(node) ? '-' : formatBytes(node.size ?? 0);
  const modified = node.modifiedTime ? node.modifiedTime.replace('T', ' ').slice(0, 16) : '';
  return `${type} ${String(size).padStart(10)}  ${modified}  ${node.name}${suffix}`;
}

/** JSON 用に正規化する。 */
function serializeNode(node) {
  return {
    id: node.id,
    path: node.path,
    name: node.name,
    type: isFolder(node) ? 'folder' : 'file',
    size: node.size,
    mimeType: node.mimeType,
    modifiedTime: node.modifiedTime,
    webViewLink: node.webViewLink,
  };
}

/** @param {any} context */
async function cmdLs({ fs, out, positionals, flags, options }) {
  const targets = positionals.length > 0 ? positionals : ['/'];
  const long = flags.has('long');
  const recursive = flags.has('recursive');
  const all = [];
  for (const target of targets) {
    const entries = await fs.list(target, { recursive });
    all.push(...entries);
  }
  if (flags.has('json')) {
    out.out(JSON.stringify(all.map(serializeNode), null, 2));
    return 0;
  }
  if (targets.length > 1) {
    for (const target of targets) {
      const entries = await fs.list(target, { recursive });
      out.out(`${target}:`);
      for (const entry of entries) out.out(`  ${nodeLine(entry, long)}`);
    }
    return 0;
  }
  for (const entry of all) out.out(nodeLine(entry, long));
  if (options.depth === undefined && all.length === 0) out.out('(空)');
  return 0;
}

/** @param {any} context */
async function cmdTree({ fs, out, positionals, flags, options }) {
  const target = positionals[0] ?? '/';
  const depth = options.depth ? Number(options.depth) : 3;
  const tree = await fs.tree(target, { maxDepth: depth });
  if (flags.has('json')) {
    out.out(JSON.stringify(tree, null, 2));
    return 0;
  }
  const render = (node, prefix = '', isLast = true, isRoot = false) => {
    const label = isRoot ? `${node.path}` : `${node.name}${node.type === 'folder' ? '/' : ''}`;
    out.out(isRoot ? label : `${prefix}${isLast ? '└── ' : '├── '}${label}`);
    const children = node.children ?? [];
    const childPrefix = isRoot ? '' : `${prefix}${isLast ? '    ' : '│   '}`;
    children.forEach((child, index) => {
      render(child, childPrefix, index === children.length - 1, false);
    });
  };
  render(tree, '', true, true);
  return 0;
}

/** @param {any} context */
async function cmdCat({ fs, out, positionals, flags, io }) {
  if (positionals.length !== 1) throw usageError('cat には 1 つのパスが必要です');
  const [target] = positionals;
  const data = await fs.readFile(target);
  if (flags.has('binary')) {
    (io.stdout ?? process.stdout).write(data);
    return 0;
  }
  out.out(data.toString('utf8').replace(/\n$/, ''));
  return 0;
}

/** @param {any} context */
async function cmdStat({ fs, out, positionals, flags }) {
  if (positionals.length !== 1) throw usageError('stat には 1 つのパスが必要です');
  const node = await fs.stat(positionals[0]);
  if (flags.has('json')) {
    out.out(JSON.stringify({ ...node, type: isFolder(node) ? 'folder' : 'file' }, null, 2));
    return 0;
  }
  out.out(`path:         ${node.path}`);
  out.out(`id:           ${node.id}`);
  out.out(`name:         ${node.name}`);
  out.out(`type:         ${isFolder(node) ? 'folder' : 'file'}`);
  out.out(`mimeType:     ${node.mimeType}`);
  if (!isFolder(node)) out.out(`size:         ${formatBytes(node.size ?? 0)} (${node.size ?? 0} B)`);
  out.out(`modifiedTime: ${node.modifiedTime ?? '-'}`);
  out.out(`createdTime:  ${node.createdTime ?? '-'}`);
  if (node.md5Checksum) out.out(`md5:          ${node.md5Checksum}`);
  if (node.webViewLink) out.out(`url:          ${node.webViewLink}`);
  return 0;
}

/** @param {any} context */
async function cmdFind({ fs, out, positionals, flags, options }) {
  const start = positionals[0] ?? '/';
  const results = await fs.find(start, {
    name: options.name,
    pattern: options.pattern,
    type: options.type,
  });
  if (flags.has('json')) {
    out.out(JSON.stringify(results.map(serializeNode), null, 2));
    return 0;
  }
  for (const node of results) out.out(nodeLine(node, flags.has('long')));
  if (results.length === 0) out.out('(該当なし)');
  return 0;
}

/** @param {any} context */
async function cmdDu({ fs, out, positionals, flags }) {
  const target = positionals[0] ?? '/';
  const stats = await fs.du(target);
  if (flags.has('json')) {
    out.out(JSON.stringify(stats, null, 2));
    return 0;
  }
  out.out(`${formatBytes(stats.bytes)}\t${stats.files} ファイル\t${stats.folders} フォルダ\t${stats.path}`);
  return 0;
}

/**
 * DriveFs と、終了時に呼ぶ保存フックを組み立てる。
 * `--memory --memory-file <path>` を指定すると状態がファイルに永続化される。
 * @param {{ flags: Set<string>, options: Record<string,string>, env: Record<string,string|undefined> }} params
 * @returns {Promise<{ fs: DriveFs, persist?: () => Promise<void> }>}
 */
export async function buildFsContext({ flags, options, env }) {
  const useMemory = flags.has('memory') || env.GDRIVEFS_MEMORY === '1';
  if (useMemory) {
    const file = options['memory-file'] ?? env.GDRIVEFS_MEMORY_FILE;
    let backend = new MemoryBackend();
    if (file) {
      try {
        backend = MemoryBackend.fromSerializable(JSON.parse(await readFile(file, 'utf8')));
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw new DriveFsError(`メモリバックエンドの読み込みに失敗しました: ${error.message}`, {
            code: 'EUSAGE',
          });
        }
      }
    }
    const persist = file ? () => writeFile(file, backend.serialize(), 'utf8') : undefined;
    return { fs: new DriveFs({ backend }), persist };
  }

  const backend = createBackend({
    rootFolderId: options.root ?? env.GOOGLE_DRIVE_ROOT_FOLDER_ID,
    sharedDriveId: options['shared-drive'] ?? env.GOOGLE_SHARED_DRIVE_ID,
    apiBase: options['api-base'],
    env,
  });
  return { fs: new DriveFs({ backend }) };
}

/**
 * 後方互換のための薄いラッパ。
 * @param {{ flags: Set<string>, options: Record<string,string>, env: Record<string,string|undefined> }} params
 * @returns {Promise<DriveFs>}
 */
export async function buildFs(params) {
  return (await buildFsContext(params)).fs;
}

/** 使用法エラーを作る。 */
function usageError(message) {
  return new DriveFsError(message, { code: 'EUSAGE' });
}

/** 標準入力を全部読む。 */
async function readStdin(stdin) {
  const stream = stdin ?? process.stdin;
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** ローカルのファイル/ディレクトリを Drive へ再帰的に上げる。 */
async function uploadLocalPath(fs, localPath, remotePath, out, quiet) {
  const info = await stat(localPath);
  if (info.isDirectory()) {
    await fs.mkdir(remotePath);
    const entries = await readdir(localPath, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.name === '.gdrivefs-manifest.json' || entry.name === '.git') continue;
      count += await uploadLocalPath(
        fs,
        path.join(localPath, entry.name),
        `${remotePath === '/' ? '' : remotePath}/${entry.name}`,
        out,
        quiet,
      );
    }
    return count;
  }
  const node = await fs.writeFile(remotePath, await readFile(localPath));
  if (!quiet) out.err(`↑ ${localPath} -> ${node.path} (${formatBytes(node.size ?? 0)})`);
  return 1;
}

/** Drive からローカルへ再帰的に落とす。 */
async function downloadRemotePath(fs, remotePath, localPath, out, quiet) {
  const node = await fs.stat(remotePath);
  if (isFolder(node)) {
    await mkdir(localPath, { recursive: true });
    const children = await fs.list(remotePath);
    let count = 0;
    for (const child of children) {
      count += await downloadRemotePath(
        fs,
        child.path,
        path.join(localPath, child.name),
        out,
        quiet,
      );
    }
    return count;
  }
  const data = await fs.readFile(remotePath);
  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, data);
  if (!quiet) out.err(`↓ ${remotePath} -> ${localPath} (${formatBytes(data.length)})`);
  return 1;
}


/** @param {any} context */
async function cmdMkdir({ fs, out, positionals, flags }) {
  if (positionals.length === 0) throw usageError('mkdir にはパスが必要です');
  const created = [];
  for (const target of positionals) created.push(await fs.mkdir(target));
  if (flags.has('json')) {
    out.out(JSON.stringify(created.map(serializeNode), null, 2));
    return 0;
  }
  for (const node of created) out.out(`作成: ${node.path}/`);
  return 0;
}

/** @param {any} context */
async function cmdPut({ fs, out, positionals, flags, io }) {
  if (positionals.length < 2) {
    throw usageError('put には「ローカル... リモート」の形式で指定してください');
  }
  const remote = positionals[positionals.length - 1];
  const sources = positionals.slice(0, -1);
  const quiet = flags.has('quiet');

  let remoteIsFolder = remote.endsWith('/');
  if (!remoteIsFolder && (await fs.exists(remote))) {
    remoteIsFolder = isFolder(await fs.stat(remote));
  }

  if (sources.length > 1 && !remoteIsFolder) {
    throw usageError(
      '複数のファイルをアップロードする場合は、リモート側に既存フォルダか末尾 "/" を指定してください',
    );
  }

  let uploaded = 0;
  for (const source of sources) {
    if (source === '-') {
      if (remoteIsFolder) {
        throw usageError('標準入力からのアップロードにはファイルパスを指定してください');
      }
      const data = await readStdin(io.stdin);
      const node = await fs.writeFile(remote, data);
      uploaded += 1;
      if (!quiet) out.err(`↑ (stdin) -> ${node.path} (${formatBytes(node.size ?? 0)})`);
      continue;
    }
    const localPath = path.resolve(io.cwd ?? process.cwd(), source);
    const target = remoteIsFolder
      ? `${remote.replace(/\/$/, '')}/${path.basename(localPath)}`
      : remote;
    uploaded += await uploadLocalPath(fs, localPath, target, out, quiet);
  }
  if (flags.has('json')) out.out(JSON.stringify({ uploaded }, null, 2));
  else out.out(`${uploaded} 件をアップロードしました`);
  return 0;
}

/** ローカルパスがディレクトリか。 */
async function isExistingDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** @param {any} context */
async function cmdGet({ fs, out, positionals, flags, io }) {
  if (positionals.length === 0) throw usageError('get には取得元パスが必要です');
  const quiet = flags.has('quiet');
  let remotes = positionals;
  let destination = '.';
  const last = positionals[positionals.length - 1];
  if (positionals.length >= 2) {
    // 最後の引数が Drive 上に存在しないならローカルの宛先とみなす
    // (絶対パスのローカルディレクトリも指定できるようにするため)
    const looksRemote = last.startsWith('/') && (await fs.exists(last));
    if (!looksRemote) {
      destination = last;
      remotes = positionals.slice(0, -1);
    }
  }
  const destRoot = path.resolve(io.cwd ?? process.cwd(), destination);

  let downloaded = 0;
  for (const remote of remotes) {
    const node = await fs.stat(remote);
    let localTarget = destRoot;
    if (isFolder(node)) {
      localTarget = path.join(destRoot, node.name);
    } else if (remotes.length > 1 || (await isExistingDirectory(destRoot))) {
      localTarget = path.join(destRoot, node.name);
    }
    downloaded += await downloadRemotePath(fs, remote, localTarget, out, quiet);
  }
  if (flags.has('json')) out.out(JSON.stringify({ downloaded }, null, 2));
  else out.out(`${downloaded} 件をダウンロードしました`);
  return 0;
}

/** @param {any} context */
async function cmdRm({ fs, out, positionals, flags }) {
  if (positionals.length === 0) throw usageError('rm にはパスが必要です');
  const removed = [];
  for (const target of positionals) {
    const ok = await fs.rm(target, {
      recursive: flags.has('recursive'),
      force: flags.has('force'),
      permanently: !flags.has('trash'),
    });
    if (ok) removed.push(target);
  }
  if (flags.has('json')) out.out(JSON.stringify({ removed }, null, 2));
  else for (const target of removed) out.out(`削除: ${target}`);
  return 0;
}

/** @param {any} context */
async function cmdMv({ fs, out, positionals, flags }) {
  if (positionals.length !== 2) throw usageError('mv には「移動元 移動先」が必要です');
  const node = await fs.mv(positionals[0], positionals[1]);
  if (flags.has('json')) out.out(JSON.stringify(serializeNode(node), null, 2));
  else out.out(`移動: ${positionals[0]} -> ${node.path}`);
  return 0;
}

/** @param {any} context */
async function cmdCp({ fs, out, positionals, flags }) {
  if (positionals.length !== 2) throw usageError('cp には「コピー元 コピー先」が必要です');
  const node = await fs.cp(positionals[0], positionals[1], { recursive: flags.has('recursive') });
  if (flags.has('json')) out.out(JSON.stringify(serializeNode(node), null, 2));
  else out.out(`コピー: ${positionals[0]} -> ${node.path}`);
  return 0;
}


/** @param {any} context */
async function cmdSync({ fs, out, positionals, flags, options, io }) {
  if (positionals.length !== 2) {
    throw usageError('sync には「ローカルディレクトリ リモートパス」が必要です');
  }
  const [localDir, remoteRoot] = positionals;
  const sync = new DriveSync({
    fs,
    localRoot: path.resolve(io.cwd ?? process.cwd(), localDir),
    remoteRoot,
    concurrency: options.concurrency ? Number(options.concurrency) : 4,
  });
  const report = await sync.sync({
    direction: options.direction ?? 'both',
    dryRun: flags.has('dry-run'),
    deleteLocal: flags.has('delete-local') || flags.has('delete'),
    deleteRemote: flags.has('delete-remote') || flags.has('delete'),
    onConflict: options.conflict ?? 'skip',
    verifyContent: flags.has('verify-content'),
    onProgress: flags.has('quiet')
      ? undefined
      : ({ relativePath, action }) => out.err(`${action}: ${relativePath}`),
  });

  if (flags.has('json')) {
    out.out(JSON.stringify(report, null, 2));
    return report.errors.length > 0 ? 1 : 0;
  }
  for (const warning of report.warnings ?? []) out.err(`警告: ${warning}`);
  if (report.dryRun) out.out('--- dry-run (実行していません) ---');
  for (const item of report.planned) {
    out.out(`${item.action.padEnd(14)} ${item.relativePath}  (${item.reason})`);
  }
  const s = report.summary;
  out.out(
    `完了: 送信 ${s.uploaded} / 受信 ${s.downloaded} / ローカル削除 ${s.deletedLocal} / リモート削除 ${s.deletedRemote} / 衝突 ${s.conflicts} / スキップ ${s.skipped} / エラー ${s.errors}`,
  );
  for (const conflict of report.conflicts) {
    out.err(`衝突: ${conflict.relativePath} (${conflict.reason})`);
  }
  for (const error of report.errors) {
    out.err(`失敗: ${error.relativePath} (${error.message})`);
  }
  return report.errors.length > 0 ? 1 : 0;
}

/** @param {any} context */
async function cmdAbout({ fs, out, flags }) {
  const info = (await fs.backend.about?.()) ?? null;
  if (!info) {
    out.out('このバックエンドは about 情報を提供しません。');
    return 0;
  }
  if (flags.has('json')) {
    out.out(JSON.stringify(info, null, 2));
    return 0;
  }
  const user = info.user ?? {};
  out.out(`ユーザ:   ${user.displayName ?? '-'} <${user.emailAddress ?? '-'}>`);
  if (info.storageQuota) {
    const usage = Number(info.storageQuota.usage ?? 0);
    const limit = Number(info.storageQuota.limit ?? 0);
    out.out(`使用量:   ${formatBytes(usage)} / ${limit > 0 ? formatBytes(limit) : '無制限'}`);
  }
  if (info.rootId) out.out(`ルートID: ${info.rootId}`);
  return 0;
}
