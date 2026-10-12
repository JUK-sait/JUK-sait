/**
 * `DriveFs` — Google Drive をファイルシステムのように扱う高レベル API。
 *
 * バックエンド（実 Drive / インメモリ）は ID ベースのプリミティブだけを提供し、
 * パス解決・親フォルダの自動作成・上書きセマンティクス・再帰削除などは
 * すべてこのクラスが受け持つ。
 *
 * ```js
 * const fs = new DriveFs({ backend: new MemoryBackend() });
 * await fs.mkdir('/reports/2024');
 * await fs.writeFile('/reports/2024/summary.json', '{"ok":true}');
 * console.log(await fs.readText('/reports/2024/summary.json'));
 * ```
 */

import { FOLDER_MIME, guessMimeType } from './mime.js';
import {
  AlreadyExistsError,
  DriveFsError,
  NotADirectoryError,
  NotAFileError,
  NotFoundError,
  NotEmptyError,
} from './errors.js';
import { bufferToString, isTextLike, toBuffer } from './bytes.js';
import * as pathUtil from './path.js';

/** @typedef {import('./backends/base.js').DriveNode} DriveNode */

export class DriveFs {
  /**
   * @param {{
   *   backend: import('./backends/base.js').DriveBackend,
   *   cacheTtlMs?: number,
   *   defaultPageSize?: number,
   * }} params
   */
  constructor({ backend, cacheTtlMs = 30_000, defaultPageSize = 1000 } = {}) {
    if (!backend) throw new DriveFsError('backend が必要です');
    this.backend = backend;
    this.cacheTtlMs = cacheTtlMs;
    this.defaultPageSize = defaultPageSize;
    /** @type {Map<string, { id: string, expiresAt: number }>} パス -> フォルダ ID */
    this._dirCache = new Map();
    /** @type {Map<string, Promise<unknown>>} パス単位の排他制御 */
    this._locks = new Map();
  }

  /** キャッシュを捨てる。 */
  invalidateCache() {
    this._dirCache.clear();
  }

  /** ルートの ID。 */
  async rootId() {
    if (typeof this.backend.resolveRootId === 'function') {
      return this.backend.resolveRootId();
    }
    return this.backend.rootId();
  }

  /**
   * パスから Drive ノードを解決する。
   * @param {string} input
   * @param {{ mustExist?: boolean }} [options]
   * @returns {Promise<{ path: string, id: string|null, node: DriveNode|null, parentId?: string }>}
   */
  async resolve(input, options = {}) {
    const mustExist = options.mustExist ?? true;
    const normalized = pathUtil.normalize(input);
    if (normalized === '/') {
      const id = await this.rootId();
      let node = null;
      if (id !== 'root') node = await this.backend.getNode(id);
      return {
        path: '/',
        id,
        node:
          node ?? { id, name: 'My Drive', mimeType: FOLDER_MIME, parents: [], trashed: false },
      };
    }

    const parts = pathUtil.segments(normalized);
    let parentId = await this.rootId();
    let currentPath = '';
    let lastNode = null;

    for (let i = 0; i < parts.length; i += 1) {
      const segment = parts[i];
      currentPath = `${currentPath}/${segment}`;
      const isLast = i === parts.length - 1;

      const cached = this._dirCache.get(currentPath);
      if (cached && cached.expiresAt > Date.now()) {
        parentId = cached.id;
        if (isLast) lastNode = await this.backend.getNode(cached.id);
        continue;
      }

      const child = await this.backend.findChild(parentId, segment);
      if (!child) {
        if (!mustExist && isLast) {
          return { path: normalized, id: null, node: null, parentId };
        }
        throw new NotFoundError(`パスが見つかりません: ${currentPath}`, { path: currentPath });
      }
      if (!isLast && child.mimeType !== FOLDER_MIME) {
        throw new NotADirectoryError(`フォルダではありません: ${currentPath}`, {
          path: currentPath,
        });
      }
      if (child.mimeType === FOLDER_MIME) {
        this._dirCache.set(currentPath, {
          id: child.id,
          expiresAt: Date.now() + this.cacheTtlMs,
        });
      }
      parentId = child.id;
      lastNode = child;
    }
    return { path: normalized, id: parentId, node: lastNode };
  }

