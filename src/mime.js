/** MIME 型まわりの定数とヘルパ。 */

/** フォルダを表す Google Drive の MIME 型。 */
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Google ネイティブ形式 (Docs/Sheets/Slides など)。バイナリを直接 DL できない。 */
export const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';

/** Google ネイティブ形式 -> エクスポート既定 MIME 型。 */
export const EXPORT_MIME_MAP = {
  'application/vnd.google-apps.document':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.spreadsheet':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.google-apps.drawing': 'image/svg+xml',
  'application/vnd.google-apps.script': 'application/vnd.google-apps.script+json',
  'application/vnd.google-apps.document.txt': 'text/plain',
};

/** 拡張子 -> アップロード時に使う MIME 型 (最小限)。 */
const EXT_MIME_MAP = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * 名前から MIME 型を推定する。
 * @param {string} name
 * @returns {string}
 */
export function guessMimeType(name) {
  const lower = String(name).toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  return EXT_MIME_MAP[lower.slice(dot)] ?? 'application/octet-stream';
}

/**
 * Google ネイティブ形式かどうか。
 * @param {string} mimeType
 * @returns {boolean}
 */
export function isGoogleNative(mimeType) {
  return (
    typeof mimeType === 'string' &&
    mimeType.startsWith(GOOGLE_APPS_PREFIX) &&
    mimeType !== FOLDER_MIME
  );
}

/**
 * Google ネイティブ形式をダウンロードするためのエクスポート MIME 型を返す。
 * @param {string} mimeType
 * @returns {string}
 */
export function resolveExportMimeType(mimeType) {
  return EXPORT_MIME_MAP[mimeType] ?? 'application/pdf';
}

/**
 * Google ネイティブ形式を書き込むためのショートカット名 -> MIME 型。
 * 例: `docs`, `sheets`, `slides`.
 */
export const NATIVE_SHORTCUTS = {
  doc: 'application/vnd.google-apps.document',
  docs: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  sheets: 'application/vnd.google-apps.spreadsheet',
  slide: 'application/vnd.google-apps.presentation',
  slides: 'application/vnd.google-apps.presentation',
};
