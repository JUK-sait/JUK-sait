/**
 * Drive 上の「パス」を扱うユーティリティ。
 *
 * Google Drive 自体は木構造の ID ベース API だが、gdrivefs は
 * POSIX 風の絶対パス (`/Projects/app/config.json`) に落とし込んで扱う。
 *
 * ルール:
 *  - 常に先頭が `/` の絶対パスとして正規化する (`/` = ルートフォルダ)
 *  - 末尾スラッシュは無視 (ただし `/` だけはそのまま)
 *  - `.` は除去、`..` は1つ上の階層へ (ルートより上には行けない)
 *  - 重複スラッシュは1つにまとめる
 *  - セグメント長・パス長・禁止文字を検証する (`validateSegment`)
 */

import { InvalidPathError } from './errors.js';

/** Google Drive が名前に許可しない文字 (`/` は階層区切りなので別扱い)。 */
const FORBIDDEN_CHARS = /[\u0000-\u001f/]/;
/** Google Drive のファイル名上限は UTF-8 で 255 バイト相当。安全側に倒す。 */
export const MAX_SEGMENT_LENGTH = 255;
/** ルートからの深さ上限 (Drive API は深い階層で性能が落ちるため)。 */
export const MAX_DEPTH = 100;

/**
 * セグメント (1階層分の名前) を検証する。
 * @param {string} segment
 * @returns {string} 検証済みセグメント
 */
export function validateSegment(segment) {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw new InvalidPathError('空のパスセグメントは使えません');
  }
  if (segment === '.' || segment === '..') {
    throw new InvalidPathError(`予約されたセグメントです: ${segment}`);
  }
  if (FORBIDDEN_CHARS.test(segment)) {
    throw new InvalidPathError(
      `名前に使えない文字が含まれています (制御文字または "/"): ${JSON.stringify(segment)}`,
    );
  }
  if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_LENGTH) {
    throw new InvalidPathError(
      `名前が長すぎます (UTF-8 で ${MAX_SEGMENT_LENGTH} バイト以内): ${segment}`,
    );
  }
  if (segment.trim() !== segment) {
    throw new InvalidPathError(`名前の前後に空白は使えません: ${JSON.stringify(segment)}`);
  }
  return segment;
}

/**
 * 任意のパス文字列を絶対パスに正規化する。
 * @param {string} input
 * @returns {string} 例: `/a/b`
 */
export function normalize(input) {
  if (typeof input !== 'string') {
    throw new InvalidPathError(`パスは文字列である必要があります: ${String(input)}`);
  }
  const segments = [];
  for (const raw of input.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      segments.pop();
      continue;
    }
    segments.push(raw);
  }
  if (segments.length > MAX_DEPTH) {
    throw new InvalidPathError(`階層が深すぎます (最大 ${MAX_DEPTH} 段): ${input}`);
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/**
 * パスをセグメント配列に分解する (`/` は `[]`)。
 * @param {string} input
 * @returns {string[]}
 */
export function segments(input) {
  const normalized = normalize(input);
  return normalized === '/' ? [] : normalized.slice(1).split('/');
}

/**
 * パスを結合する。
 * @param {...string} parts
 * @returns {string}
 */
export function join(...parts) {
  return normalize(parts.filter((p) => p !== undefined && p !== null && p !== '').join('/'));
}

/**
 * 最後のセグメントを返す (`/` は `/`)。
 * @param {string} input
 * @returns {string}
 */
export function basename(input) {
  const list = segments(input);
  return list.length === 0 ? '/' : list[list.length - 1];
}

/**
 * 親ディレクトリのパスを返す (`/a` の親は `/`)。
 * @param {string} input
 * @returns {string}
 */
export function dirname(input) {
  const list = segments(input);
  return list.length <= 1 ? '/' : `/${list.slice(0, -1).join('/')}`;
}

/**
 * 与えたパスが `base` の配下 (または同一) かどうか。
 * @param {string} base
 * @param {string} target
 * @returns {boolean}
 */
export function contains(base, target) {
  const b = segments(base);
  const t = segments(target);
  if (b.length > t.length) return false;
  return b.every((seg, i) => seg === t[i]);
}
