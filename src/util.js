/** 小さな汎用ヘルパ群 (依存ゼロ)。 */

/**
 * 指定ミリ秒待つ。
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 指数バックオフ + ジッタ。
 * @param {number} attempt 1 始まり
 * @param {{ baseMs?: number, maxMs?: number, random?: () => number }} [options]
 * @returns {number} ミリ秒
 */
export function backoffDelay(attempt, options = {}) {
  const baseMs = options.baseMs ?? 400;
  const maxMs = options.maxMs ?? 30_000;
  const random = options.random ?? Math.random;
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitter = 0.5 + random() * 0.5; // 50%〜100%
  return Math.round(exponential * jitter);
}

/** リトライすべき HTTP ステータスか。 */
export function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * Drive API のクエリ文字列リテラルをエスケープする。
 * `'` とバックスラッシュを `\` でエスケープする必要がある。
 * @param {string} value
 * @returns {string}
 */
export function escapeQueryLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** 同時実行数を制限するセマフォ。 */
export class Semaphore {
  /** @param {number} limit */
  constructor(limit = 4) {
    this.limit = Math.max(1, limit);
    this._active = 0;
    this._queue = [];
  }

  get active() {
    return this._active;
  }

  get pending() {
    return this._queue.length;
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    if (this._active >= this.limit) {
      await new Promise((resolve) => this._queue.push(resolve));
    }
    this._active += 1;
    try {
      return await fn();
    } finally {
      this._active -= 1;
      const next = this._queue.shift();
      if (next) next();
    }
  }
}

/**
 * 配列を並列度を制限しつつ処理する (順序は保持)。
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @param {{ concurrency?: number }} [options]
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, mapper, options = {}) {
  const semaphore = new Semaphore(options.concurrency ?? 4);
  const results = new Array(items.length);
  await Promise.all(
    items.map((item, index) =>
      semaphore.run(async () => {
        results[index] = await mapper(item, index);
      }),
    ),
  );
  return results;
}

/**
 * バイト数を読みやすい文字列にする。
 * @param {number|string} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '不明';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? n : n.toFixed(1)} ${units[unit]}`;
}

/**
 * 再帰的にオブジェクトを凍結する (定数テーブルの保護用)。
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
