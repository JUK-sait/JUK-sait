/**
 * バックエンド抽象。
 *
 * gdrivefs の上位層 (`DriveFs`) は「ID ベースのプリミティブ操作」だけを
 * バックエンドに要求する。これにより実物の Google Drive REST 実装と、
 * テスト用のインメモリ実装を同じコードで扱える。
 *
 * ## Node 表現 (正規化された Drive アイテム)
 * ```
 * {
 *   id: string,
 *   name: string,
 *   mimeType: string,
 *   parents: string[],
 *   size?: number,            // フォルダ/Google ネイティブでは undefined のことがある
 *   createdTime?: string,     // RFC3339
 *   modifiedTime?: string,
 *   md5Checksum?: string,
 *   trashed?: boolean,
 *   webViewLink?: string,
 *   appProperties?: Record<string,string>
 * }
 * ```
 *
 * ## 実装しなければならないメソッド
 *  - `rootId()`                       ルートフォルダ ID (`/` が指す場所)
 *  - `getNode(id)`                    1 件取得。無ければ null
 *  - `listChildren(parentId, opts)`   `{ nodes, nextPageToken }`
 *  - `createFolder({ name, parentId })`
 *  - `createFile({ name, parentId, mimeType, content, appProperties })`
 *  - `updateFile({ id, name, addParents, removeParents, content, appProperties })`
 *  - `deleteNode(id)`                 完全削除
 *  - `download(id)`                   Buffer を返す
 *
 * 任意実装 (未実装なら上位層がフォールバックする):
 *  - `trashNode(id)`                  → 無ければ `deleteNode`
 *  - `findChild(parentId, name)`      → 無ければ `listChildren` を走査
 *  - `about()`                        → 無ければ null
 *  - `capacity()`                     → ストレージ使用量
 */

import { NotImplementedError } from '../errors.js';

/** @typedef {{ id: string, name: string, mimeType: string, parents: string[], size?: number, createdTime?: string, modifiedTime?: string, md5Checksum?: string, trashed?: boolean, webViewLink?: string, appProperties?: Record<string,string> }} DriveNode */

export class DriveBackend {
  /** @returns {string} ルートフォルダの ID */
  rootId() {
    throw new NotImplementedError('rootId() が実装されていません');
  }

  /**
   * @param {string} id
   * @returns {Promise<DriveNode|null>}
   */
  async getNode(id) {
    throw new NotImplementedError(`getNode() が実装されていません (id=${id})`);
  }

  /**
   * @param {string} parentId
   * @param {{ pageToken?: string, pageSize?: number }} [options]
   * @returns {Promise<{ nodes: DriveNode[], nextPageToken?: string }>}
   */
  async listChildren(parentId, options = {}) {
    throw new NotImplementedError(`listChildren() が実装されていません (parent=${parentId})`);
  }

  /**
   * @param {{ name: string, parentId: string, appProperties?: Record<string,string> }} params
   * @returns {Promise<DriveNode>}
   */
  async createFolder(params) {
    throw new NotImplementedError(`createFolder() が実装されていません (name=${params?.name})`);
  }

  /**
   * @param {{ name: string, parentId: string, mimeType?: string, content?: Buffer|string|null, appProperties?: Record<string,string> }} params
   * @returns {Promise<DriveNode>}
   */
  async createFile(params) {
    throw new NotImplementedError(`createFile() が実装されていません (name=${params?.name})`);
  }

  /**
   * @param {{ id: string, name?: string, addParents?: string, removeParents?: string, content?: Buffer|string|null, mimeType?: string, appProperties?: Record<string,string> }} params
   * @returns {Promise<DriveNode>}
   */
  async updateFile(params) {
    throw new NotImplementedError(`updateFile() が実装されていません (id=${params?.id})`);
  }

  /**
   * 完全削除 (ゴミ箱を経由しない)。
   * @param {string} id
   * @returns {Promise<void>}
   */
  async deleteNode(id) {
    throw new NotImplementedError(`deleteNode() が実装されていません (id=${id})`);
  }

  /**
   * @param {string} id
   * @param {{ node?: DriveNode }} [options] 既知のノードを渡すと余分な取得を省ける
   * @returns {Promise<Buffer|null>}
   */
  async download(id, options = {}) {
    throw new NotImplementedError(`download() が実装されていません (id=${id})`);
  }

  /**
   * ゴミ箱へ移動 (未実装なら上位層が deleteNode を呼ぶ)。
   * @param {string} id
   * @returns {Promise<DriveNode>}
   */
  async trashNode(id) {
    throw new NotImplementedError(`trashNode() が実装されていません (id=${id})`);
  }

  /**
   * 親フォルダ直下から名前で 1 件探す (既定実装: listChildren を線形探索)。
   * @param {string} parentId
   * @param {string} name
   * @returns {Promise<DriveNode|null>}
   */
  async findChild(parentId, name) {
    let pageToken;
    do {
      const { nodes, nextPageToken } = await this.listChildren(parentId, { pageToken });
      const hit = nodes.find((n) => n.name === name);
      if (hit) return hit;
      pageToken = nextPageToken;
    } while (pageToken);
    return null;
  }

  /**
   * 子を全件列挙する (ページングを吸収)。
   * @param {string} parentId
   * @returns {Promise<DriveNode[]>}
   */
  async listAllChildren(parentId) {
    const all = [];
    let pageToken;
    do {
      const { nodes, nextPageToken } = await this.listChildren(parentId, {
        pageToken,
        pageSize: 1000,
      });
      all.push(...nodes);
      pageToken = nextPageToken;
    } while (pageToken);
    return all;
  }

  /**
   * アカウント/ドライブの情報。未対応なら null。
   * @returns {Promise<null|{ user?: object, storageQuota?: object, rootId?: string }>}
   */
  async about() {
    return null;
  }

  /** 後始末 (HTTP エージェントの破棄など)。 */
  async close() {}
}

/**
 * 名前の衝突を避けつつ未使用の名前を作る。
 * `report.txt` -> `report (1).txt`
 * @param {(name: string, index: number) => boolean} isTaken
 * @param {string} name
 * @returns {string}
 */
export function dedupeName(isTaken, name) {
  if (!isTaken(name, 0)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 10000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!isTaken(candidate, i)) return candidate;
  }
  throw new Error(`空きのある名前を作れませんでした: ${name}`);
}