  /**
   * パスの ID を返す (存在しなければ NotFoundError)。
   * @param {string} input
   * @returns {Promise<string>}
   */
  async id(input) {
    const { id } = await this.resolve(input);
    if (!id) throw new NotFoundError(`パスが見つかりません: ${input}`, { path: input });
    return id;
  }

  /**
   * パス配下のフォルダ ID を（必要なら作って）得る。
   * @param {string} input
   * @param {{ create?: boolean }} [options]
   * @returns {Promise<string>}
   */
  async ensureDir(input, options = {}) {
    const create = options.create ?? true;
    const normalized = pathUtil.normalize(input);
    if (normalized === '/') return this.rootId();
    let parentId = await this.rootId();
    let currentPath = '';
    for (const segment of pathUtil.segments(normalized)) {
      pathUtil.validateSegment(segment);
      currentPath = `${currentPath}/${segment}`;
      const cached = this._dirCache.get(currentPath);
      if (cached && cached.expiresAt > Date.now()) {
        parentId = cached.id;
        continue;
      }
      const existing = await this.backend.findChild(parentId, segment);
      if (existing) {
        if (existing.mimeType !== FOLDER_MIME) {
          throw new NotADirectoryError(`フォルダではありません: ${currentPath}`, {
            path: currentPath,
          });
        }
        parentId = existing.id;
      } else if (create) {
        const created = await this.backend.createFolder({ name: segment, parentId });
        parentId = created.id;
      } else {
        throw new NotFoundError(`フォルダがありません: ${currentPath}`, { path: currentPath });
      }
      this._dirCache.set(currentPath, { id: parentId, expiresAt: Date.now() + this.cacheTtlMs });
    }
    return parentId;
  }

  /**
   * 同一キーへの同時実行を直列化する。
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async _withLock(key, fn) {
    const previous = this._locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => gate);
    this._locks.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      chained.then(() => {
        if (this._locks.get(key) === chained) this._locks.delete(key);
      });
    }
  }

  // ────────────────────────────── 読み取り系 ──────────────────────────────

  /** フォルダかどうか。 */
  static isFolder(node) {
    return node?.mimeType === FOLDER_MIME;
  }

  /**
   * `stat`: 存在しなければ NotFoundError を投げる。
   * @param {string} input
   * @returns {Promise<DriveNode>}
   */
  async stat(input) {
    const { node, path } = await this.resolve(input, { mustExist: true });
    return { ...node, path };
  }

  /**
   * 存在するかどうか (エラーを投げない)。
   * @param {string} input
   * @returns {Promise<boolean>}
   */
  async exists(input) {
    try {
      await this.resolve(input, { mustExist: true });
      return true;
    } catch (error) {
      if (error instanceof NotFoundError) return false;
      throw error;
    }
  }

  /**
   * `ls`: 直下の子を返す。パスがファイルならその 1 件を返す。
   * @param {string} input
   * @param {{ recursive?: boolean }} [options]
   * @returns {Promise<DriveNode[]>}
   */
  async list(input, options = {}) {
    const { node, path } = await this.resolve(input, { mustExist: true });
    if (!DriveFs.isFolder(node)) return [{ ...node, path }];
    if (options.recursive) {
      const out = [];
      for await (const entry of this.walk(input)) out.push(entry.node);
      return out;
    }
    const children = await this.backend.listAllChildren(node.id);
    const base = path === '/' ? '' : path;
    return children
      .map((child) => ({ ...child, path: `${base}/${child.name}` }))
      .sort(compareNodes);
  }

