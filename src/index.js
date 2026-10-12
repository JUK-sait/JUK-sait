/**
 * gdrivefs — Google Drive のフォルダをファイルシステムのように読み書きするシステム。
 *
 * 典型的な使い方:
 *
 * ```js
 * import { createDriveFs } from 'gdrivefs';
 *
 * // 環境変数の認証情報 + ルートフォルダ ID から組み立てる
 * const fs = createDriveFs({ rootFolderId: process.env.DRIVE_ROOT_ID });
 * await fs.writeFile('/logs/app.log', 'hello\n');
 * console.log(await fs.readText('/logs/app.log'));
 * ```
 *
 * 認証情報が無い環境でも開発・テストができるよう、
 * `createDriveFs({ useMemoryBackend: true })` でインメモリ実装に切り替えられる。
 */

import { DriveFs } from './fs.js';
import { DriveSync } from './sync.js';
import { MemoryBackend } from './backends/memory.js';
import { GoogleDriveBackend, DEFAULT_API_BASE, DEFAULT_FIELDS } from './backends/google.js';
import { createTokenProviderFromEnv } from './auth.js';
import * as errors from './errors.js';
import * as mime from './mime.js';
import * as pathUtils from './path.js';
import { formatBytes, mapLimit, Semaphore } from './util.js';
import { bufferToString, isTextLike, toBuffer } from './bytes.js';

export { DriveFs, DriveSync, MemoryBackend, GoogleDriveBackend, createTokenProviderFromEnv };
export { DEFAULT_API_BASE, DEFAULT_FIELDS };
export { errors, mime, pathUtils, formatBytes, mapLimit, Semaphore, bufferToString, isTextLike, toBuffer };
export * from './errors.js';
export * from './auth.js';
export { DEFAULT_EXCLUDES } from './sync.js';

/**
 * バックエンドと DriveFs を一度に組み立てる。
 *
 * @param {{
 *   backend?: object,
 *   useMemoryBackend?: boolean,
 *   rootFolderId?: string,
 *   sharedDriveId?: string,
 *   tokenProvider?: object,
 *   env?: Record<string, string|undefined>,
 *   fetchImpl?: typeof fetch,
 *   cacheTtlMs?: number,
 *   maxRetries?: number,
 *   baseDelayMs?: number,
 *   apiBase?: string,
 * }} [options]
 * @returns {DriveFs}
 */
export function createDriveFs(options = {}) {
  const backend = options.backend ?? createBackend(options);
  return new DriveFs({
    backend,
    cacheTtlMs: options.cacheTtlMs,
    defaultPageSize: options.defaultPageSize,
    maxCacheEntries: options.maxCacheEntries,
  });
}

/**
 * バックエンドだけを組み立てる。
 * @param {Parameters<typeof createDriveFs>[0]} [options]
 * @returns {object}
 */
export function createBackend(options = {}) {
  if (options.backend) return options.backend;
  if (options.useMemoryBackend) return new MemoryBackend();

  const env = options.env ?? process.env;
  const tokenProvider =
    options.tokenProvider ?? createTokenProviderFromEnv(env, { fetchImpl: options.fetchImpl });

  if (!tokenProvider) {
    throw new errors.AuthError(
      [
        'Google Drive の認証情報が見つかりません。次のいずれかを設定してください:',
        '  - GOOGLE_DRIVE_ACCESS_TOKEN',
        '  - GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN',
        '  - GOOGLE_SERVICE_ACCOUNT_FILE (または GOOGLE_SERVICE_ACCOUNT_JSON)',
        'オフラインで試す場合は createDriveFs({ useMemoryBackend: true }) を使えます。',
      ].join('\n'),
    );
  }

  return new GoogleDriveBackend({
    tokenProvider,
    rootFolderId: options.rootFolderId ?? env.GOOGLE_DRIVE_ROOT_FOLDER_ID,
    sharedDriveId: options.sharedDriveId ?? env.GOOGLE_SHARED_DRIVE_ID,
    apiBase: options.apiBase ?? env.GOOGLE_DRIVE_API_BASE ?? DEFAULT_API_BASE,
    fetchImpl: options.fetchImpl,
    maxRetries: options.maxRetries,
    baseDelayMs: options.baseDelayMs,
  });
}
