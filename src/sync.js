/**
 * `DriveSync` — ローカルディレクトリと Drive フォルダの双方向ミラー。
 *
 * 同期状態はマニフェスト (既定: `<localRoot>/.gdrivefs-manifest.json`) に
 * 保存した「前回のスナップショット」と現在の差分で判定する。
 * そのため「片側で削除された」ことを検出でき、双方向の衝突も検出できる。
 *
 * ```js
 * const sync = new DriveSync({ fs, localRoot: './data', remoteRoot: '/backup' });
 * const report = await sync.sync({ direction: 'both', delete: false, dryRun: true });
 * ```
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { FOLDER_MIME } from './mime.js';
import { mapLimit } from './util.js';

/** 既定で無視するパス (相対・完全一致 or 前方一致)。 */
export const DEFAULT_EXCLUDES = [
  '.gdrivefs-manifest.json',
  '.git',
  '.DS_Store',
  'node_modules',
  'tmp',
];

/** ローカルファイルの指紋。 */
function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Drive ノードの指紋 (内容が変わったかを判定する)。
 * @param {{ md5Checksum?: string, modifiedTime?: string, size?: number }} node
 */
function remoteFingerprint(node) {
  if (node.md5Checksum) return `md5:${node.md5Checksum}`;
  return `time:${node.modifiedTime ?? ''}:${node.size ?? ''}`;
}

export class DriveSync {
  /**
   * @param {{
   *   fs: import('./fs.js').DriveFs,
   *   localRoot: string,
   *   remoteRoot?: string,
   *   manifestPath?: string,
   *   excludes?: string[],
   *   concurrency?: number,
   * }} params
   */
  constructor({ fs, localRoot, remoteRoot = '/', manifestPath, excludes, concurrency = 4 } = {}) {
    if (!fs) throw new Error('fs (DriveFs インスタンス) が必要です');
    if (!localRoot) throw new Error('localRoot が必要です');
    this.fs = fs;
    this.localRoot = path.resolve(localRoot);
    this.remoteRoot = remoteRoot.startsWith('/') ? remoteRoot : `/${remoteRoot}`;
    this.manifestPath = manifestPath ?? path.join(this.localRoot, '.gdrivefs-manifest.json');
    this.excludes = excludes ?? DEFAULT_EXCLUDES;
    this.concurrency = concurrency;
    /** @type {{ version: number, remoteRoot: string, entries: Record<string, any> }} */
    this.manifest = { version: 1, remoteRoot: this.remoteRoot, entries: {} };
    /** @type {string[]} */
    this.warnings = [];
  }

  /** 除外対象か。 */
  isExcluded(relativePath) {
    const parts = relativePath.split('/');
    return this.excludes.some((pattern) => parts.includes(pattern) || relativePath === pattern);
  }

  remotePathOf(relativePath) {
    return relativePath ? `${this.remoteRoot === '/' ? '' : this.remoteRoot}/${relativePath}` : this.remoteRoot;
  }