  /**
   * `readFile`: 生バイトを返す。
   * @param {string} input
   * @returns {Promise<Buffer>}
   */
  async readFile(input) {
    const { node, path } = await this.resolve(input, { mustExist: true });
    if (DriveFs.isFolder(node)) {
      throw new NotAFileError(`フォルダは読み込めません: ${path}`, { path });
    }
    const data = await this.backend.download(node.id);
    if (data === null) throw new NotFoundError(`読み込みに失敗しました: ${path}`, { path });
    return data;
  }

  /**
   * `readText`: UTF-8 文字列として読み込む。
   * @param {string} input
   * @returns {Promise<string>}
   */
  async readText(input) {
    return bufferToString(await this.readFile(input));
  }

  /**
   * JSON として読み込む。
   * @template T
   * @param {string} input
   * @returns {Promise<T>}
   */
  async readJson(input) {
    const text = await this.readText(input);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new DriveFsError(`JSON のパースに失敗しました: ${input}`, {
        code: 'EJSONPARSE',
        path: input,
        cause: error,
      });
    }
  }

  /**
   * テキストとして読めるパスかどうか (MIME 型ベース)。
   * @param {string} input
   * @returns {Promise<boolean>}
   */
  async isTextFile(input) {
    const node = await this.stat(input);
    return isTextLike(node.mimeType);
  }

  /**
   * 再帰的にパスとノードを列挙する非同期ジェネレータ (深さ優先)。
   * @param {string} input
   * @param {{ maxDepth?: number, includeRoot?: boolean }} [options]
   * @returns {AsyncGenerator<{ path: string, node: DriveNode }>}
   */
  async *walk(input, options = {}) {
    const maxDepth = options.maxDepth ?? pathUtil.MAX_DEPTH;
    const start = pathUtil.normalize(input);
    const { node } = await this.resolve(start, { mustExist: true });
    if (options.includeRoot) yield { path: start, node: { ...node, path: start } };
    if (!DriveFs.isFolder(node)) return;

    const queue = [{ path: start, id: node.id, depth: 0 }];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      if (current.depth >= maxDepth) continue;
      const children = (await this.backend.listAllChildren(current.id)).sort(compareNodes);
      for (const child of children) {
        const childPath = current.path === '/' ? `/${child.name}` : `${current.path}/${child.name}`;
        yield { path: childPath, node: { ...child, path: childPath } };
        if (DriveFs.isFolder(child)) {
          queue.push({ path: childPath, id: child.id, depth: current.depth + 1 });
        }
      }
    }
  }

  /**
   * `find`: 名前/正規表現/MIME 型で再帰検索する。
   * @param {string} input 起点パス
   * @param {{ name?: string, pattern?: string|RegExp, mimeType?: string, type?: 'file'|'folder', maxDepth?: number }} [options]
   * @returns {Promise<DriveNode[]>}
   */
  async find(input, options = {}) {
    const matcher = buildMatcher(options);
    const results = [];
    for await (const { path, node } of this.walk(input, { maxDepth: options.maxDepth })) {
      if (matcher(node)) results.push({ ...node, path });
    }
    return results;
  }

  /**
   * 配下の合計サイズを求める。
   * @param {string} input
   * @param {{ maxDepth?: number }} [options]
   * @returns {Promise<{ path: string, bytes: number, files: number, folders: number }>}
   */
  async du(input, options = {}) {
    const normalized = pathUtil.normalize(input);
    const start = await this.stat(normalized);
    if (!DriveFs.isFolder(start)) {
      return { path: normalized, bytes: start.size ?? 0, files: 1, folders: 0 };
    }
    let bytes = 0;
    let files = 0;
    let folders = 1;
    for await (const { node } of this.walk(normalized, { maxDepth: options.maxDepth })) {
      if (DriveFs.isFolder(node)) folders += 1;
      else {
        files += 1;
        bytes += node.size ?? 0;
      }
    }
    return { path: normalized, bytes, files, folders };
  }

  /**
   * `tree`: ネスト構造で返す。
   * @param {string} input
   * @param {{ maxDepth?: number }} [options]
   * @returns {Promise<object>}
   */
  async tree(input, options = {}) {
    const maxDepth = options.maxDepth ?? 3;
    const normalized = pathUtil.normalize(input);
    const root = await this.stat(normalized);

    /**
     * @param {DriveNode} node
     * @param {string} nodePath
     * @param {number} depth
     */
    const build = async (node, nodePath, depth) => {
      const entry = {
        name: node.name,
        path: nodePath,
        type: DriveFs.isFolder(node) ? 'folder' : 'file',
        size: node.size,
        mimeType: node.mimeType,
        modifiedTime: node.modifiedTime,
      };
      if (!DriveFs.isFolder(node) || depth >= maxDepth) return entry;
      const children = (await this.backend.listAllChildren(node.id)).sort(compareNodes);
      entry.children = [];
      for (const child of children) {
        const childPath = nodePath === '/' ? `/${child.name}` : `${nodePath}/${child.name}`;
        entry.children.push(await build(child, childPath, depth + 1));
      }
      return entry;
    };
    return build(root, normalized, 0);
  }

  // ────────────────────────────── 書き込み系 ──────────────────────────────

  /**
   * `mkdir -p`: フォルダを作る (既にあればそのまま)。
   * @param {string} input
   * @returns {Promise<DriveNode>}
   */
  async mkdir(input) {
    const normalized = pathUtil.normalize(input);
    if (normalized === '/') return this.stat('/');
    await this.ensureDir(normalized, { create: true });
    const node = await this.stat(normalized);
    if (!DriveFs.isFolder(node)) {
      throw new NotADirectoryError(`同名のファイルが既にあります: ${normalized}`, {
        path: normalized,
      });
    }
    return node;
  }

  /**
   * `writeFile`: ファイルを書き込む (既定では上書き、親フォルダは自動作成)。
   *
   * @param {string} input
   * @param {Buffer|Uint8Array|string|null} content
   * @param {{ mimeType?: string, createParents?: boolean, overwrite?: boolean, appProperties?: Record<string,string> }} [options]
   * @returns {Promise<DriveNode>}
   */
  async writeFile(input, content, options = {}) {
    const normalized = pathUtil.normalize(input);
    if (normalized === '/') {
      throw new NotAFileError('ルートには書き込めません', { path: normalized });
    }
    const parentPath = pathUtil.dirname(normalized);
    const name = pathUtil.basename(normalized);
    pathUtil.validateSegment(name);
    const body = toBuffer(content) ?? Buffer.alloc(0);
    const mimeType = options.mimeType ?? guessMimeType(name);

    return this._withLock(normalized, async () => {
      const parentId = await this.ensureDir(parentPath, {
        create: options.createParents ?? true,
      });
      return this._writeUnlocked(normalized, parentId, name, body, mimeType, options);
    });
  }

  /**
   * ロック取得済みで呼ぶ内部実装 (appendFile からも使う)。
   * @param {string} normalized
   * @param {string} parentId
   * @param {string} name
   * @param {Buffer} body
   * @param {string} mimeType
   * @param {{ overwrite?: boolean, appProperties?: Record<string,string> }} options
   * @returns {Promise<DriveNode>}
   */
  async _writeUnlocked(normalized, parentId, name, body, mimeType, options = {}) {
    const existing = await this.backend.findChild(parentId, name);
    if (existing) {
      if (DriveFs.isFolder(existing)) {
        throw new NotAFileError(`同名のフォルダが存在します: ${normalized}`, { path: normalized });
      }
      if (options.overwrite === false) {
        throw new AlreadyExistsError(`既にファイルが存在します: ${normalized}`, {
          path: normalized,
        });
      }
      const updated = await this.backend.updateFile({
        id: existing.id,
        content: body,
        mimeType,
        ...(options.appProperties ? { appProperties: options.appProperties } : {}),
      });
      return { ...updated, path: normalized };
    }
    const created = await this.backend.createFile({
      name,
      parentId,
      mimeType,
      content: body,
      appProperties: options.appProperties,
    });
    return { ...created, path: normalized };
  }

  /**
   * JSON を整形して書き込む。
   * @param {string} input
   * @param {unknown} value
   * @param {{ space?: number }} [options]
   * @returns {Promise<DriveNode>}
   */
  async writeJson(input, value, options = {}) {
    const space = options.space ?? 2;
    return this.writeFile(input, `${JSON.stringify(value, null, space)}\n`, {
      mimeType: 'application/json',
    });
  }

  /**
   * 追記 (既存内容の末尾に足す)。
   * @param {string} input
   * @param {Buffer|Uint8Array|string} content
   * @returns {Promise<DriveNode>}
   */
  async appendFile(input, content) {
    const normalized = pathUtil.normalize(input);
    const addition = toBuffer(content) ?? Buffer.alloc(0);
    return this._withLock(normalized, async () => {
      let previous = Buffer.alloc(0);
      const resolved = await this.resolve(normalized, { mustExist: false });
      if (resolved.node) {
        if (DriveFs.isFolder(resolved.node)) {
          throw new NotAFileError(`フォルダには追記できません: ${normalized}`, {
            path: normalized,
          });
        }
        previous = (await this.backend.download(resolved.id)) ?? Buffer.alloc(0);
      }
      const parentId = await this.ensureDir(pathUtil.dirname(normalized), { create: true });
      return this._writeUnlocked(
        normalized,
        parentId,
        pathUtil.basename(normalized),
        Buffer.concat([previous, addition]),
        guessMimeType(normalized),
        {},
      );
    });
  }

  /**
   * `rm`: ファイル/フォルダを削除する。
   * @param {string} input
   * @param {{ recursive?: boolean, force?: boolean, permanently?: boolean }} [options]
   * @returns {Promise<boolean>} 実際に削除したか
   */
  async rm(input, options = {}) {
    const normalized = pathUtil.normalize(input);
    if (normalized === '/') throw new NotAFileError('ルートは削除できません', { path: normalized });
    let resolved;
    try {
      resolved = await this.resolve(normalized, { mustExist: true });
    } catch (error) {
      if (error instanceof NotFoundError && options.force) return false;
      throw error;
    }
    const node = resolved.node;
    if (DriveFs.isFolder(node) && !options.recursive) {
      const children = await this.backend.listAllChildren(node.id);
      if (children.length > 0) {
        throw new NotEmptyError(
          `フォルダが空ではありません (recursive: true で削除): ${normalized}`,
          { path: normalized },
        );
      }
    }
    if (options.permanently === false && typeof this.backend.trashNode === 'function') {
      await this.backend.trashNode(resolved.id);
    } else {
      await this.backend.deleteNode(resolved.id);
    }
    this._dirCache.delete(normalized);
    this.invalidateCache();
    return true;
  }

  /**
   * `mv`: 移動 (リネーム)。移動先に同名フォルダがある場合はその中へ入れる。
   * @param {string} from
   * @param {string} to
   * @param {{ overwrite?: boolean }} [options]
   * @returns {Promise<DriveNode>}
   */
  async mv(from, to, options = {}) {
    const source = pathUtil.normalize(from);
    let target = pathUtil.normalize(to);
    if (source === target) return this.stat(source);
    if (source === '/') throw new NotAFileError('ルートは移動できません', { path: source });

    const resolved = await this.resolve(source, { mustExist: true });
    const sourceNode = resolved.node;

    // 移動先が既存フォルダなら、その中に元の名前で入れる
    if (await this.exists(target)) {
      const targetNode = await this.stat(target);
      if (DriveFs.isFolder(targetNode)) target = pathUtil.join(target, sourceNode.name);
    }

    const targetParent = pathUtil.dirname(target);
    const targetName = pathUtil.basename(target);
    pathUtil.validateSegment(targetName);

    return this._withLock(target, async () => {
      const parentId = await this.ensureDir(targetParent, { create: true });
      const existing = await this.backend.findChild(parentId, targetName);
      if (existing && existing.id !== resolved.id) {
        if (options.overwrite === false) {
          throw new AlreadyExistsError(`移動先に既に存在します: ${target}`, { path: target });
        }
        await this.backend.deleteNode(existing.id);
      }
      const removeParents = (sourceNode.parents ?? [])
        .filter((parent) => parent !== parentId)
        .join(',');
      const updated = await this.backend.updateFile({
        id: resolved.id,
        name: targetName,
        addParents: parentId,
        ...(removeParents ? { removeParents } : {}),
      });
      this.invalidateCache();
      return { ...updated, path: target };
    });
  }

  /**
   * `cp`: コピー (フォルダは再帰的)。
   * @param {string} from
   * @param {string} to
   * @param {{ recursive?: boolean, overwrite?: boolean }} [options]
   * @returns {Promise<DriveNode>}
   */
  async cp(from, to, options = {}) {
    const source = pathUtil.normalize(from);
    let target = pathUtil.normalize(to);
    if (source === target) throw new AlreadyExistsError('同一パスにはコピーできません', { path: source });
    const sourceNode = await this.stat(source);

    if (await this.exists(target)) {
      const targetNode = await this.stat(target);
      if (DriveFs.isFolder(targetNode)) target = pathUtil.join(target, sourceNode.name);
    }

    if (!DriveFs.isFolder(sourceNode)) {
      const data = await this.readFile(source);
      return this.writeFile(target, data, {
        mimeType: sourceNode.mimeType,
        overwrite: options.overwrite ?? true,
      });
    }

    if (options.recursive === false) {
      throw new NotADirectoryError('フォルダのコピーには recursive: true が必要です', {
        path: source,
      });
    }
    await this.mkdir(target);
    for await (const { path, node } of this.walk(source)) {
      const relative = path.slice(source.length);
      const destination = pathUtil.join(target, relative);
      if (DriveFs.isFolder(node)) {
        await this.mkdir(destination);
      } else {
        const data = await this.readFile(path);
        await this.writeFile(destination, data, { mimeType: node.mimeType });
      }
    }
    return this.stat(target);
  }

  /**
   * 0 バイトのファイルを作る (既にあれば何もしない)。
   * @param {string} input
   * @returns {Promise<DriveNode>}
   */
  async touch(input) {
    if (await this.exists(input)) return this.stat(input);
    return this.writeFile(input, Buffer.alloc(0), { overwrite: false });
  }
}

