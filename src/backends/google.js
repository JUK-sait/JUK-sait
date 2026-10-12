/**
 * Google Drive REST API (v3) を直接叩くバックエンド実装。
 *
 * - 依存ゼロ (`fetch` + `node:crypto`) なので `googleapis` パッケージは不要
 * - 429/5xx は指数バックオフで自動リトライ (Retry-After も尊重)
 * - 401 は一度だけトークンを再取得して再試行
 * - 共有ドライブ (`supportsAllDrives` / `corpora=drive`) に対応
 * - Google ネイティブ形式 (Docs/Sheets/Slides) は自動でエクスポートして DL
 *
 * テスト用に `fetchImpl` を差し替えられる。
 */

import { FOLDER_MIME, isGoogleNative, resolveExportMimeType } from '../mime.js';
import { ApiError } from '../errors.js';
import {
  backoffDelay,
  escapeQueryLiteral,
  isRetryableStatus,
  sleep,
  Semaphore,
} from '../util.js';
import { toBuffer } from '../bytes.js';
import { DriveBackend } from './base.js';

export const DEFAULT_API_BASE = 'https://www.googleapis.com';
export const DEFAULT_FIELDS =
  'id,name,mimeType,parents,size,createdTime,modifiedTime,md5Checksum,trashed,webViewLink,iconLink,appProperties,shortcutDetails';

/** @param {any} item */
export function normalizeNode(item) {
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    parents: item.parents ?? [],
    size: item.size === undefined || item.size === null ? undefined : Number(item.size),
    createdTime: item.createdTime,
    modifiedTime: item.modifiedTime,
    md5Checksum: item.md5Checksum,
    trashed: item.trashed ?? false,
    webViewLink: item.webViewLink,
    iconLink: item.iconLink,
    appProperties: item.appProperties,
    shortcutDetails: item.shortcutDetails,
  };
}

