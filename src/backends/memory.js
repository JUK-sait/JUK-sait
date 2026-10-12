/**
 * テスト・オフライン開発用のインメモリバックエンド。
 *
 * 実物の Google Drive と同じ「ID ベース + 親フォルダ + 同名重複可」という
 * セマンティクスを再現する。ネットワークもクレデンシャルも不要なので、
 * 上位層のロジック検証や CI に使う。
 *
 * 追加機能 (テスト用):
 *  - `failNext(methodName, { times, status })`: 指定メソッドを擬似的に失敗させる
 *  - `calls`: 呼ばれたメソッド名のログ
 *  - `snapshot()` / `restore(snapshot)`: 状態の保存と復元
 */

import { FOLDER_MIME, isGoogleNative, resolveExportMimeType } from '../mime.js';
import { ApiError, InvalidPathError } from '../errors.js';
import { toBuffer } from '../bytes.js';
import { DriveBackend, dedupeName } from './base.js';

let seq = 0;

/** 決定的なテスト用 ID を作る。 */
function nextId(prefix = 'mem') {
  seq += 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

export class MemoryBackend extends DriveBackend {
  /**
   * @param {{ now?: () => Date, rootId?: string }} [options]
   */
  constructor(options = {}) {
    super();
    this._now = options.now ?? (() => new Date());
    this._rootId = options.rootId ?? nextId('root');
    /** @type {Map<string, any>} */
    this.nodes = new Map();
    /** @type {Map<string, Buffer>} */
    this.blobs = new Map();
    /** @type {Array<{ method: string, args: unknown[] }>} */
    this.calls = [];
    /** @type {Map<string, { times: number, status: number, reason: string }>} */
    this._failures = new Map();
    this.nodes.set(this._rootId, {
      id: this._rootId,
      name: 'My Drive',
      mimeType: FOLDER_MIME,
      parents: [],
      createdTime: this._timestamp(),
      modifiedTime: this._timestamp(),
      trashed: false,
    });
  }

  _timestamp() {
    return this._now().toISOString();
  }

  _record(method, ...args) {
    this.calls.push({ method, args });
    const failure = this._failures.get(method);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      throw new ApiError(`memory backend で擬似的な失敗: ${method}`, {
        status: failure.status,
        reason: failure.reason,
        retryable: true,
      });
    }
  }

  /**
   * 指定メソッドを次回 `times` 回だけ失敗させる。
   * @param {string} method
   * @param {{ times?: number, status?: number, reason?: string }} [options]
   */
  failNext(method, options = {}) {
    this._failures.set(method, {
      times: options.times ?? 1,
      status: options.status ?? 503,
      reason: options.reason ?? 'backendError',
    });
  }

  /** 何回呼ばれたか。 */
  callCount(method) {
    return this.calls.filter((c) => c.method === method).length;
  }

  snapshot() {
    return {
      rootId: this._rootId,
      nodes: [...this.nodes.entries()].map(([k, v]) => [k, { ...v }]),
      blobs: [...this.blobs.entries()].map(([k, v]) => [k, Buffer.from(v)]),
    };
  }

  /** @param {ReturnType<MemoryBackend['snapshot']>} snapshot */
  restore(snapshot) {
    this._rootId = snapshot.rootId;
    this.nodes = new Map(snapshot.nodes.map(([k, v]) => [k, { ...v }]));
    this.blobs = new Map(snapshot.blobs.map(([k, v]) => [k, Buffer.from(v)]));
  }

  rootId() {
    return this._rootId;
  }

  async getNode(id) {
    this._record('getNode', id);
    const node = this.nodes.get(id);
    if (!node || node.trashed) return null;
    return { ...node, parents: [...node.parents] };
  }

  async listChildren(parentId, options = {}) {
    this._record('listChildren', parentId, options);
    const parent = this.nodes.get(parentId);
    if (!parent) return { nodes: [] };
    const pageSize = options.pageSize ?? 1000;
    const start = Number.parseInt(options.pageToken ?? '0', 10) || 0;
    const children = [...this.nodes.values()].filter(
      (n) => !n.trashed && n.parents.includes(parentId),
    );
    children.sort((a, b) => a.name.localeCompare(b.name));
    const slice = children.slice(start, start + pageSize);
    const next = start + pageSize;
    return {
      nodes: slice.map((n) => ({ ...n, parents: [...n.parents] })),
      nextPageToken: next < children.length ? String(next) : undefined,
    };
  }

  async findChild(parentId, name) {
    this._record('findChild', parentId, name);
    for (const node of this.nodes.values()) {
      if (!node.trashed && node.parents.includes(parentId) && node.name === name) {
        return { ...node, parents: [...node.parents] };
      }
    }
    return null;
  }

  async createFolder({ name, parentId, appProperties }) {
    this._record('createFolder', { name, parentId });
    this._assertParent(parentId);
    const node = {
      id: nextId('fld'),
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
      createdTime: this._timestamp(),
      modifiedTime: this._timestamp(),
      trashed: false,
      appProperties: appProperties ? { ...appProperties } : undefined,
    };
    this.nodes.set(node.id, node);
    return { ...node, parents: [...node.parents] };
  }

  async createFile({ name, parentId, mimeType, content, appProperties }) {
    this._record('createFile', { name, parentId, mimeType });
    this._assertParent(parentId);
    const body = toBuffer(content);
    const node = {
      id: nextId('fil'),
      name,
      mimeType: mimeType ?? 'application/octet-stream',
      parents: [parentId],
      size: body ? body.length : 0,
      createdTime: this._timestamp(),
      modifiedTime: this._timestamp(),
      md5Checksum: body ? pseudoMd5(body) : undefined,
      trashed: false,
      webViewLink: `https://drive.google.com/file/d/${nextId('view')}/view`,
      appProperties: appProperties ? { ...appProperties } : undefined,
    };
    this.nodes.set(node.id, node);
    if (body) this.blobs.set(node.id, body);
    return { ...node, parents: [...node.parents] };
  }

  async updateFile({ id, name, addParents, removeParents, content, mimeType, appProperties }) {
    this._record('updateFile', { id, name, addParents, removeParents });
    const node = this.nodes.get(id);
    if (!node || node.trashed) return null;
    if (name !== undefined) node.name = name;
    if (mimeType !== undefined) node.mimeType = mimeType;
    if (appProperties !== undefined) node.appProperties = { ...appProperties };
    if (addParents) {
      for (const p of String(addParents).split(',')) {
        const pid = p.trim();
        if (pid && !node.parents.includes(pid)) node.parents.push(pid);
      }
    }
    if (removeParents) {
      const removals = new Set(
        String(removeParents)
          .split(',')
          .map((s) => s.trim()),
      );
      node.parents = node.parents.filter((p) => !removals.has(p));
    }
    if (content !== undefined && content !== null) {
      const body = toBuffer(content);
      this.blobs.set(id, body);
      node.size = body.length;
      node.md5Checksum = pseudoMd5(body);
    }
    node.modifiedTime = this._timestamp();
    return { ...node, parents: [...node.parents] };
  }

  async deleteNode(id) {
    this._record('deleteNode', id);
    this._removeSubtree(id);
  }

  async trashNode(id) {
    this._record('trashNode', id);
    const node = this.nodes.get(id);
    if (!node) return null;
    this._markTrashed(id, true);
    return { ...this.nodes.get(id) };
  }

  async download(id) {
    this._record('download', id);
    const node = this.nodes.get(id);
    if (!node || node.trashed) return null;
    if (isGoogleNative(node.mimeType)) {
      return Buffer.from(
        `[exported ${resolveExportMimeType(node.mimeType)} of ${node.name}]`,
        'utf8',
      );
    }
    return this.blobs.get(id) ?? Buffer.alloc(0);
  }

  async about() {
    this._record('about');
    let used = 0;
    for (const [id, blob] of this.blobs.entries()) {
      if (!this.nodes.get(id)?.trashed) used += blob.length;
    }
    return {
      user: { displayName: 'Memory User', emailAddress: 'memory@example.test' },
      storageQuota: { limit: String(15 * 1024 ** 3), usage: String(used) },
      rootId: this._rootId,
    };
  }

  /**
   * 同名衝突時に使う `name (1)` 形式の候補名を返す。
   * @param {string} parentId
   * @param {string} name
   * @returns {Promise<string>}
   */
  async unusedName(parentId, name) {
    const existing = new Set(
      [...this.nodes.values()]
        .filter((n) => !n.trashed && n.parents.includes(parentId))
        .map((n) => n.name),
    );
    return dedupeName((candidate) => existing.has(candidate), name);
  }

  _assertParent(parentId) {
    const parent = this.nodes.get(parentId);
    if (!parent) {
      throw new InvalidPathError(`親フォルダが存在しません: ${parentId}`, { path: parentId });
    }
    if (parent.mimeType !== FOLDER_MIME) {
      throw new InvalidPathError(`親がフォルダではありません: ${parentId}`, { path: parentId });
    }
  }

  _markTrashed(id, value) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.trashed = value;
    if (node.mimeType === FOLDER_MIME) {
      for (const child of this.nodes.values()) {
        if (child.parents.includes(id)) this._markTrashed(child.id, value);
      }
    }
  }

  _removeSubtree(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.mimeType === FOLDER_MIME) {
      for (const child of [...this.nodes.values()]) {
        if (child.parents.includes(id)) this._removeSubtree(child.id);
      }
    }
    this.nodes.delete(id);
    this.blobs.delete(id);
  }

  /**
   * 状態を JSON 化できる形で書き出す (`--memory-file` 用)。
   * @returns {{ rootId: string, nodes: Array<[string, any]>, blobs: Array<[string, string]> }}
   */
  toSerializable() {
    return {
      rootId: this._rootId,
      nodes: [...this.nodes.entries()].map(([k, v]) => [k, { ...v }]),
      blobs: [...this.blobs.entries()].map(([k, v]) => [k, v.toString('base64')]),
    };
  }

  /** 状態を JSON 文字列にする。 */
  serialize() {
    return `${JSON.stringify(this.toSerializable())}\n`;
  }

  /**
   * `toSerializable()` の出力からバックエンドを復元する。
   * @param {{ rootId?: string, nodes?: Array<[string, any]>, blobs?: Array<[string, string]> }} data
   * @param {() => Date} [now]
   * @returns {MemoryBackend}
   */
  static fromSerializable(data, now) {
    const backend = new MemoryBackend(now ? { now } : {});
    if (data?.rootId) backend._rootId = data.rootId;
    backend.nodes = new Map((data?.nodes ?? []).map(([k, v]) => [k, { ...v }]));
    backend.blobs = new Map((data?.blobs ?? []).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
    // 生成済み ID と衝突しないよう連番を進める
    let maxSeq = seq;
    for (const id of backend.nodes.keys()) {
      const match = /-(\d+)$/.exec(id);
      if (match) maxSeq = Math.max(maxSeq, Number(match[1]));
    }
    seq = maxSeq;
    return backend;
  }

}

export { toBuffer };

/**
 * Drive の md5Checksum を模した決定的なハッシュ (暗号用途ではない)。
 * @param {Buffer} buffer
 * @returns {string}
 */
function pseudoMd5(buffer) {
  let h1 = 0x12345678;
  let h2 = 0x9abcdef0;
  for (const byte of buffer) {
    h1 = (h1 * 31 + byte) >>> 0;
    h2 = (h2 ^ ((byte + 1) * 2654435761)) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
