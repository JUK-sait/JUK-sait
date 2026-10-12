/** バイト列まわりの小さなヘルパ。 */

import { InvalidPathError } from './errors.js';

/**
 * 書き込み内容を Buffer に正規化する。
 * @param {Buffer|Uint8Array|string|null|undefined} value
 * @returns {Buffer|null}
 */
export function toBuffer(value) {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new InvalidPathError(
    `書き込み内容は Buffer か文字列である必要があります: ${typeof value}`,
  );
}

/**
 * テキストとして扱ってよい MIME 型か。
 * @param {string} mimeType
 * @returns {boolean}
 */
export function isTextLike(mimeType) {
  if (typeof mimeType !== 'string') return false;
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType.endsWith('+json') ||
    mimeType === 'application/xml' ||
    mimeType.endsWith('+xml') ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/x-yaml' ||
    mimeType === 'application/typescript' ||
    mimeType === 'application/x-sh'
  );
}

/**
 * Buffer を安全に文字列化する (BOM 除去つき)。
 * @param {Buffer} buffer
 * @returns {string}
 */
export function bufferToString(buffer) {
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