/**
 * フォルダ優先 → 名前順 の比較関数。
 * @param {DriveNode} a
 * @param {DriveNode} b
 * @returns {number}
 */
function compareNodes(a, b) {
  const aFolder = DriveFs.isFolder(a) ? 0 : 1;
  const bFolder = DriveFs.isFolder(b) ? 0 : 1;
  if (aFolder !== bFolder) return aFolder - bFolder;
  return a.name.localeCompare(b.name);
}

/**
 * `find` 用の述語を組み立てる。
 * @param {{ name?: string, pattern?: string|RegExp, mimeType?: string, type?: 'file'|'folder' }} options
 * @returns {(node: DriveNode) => boolean}
 */
function buildMatcher(options = {}) {
  const predicates = [];
  if (options.name) predicates.push((/** @type {DriveNode} */ n) => n.name === options.name);
  if (options.pattern) {
    const re =
      options.pattern instanceof RegExp ? options.pattern : new RegExp(String(options.pattern));
    predicates.push((/** @type {DriveNode} */ n) => re.test(n.name));
  }
  if (options.mimeType) {
    predicates.push((/** @type {DriveNode} */ n) => n.mimeType === options.mimeType);
  }
  if (options.type === 'file') predicates.push((n) => !DriveFs.isFolder(n));
  if (options.type === 'folder') predicates.push((n) => DriveFs.isFolder(n));
  return (node) => predicates.every((p) => p(node));
}