/** @param {Response} response */
async function safeReadJson(response) {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

/**
 * multipart/related のボディを組み立てる (Drive の `uploadType=multipart`)。
 * @param {Record<string, unknown>} metadata
 * @param {Buffer|null} content
 * @param {string} contentType
 * @returns {{ body: Buffer, contentType: string }}
 */
export function buildMultipartBody(metadata, content, contentType = 'application/octet-stream') {
  const boundary = `gdrivefs-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const parts = [];
  parts.push(
    Buffer.from(
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
        metadata,
      )}\r\n`,
      'utf8',
    ),
  );
  if (content && content.length > 0) {
    parts.push(
      Buffer.from(`--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`, 'utf8'),
      content,
      Buffer.from('\r\n', 'utf8'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}


export class GoogleDriveBackend extends DriveBackend {
  /**
   * @param {{
   *   tokenProvider: { getToken: () => Promise<{ accessToken: string }>, invalidate?: () => void },
   *   rootFolderId?: string,
   *   sharedDriveId?: string,
   *   apiBase?: string,
   *   fetchImpl?: typeof fetch,
   *   maxRetries?: number,
   *   baseDelayMs?: number,
   *   fields?: string,
   *   supportsAllDrives?: boolean,
   *   includeItemsFromAllDrives?: boolean,
   *   fetchRootIdOnDemand?: boolean,
   * }} params
   */
  constructor(params = {}) {
    super();
    const {
      tokenProvider,
      rootFolderId,
      sharedDriveId,
      apiBase = DEFAULT_API_BASE,
      fetchImpl,
      maxRetries = 4,
      baseDelayMs = 400,
      fields = DEFAULT_FIELDS,
      supportsAllDrives,
      includeItemsFromAllDrives,
      fetchRootIdOnDemand = true,
    } = params;
    if (!tokenProvider || typeof tokenProvider.getToken !== 'function') {
      throw new ApiError('tokenProvider が必要です (GoogleDriveBackend)');
    }
    this.tokenProvider = tokenProvider;
    this.sharedDriveId = sharedDriveId;
    this._rootFolderId = rootFolderId ?? sharedDriveId ?? null;
    this.apiBase = apiBase.replace(/\/$/, '');
    this._fetch = fetchImpl ?? globalThis.fetch;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.fields = fields;
    this.supportsAllDrives = supportsAllDrives ?? true;
    this.includeItemsFromAllDrives = includeItemsFromAllDrives ?? Boolean(sharedDriveId);
    this.fetchRootIdOnDemand = fetchRootIdOnDemand;
    this.stats = { requests: 0, retries: 0, uploads: 0, downloads: 0 };
    if (typeof this._fetch !== 'function') {
      throw new ApiError('fetch が利用できません (Node 18 以降が必要です)');
    }
  }

  rootId() {
    return this._rootFolderId ?? 'root';
  }

  /** ルート ID を確定させる (未指定なら about() で実 ID を取得)。 */
  async resolveRootId() {
    if (this._rootFolderId) return this._rootFolderId;
    if (!this.fetchRootIdOnDemand) {
      this._rootFolderId = 'root';
      return this._rootFolderId;
    }
    try {
      const info = await this.about();
      this._rootFolderId = info?.rootId ?? 'root';
    } catch {
      this._rootFolderId = 'root';
    }
    return this._rootFolderId;
  }

  /** 全リクエストに付ける共通パラメータ。 */
  _commonParams() {
    const params = {};
    if (this.supportsAllDrives) params.supportsAllDrives = 'true';
    if (this.includeItemsFromAllDrives) params.includeItemsFromAllDrives = 'true';
    return params;
  }

  /**
   * 認証付き HTTP リクエスト。リトライとエラー変換を担当する。
   * @param {string} method
   * @param {string} path
   * @param {{ query?: Record<string, string|undefined>, body?: any, headers?: Record<string,string>, kind?: 'json'|'buffer', noRetry?: boolean }} [options]
   * @returns {Promise<any>}
   */
  async _request(method, path, options = {}) {
    const { query = {}, body, headers = {}, kind = 'json', noRetry = false } = options;
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries({ ...this._commonParams(), ...query })) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const maxAttempts = noRetry ? 1 : this.maxRetries;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let token;
      try {
        ({ accessToken: token } = await this.tokenProvider.getToken());
      } catch (error) {
        throw new ApiError(`トークン取得に失敗しました: ${error?.message}`, { cause: error });
      }

      this.stats.requests += 1;
      let response;
      try {
        response = await this._fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body && !headers['content-type']
              ? { 'content-type': 'application/json; charset=utf-8' }
              : {}),
            ...headers,
          },
          body,
        });
      } catch (error) {
        lastError = new ApiError(`ネットワークエラー: ${error?.message}`, {
          retryable: true,
          cause: error,
        });
        if (attempt < maxAttempts) {
          this.stats.retries += 1;
          await sleep(backoffDelay(attempt, { baseMs: this.baseDelayMs }));
          continue;
        }
        throw lastError;
      }

      if (response.ok) {
        if (kind === 'buffer') return Buffer.from(await response.arrayBuffer());
        if (response.status === 204) return null;
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      }

      const retryAfter = Number(response.headers?.get?.('retry-after') ?? 0);
      const errorBody = await safeReadJson(response);
      const reason = errorBody?.error?.errors?.[0]?.reason ?? errorBody?.error?.status ?? '';
      const message =
        errorBody?.error?.message ?? `Drive API エラー: ${response.status} ${response.statusText}`;

      if (response.status === 401 && attempt < maxAttempts) {
        this.tokenProvider.invalidate?.();
        this.stats.retries += 1;
        await sleep(backoffDelay(attempt, { baseMs: this.baseDelayMs }));
        continue;
      }

      lastError = new ApiError(message, {
        status: response.status,
        reason,
        retryable: isRetryableStatus(response.status),
        details: { method, path, status: response.status, reason },
      });

      if (attempt < maxAttempts && isRetryableStatus(response.status)) {
        this.stats.retries += 1;
        const delay =
          retryAfter > 0 ? retryAfter * 1000 : backoffDelay(attempt, { baseMs: this.baseDelayMs });
        await sleep(delay);
        continue;
      }
      throw lastError;
    }
    throw lastError ?? new ApiError('不明なエラー');
  }

  async getNode(id) {
    try {
      const data = await this._request('GET', `/drive/v3/files/${encodeURIComponent(id)}`, {
        query: { fields: this.fields },
      });
      return normalizeNode(data);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async listChildren(parentId, options = {}) {
    const data = await this._request('GET', '/drive/v3/files', {
      query: {
        q: `'${escapeQueryLiteral(parentId)}' in parents and trashed = false`,
        fields: `nextPageToken,files(${this.fields})`,
        pageSize: String(options.pageSize ?? 1000),
        pageToken: options.pageToken,
        orderBy: 'folder,name',
        ...(this.sharedDriveId
          ? { corpora: 'drive', driveId: this.sharedDriveId, includeItemsFromAllDrives: 'true' }
          : {}),
      },
    });
    return {
      nodes: (data?.files ?? []).map(normalizeNode),
      nextPageToken: data?.nextPageToken,
    };
  }

  async findChild(parentId, name) {
    const data = await this._request('GET', '/drive/v3/files', {
      query: {
        q: `'${escapeQueryLiteral(parentId)}' in parents and name = '${escapeQueryLiteral(
          name,
        )}' and trashed = false`,
        fields: `files(${this.fields})`,
        pageSize: '10',
        ...(this.sharedDriveId
          ? { corpora: 'drive', driveId: this.sharedDriveId, includeItemsFromAllDrives: 'true' }
          : {}),
      },
    });
    const [first] = (data?.files ?? []).map(normalizeNode);
    return first ?? null;
  }

  async createFolder({ name, parentId, appProperties }) {
    const data = await this._request('POST', '/drive/v3/files', {
      query: { fields: this.fields },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId],
        ...(appProperties ? { appProperties } : {}),
      }),
    });
    return normalizeNode(data);
  }

  async createFile({ name, parentId, mimeType, content, appProperties }) {
    const metadata = {
      name,
      parents: [parentId],
      ...(mimeType ? { mimeType } : {}),
      ...(appProperties ? { appProperties } : {}),
    };
    const body = content === undefined || content === null ? null : toBuffer(content);
    this.stats.uploads += 1;

    if (!body || body.length === 0) {
      const data = await this._request('POST', '/drive/v3/files', {
        query: { fields: this.fields },
        body: JSON.stringify(metadata),
      });
      return normalizeNode(data);
    }
    const multipart = buildMultipartBody(metadata, body, mimeType ?? 'application/octet-stream');
    const data = await this._request('POST', '/upload/drive/v3/files', {
      query: { uploadType: 'multipart', fields: this.fields },
      body: multipart.body,
      headers: { 'content-type': multipart.contentType },
    });
    return normalizeNode(data);
  }

  async updateFile({ id, name, addParents, removeParents, content, mimeType, appProperties }) {
    const metadata = {
      ...(name !== undefined ? { name } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(appProperties !== undefined ? { appProperties } : {}),
    };
    const query = {
      fields: this.fields,
      addParents,
      removeParents,
    };
    const body = content === undefined || content === null ? null : toBuffer(content);

    let data;
    if (body && body.length > 0) {
      this.stats.uploads += 1;
      const multipart = buildMultipartBody(metadata, body, mimeType ?? 'application/octet-stream');
      data = await this._request('PATCH', `/upload/drive/v3/files/${encodeURIComponent(id)}`, {
        query: { ...query, uploadType: 'multipart' },
        body: multipart.body,
        headers: { 'content-type': multipart.contentType },
      });
    } else {
      data = await this._request('PATCH', `/drive/v3/files/${encodeURIComponent(id)}`, {
        query,
        body: JSON.stringify(metadata),
      });
    }
    return normalizeNode(data);
  }

  async deleteNode(id) {
    await this._request('DELETE', `/drive/v3/files/${encodeURIComponent(id)}`, {
      noRetry: false,
    });
  }

  async trashNode(id) {
    const data = await this._request('PATCH', `/drive/v3/files/${encodeURIComponent(id)}`, {
      query: { fields: this.fields },
      body: JSON.stringify({ trashed: true }),
    });
    return normalizeNode(data);
  }

  async download(id) {
    const node = await this.getNode(id);
    this.stats.downloads += 1;
    if (!node) return null;
    if (isGoogleNative(node.mimeType)) {
      return this._request('GET', `/drive/v3/files/${encodeURIComponent(id)}/export`, {
        query: { mimeType: resolveExportMimeType(node.mimeType) },
        kind: 'buffer',
      });
    }
    return this._request('GET', `/drive/v3/files/${encodeURIComponent(id)}`, {
      query: { alt: 'media' },
      kind: 'buffer',
    });
  }

  async about() {
    const data = await this._request('GET', '/drive/v3/about', {
      query: { fields: 'user,storageQuota,rootId' },
    });
    return data;
  }

  /**
   * 変更を一括で流し込む簡易バッチ (並列度制限つき)。
   * Drive API の batch エンドポイントは JSON バッチ非対応のため、
   * ここでは HTTP 並列度を絞るだけの実装にしている。
   * @template T
   * @param {Array<() => Promise<T>>} operations
   * @param {{ concurrency?: number }} [options]
   * @returns {Promise<T[]>}
   */
  async runBatch(operations, options = {}) {
    const semaphore = new Semaphore(options.concurrency ?? 4);
    return Promise.all(operations.map((op) => semaphore.run(op)));
  }
}