  async loadManifest() {
    this.warnings = [];
    const rootId = await this.fs.rootId();
    try {
      const raw = await readFile(this.manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.entries) {
        if (parsed.rootId && parsed.rootId !== rootId) {
          // 別の Drive/アカウントを指すマニフェストを流用すると、
          // 存在しないファイルを「削除された」と誤判定してしまう。
          this.warnings.push(
            `マニフェストの rootId (${parsed.rootId}) が現在のルート (${rootId}) と異なるため、差分情報をリセットしました`,
          );
          this.manifest = { version: 1, remoteRoot: this.remoteRoot, rootId, entries: {} };
          return this.manifest;
        }
        if (parsed.remoteRoot && parsed.remoteRoot !== this.remoteRoot) {
          // 別のリモートを指すマニフェストを使い回すと、存在しないファイルを
          // 「リモートで削除された」と誤判定してローカルを消してしまう。
          this.warnings.push(
            `マニフェストの remoteRoot (${parsed.remoteRoot}) が現在の指定 (${this.remoteRoot}) と異なるため、差分情報をリセットしました`,
          );
          this.manifest = { version: 1, remoteRoot: this.remoteRoot, rootId, entries: {} };
          return this.manifest;
        }
        this.manifest = { version: 1, remoteRoot: this.remoteRoot, rootId, ...parsed };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.manifest = { version: 1, remoteRoot: this.remoteRoot, rootId, entries: {} };
    }
    return this.manifest;
  }

  async saveManifest() {
    await mkdir(path.dirname(this.manifestPath), { recursive: true });
    await writeFile(
      this.manifestPath,
      `${JSON.stringify({ ...this.manifest, savedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  }

  /**
   * ローカル側を走査する。
   * @param {{ hash?: boolean }} [options]
   * @returns {Promise<Map<string, { relativePath: string, absolutePath: string, size: number, mtimeMs: number, hash?: string }>>}
   */
  async scanLocal(options = {}) {
    const wantHash = options.hash ?? true;
    /** @type {Map<string, any>} */
    const found = new Map();
    const walkDir = async (absoluteDir, relativeDir) => {
      let entries;
      try {
        entries = await readdir(absoluteDir, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return; // 未作成のローカルディレクトリは空として扱う
        throw error;
      }
      for (const entry of entries) {
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (this.isExcluded(relativePath)) continue;
        const absolutePath = path.join(absoluteDir, entry.name);
        if (entry.isDirectory()) {
          await walkDir(absolutePath, relativePath);
        } else if (entry.isFile()) {
          const info = await stat(absolutePath);
          const record = {
            relativePath,
            absolutePath,
            size: info.size,
            mtimeMs: info.mtimeMs,
          };
          if (wantHash) {
            record.hash = hashBuffer(await readFile(absolutePath));
          }
          found.set(relativePath, record);
        }
      }
    };
    await walkDir(this.localRoot, '');
    return found;
  }

  /**
   * リモート側を走査する。
   * @returns {Promise<Map<string, { relativePath: string, node: any, fingerprint: string }>>}
   */
  async scanRemote() {
    /** @type {Map<string, any>} */
    const found = new Map();
    if (!(await this.fs.exists(this.remoteRoot))) return found;
    const rootNode = await this.fs.stat(this.remoteRoot);
    if (rootNode.mimeType !== 'application/vnd.google-apps.folder') {
      const relativePath = path.posix.basename(this.remoteRoot);
      found.set(relativePath, {
        relativePath,
        node: rootNode,
        fingerprint: remoteFingerprint(rootNode),
      });
      return found;
    }
    for await (const { path: remotePath, node } of this.fs.walk(this.remoteRoot)) {
      // 同期対象はファイルのみ (フォルダはパスから自動作成される)
      if (node.mimeType === FOLDER_MIME) continue;
      const relativePath = remotePath
        .slice(this.remoteRoot === '/' ? 1 : this.remoteRoot.length)
        .replace(/^\//, '');
      if (!relativePath || this.isExcluded(relativePath)) continue;
      found.set(relativePath, { relativePath, node, fingerprint: remoteFingerprint(node) });
    }
    return found;
  }

  /**
   * ローカルとリモートを比較して変更一覧を返す。
   * @param {{ verifyContent?: boolean }} [options]
   * @returns {Promise<Array<{
   *   relativePath: string,
   *   state: 'local-only'|'remote-only'|'remote-deleted'|'local-deleted'|'both',
   *   localChanged: boolean,
   *   remoteChanged: boolean,
   *   same: boolean,
   *   local?: any,
   *   remote?: any,
   *   previous?: any,
   * }>>}
   */
  async compare(options = {}) {
    const [localMap, remoteMap] = [await this.scanLocal(), await this.scanRemote()];
    const paths = new Set([
      ...localMap.keys(),
      ...remoteMap.keys(),
      ...Object.keys(this.manifest.entries ?? {}),
    ]);
    const changes = [];

    for (const relativePath of [...paths].sort()) {
      const local = localMap.get(relativePath) ?? null;
      const remote = remoteMap.get(relativePath) ?? null;
      const previous = this.manifest.entries?.[relativePath] ?? null;

      const localChanged = local
        ? !previous || previous.localHash !== local.hash
        : Boolean(previous);
      const remoteChanged = remote
        ? !previous || previous.remoteFingerprint !== remote.fingerprint
        : Boolean(previous);

      let state;
      if (local && remote) state = 'both';
      else if (local) state = previous ? 'remote-deleted' : 'local-only';
      else if (remote) state = previous ? 'local-deleted' : 'remote-only';
      else {
        // 前回あって両方から消えた (掃除済み)
        this.manifest.entries && delete this.manifest.entries[relativePath];
        continue;
      }

      let same = false;
      if (state === 'both') {
        if (previous && !localChanged && !remoteChanged) same = true;
        else if (options.verifyContent) same = await this.contentEquals(relativePath);
      }
      const typeConflict = Boolean(
        state === 'both' && local && remote && remote.node?.mimeType === FOLDER_MIME,
      );

      changes.push({
        relativePath,
        state,
        localChanged,
        remoteChanged,
        same,
        typeConflict,
        local,
        remote,
        previous,
      });
    }
    return changes;
  }

  /**
   * リモートの内容がローカルと同一かを実データで確認する。
   * @param {string} relativePath
   * @returns {Promise<boolean>}
   */
  async contentEquals(relativePath) {
    const localPath = path.join(this.localRoot, relativePath);
    try {
      const [localBuffer, remoteBuffer] = await Promise.all([
        readFile(localPath),
        this.fs.readFile(this.remotePathOf(relativePath)),
      ]);
      return hashBuffer(localBuffer) === hashBuffer(remoteBuffer);
    } catch {
      return false;
    }
  }

  /** ローカルファイルを Drive へ上げる。 */
  async uploadOne(relativePath) {
    const localPath = path.join(this.localRoot, relativePath);
    const buffer = await readFile(localPath);
    const node = await this.fs.writeFile(this.remotePathOf(relativePath), buffer);
    return node;
  }

  /** Drive のファイルをローカルへ落とす。 */
  async downloadOne(relativePath) {
    const localPath = path.join(this.localRoot, relativePath);
    const buffer = await this.fs.readFile(this.remotePathOf(relativePath));
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, buffer);
    return localPath;
  }

  /**
   * 変更一覧を人間が読みやすい形で返す。
   * @returns {Promise<{ changes: any[], summary: Record<string, number> }>}
   */
  async status() {
    await this.loadManifest();
    const changes = await this.compare();
    const summary = {};
    for (const change of changes) {
      const key = change.state === 'both' ? (change.same ? 'unchanged' : 'modified') : change.state;
      summary[key] = (summary[key] ?? 0) + 1;
    }
    return { changes, summary };
  }

  /**
   * 1 件分の処理内容を決める。
   * @param {any} change
   * @param {{ direction: string, deleteLocal: boolean, deleteRemote: boolean, onConflict: string, report: any }} context
   * @returns {{ type: string, reason: string }|null}
   */
  _decide(change, context) {
    const { direction, deleteLocal, deleteRemote, onConflict, report } = context;
    const allowPush = direction === 'push' || direction === 'both';
    const allowPull = direction === 'pull' || direction === 'both';

    const conflict = (reason) => {
      if (onConflict === 'local' && allowPush) {
        return { type: 'upload', reason: `${reason}: ローカル優先` };
      }
      if (onConflict === 'remote' && allowPull) {
        return { type: 'download', reason: `${reason}: リモート優先` };
      }
      if (onConflict === 'newest') {
        const localTime = change.local?.mtimeMs ?? 0;
        const remoteTime = change.remote?.node?.modifiedTime
          ? Date.parse(change.remote.node.modifiedTime)
          : 0;
        if (localTime >= remoteTime && allowPush) {
          return { type: 'upload', reason: `${reason}: ローカルが新しい` };
        }
        if (allowPull) return { type: 'download', reason: `${reason}: リモートが新しい` };
      }
      report.conflicts.push({ relativePath: change.relativePath, reason });
      return null;
    };

    if (change.typeConflict) return conflict('型の衝突 (ローカル=ファイル / リモート=フォルダ)');

    switch (change.state) {
      case 'local-only':
        return allowPush
          ? { type: 'upload', reason: 'ローカルのみ' }
          : this._skip(report, change, 'push 無効');
      case 'remote-only':
        return allowPull
          ? { type: 'download', reason: 'リモートのみ' }
          : this._skip(report, change, 'pull 無効');
      case 'remote-deleted':
        if (!deleteLocal) {
          return this._skip(report, change, 'リモートで削除済み (deleteLocal 無効)');
        }
        return allowPull
          ? { type: 'delete-local', reason: 'リモートで削除済み' }
          : this._skip(report, change, 'pull 無効');
      case 'local-deleted':
        if (!deleteRemote) {
          return this._skip(report, change, 'ローカルで削除済み (deleteRemote 無効)');
        }
        return allowPush
          ? { type: 'delete-remote', reason: 'ローカルで削除済み' }
          : this._skip(report, change, 'push 無効');
      case 'both': {
        if (change.same) return null;
        if (!change.previous) {
          if (change.localChanged && change.remoteChanged) {
            return conflict('両側に存在 (マニフェストなし)');
          }
          return allowPush
            ? { type: 'upload', reason: '初回同期 (ローカル優先)' }
            : this._skip(report, change, 'push 無効');
        }
        if (change.localChanged && change.remoteChanged) return conflict('両側で変更');
        if (change.localChanged) {
          return allowPush
            ? { type: 'upload', reason: 'ローカルで変更' }
            : this._skip(report, change, 'push 無効');
        }
        if (change.remoteChanged) {
          return allowPull
            ? { type: 'download', reason: 'リモートで変更' }
            : this._skip(report, change, 'pull 無効');
        }
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * @param {any} report
   * @param {any} change
   * @param {string} reason
   */
  _skip(report, change, reason) {
    report.skipped.push({ relativePath: change.relativePath, reason });
    return null;
  }

  /**
   * 同期を実行する。
   * @param {{
   *   direction?: 'push'|'pull'|'both',
   *   dryRun?: boolean,
   *   delete?: boolean,
   *   deleteLocal?: boolean,
   *   deleteRemote?: boolean,
   *   onConflict?: 'skip'|'local'|'remote'|'newest',
   *   verifyContent?: boolean,
   *   onProgress?: (event: { relativePath: string, action: string }) => void,
   * }} [options]
   * @returns {Promise<Record<string, any>>}
   */
  async sync(options = {}) {
    const direction = options.direction ?? 'both';
    const dryRun = options.dryRun ?? false;
    const report = {
      dryRun,
      direction,
      planned: [],
      uploaded: [],
      downloaded: [],
      deletedLocal: [],
      deletedRemote: [],
      conflicts: [],
      skipped: [],
      errors: [],
      warnings: [],
    };
    const context = {
      direction,
      deleteLocal: options.deleteLocal ?? options.delete ?? false,
      deleteRemote: options.deleteRemote ?? options.delete ?? false,
      onConflict: options.onConflict ?? 'skip',
      report,
    };

    await this.loadManifest();
    report.warnings = [...(this.warnings ?? [])];
    const changes = await this.compare({ verifyContent: options.verifyContent });
    const tasks = [];
    for (const change of changes) {
      const action = this._decide(change, context);
      if (!action) continue;
      report.planned.push({
        relativePath: change.relativePath,
        action: action.type,
        reason: action.reason,
      });
      if (!dryRun) tasks.push({ change, action });
    }

    if (!dryRun) {
      await mapLimit(
        tasks,
        async ({ change, action }) => {
          try {
            await this._apply(change, action, report);
            options.onProgress?.({ relativePath: change.relativePath, action: action.type });
          } catch (error) {
            report.errors.push({
              relativePath: change.relativePath,
              action: action.type,
              message: error?.message ?? String(error),
              code: error?.code,
            });
          }
        },
        { concurrency: this.concurrency },
      );
      await this.saveManifest();
    }

    report.summary = {
      planned: report.planned.length,
      uploaded: report.uploaded.length,
      downloaded: report.downloaded.length,
      deletedLocal: report.deletedLocal.length,
      deletedRemote: report.deletedRemote.length,
      conflicts: report.conflicts.length,
      skipped: report.skipped.length,
      errors: report.errors.length,
    };
    return report;
  }

  /**
   * 決定した処理を実行し、マニフェストを更新する。
   * @param {any} change
   * @param {{ type: string }} action
   * @param {any} report
   */
  async _apply(change, action, report) {
    const { relativePath } = change;
    switch (action.type) {
      case 'upload': {
        const node = await this.uploadOne(relativePath);
        this._remember(relativePath, {
          localHash: change.local?.hash,
          remoteFingerprint: remoteFingerprint(node),
          remoteId: node.id,
          remoteModifiedTime: node.modifiedTime,
          type: 'file',
        });
        report.uploaded.push(relativePath);
        break;
      }
      case 'download': {
        await this.downloadOne(relativePath);
        const localPath = path.join(this.localRoot, relativePath);
        const info = await stat(localPath);
        this._remember(relativePath, {
          localHash: hashBuffer(await readFile(localPath)),
          remoteFingerprint: change.remote?.fingerprint,
          remoteId: change.remote?.node?.id,
          remoteModifiedTime: change.remote?.node?.modifiedTime,
          type: 'file',
          localMtimeMs: info.mtimeMs,
        });
        report.downloaded.push(relativePath);
        break;
      }
      case 'delete-local': {
        await rm(path.join(this.localRoot, relativePath), { force: true });
        delete this.manifest.entries[relativePath];
        report.deletedLocal.push(relativePath);
        break;
      }
      case 'delete-remote': {
        await this.fs.rm(this.remotePathOf(relativePath), { recursive: true, force: true });
        delete this.manifest.entries[relativePath];
        report.deletedRemote.push(relativePath);
        break;
      }
      default:
        break;
    }
  }

  /**
   * @param {string} relativePath
   * @param {Record<string, any>} entry
   */
  _remember(relativePath, entry) {
    this.manifest.entries ??= {};
    this.manifest.entries[relativePath] = { ...entry, syncedAt: new Date().toISOString() };
  }
}
