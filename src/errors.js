/**
 * gdrivefs の共通エラー型。
 *
 * すべてのエラーは `code` を持ち、CLI の終了コードや呼び出し側の分岐に使える。
 */

/** gdrivefs が投げる全エラーの基底クラス。 */
export class DriveFsError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, path?: string, cause?: unknown, details?: object }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? 'EGDRIVEFAILURE';
    this.path = options.path;
    this.details = options.details ?? {};
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      path: this.path,
      details: this.details,
    };
  }
}

/** パス・引数が不正。 */
export class InvalidPathError extends DriveFsError {
  constructor(message, options = {}) {
    super(message, { code: 'EINVALIDPATH', ...options });
  }
}

/** 対象が存在しない。 */
export class NotFoundError extends DriveFsError {
  constructor(message, options = {}) {
    super(message, { code: 'ENOENT', ...options });
  }
}

/** 既に同名のものが存在する。 */
export class AlreadyExistsError extends DriveFsError {
  constructor(message, options = {}) {
    super(message, { code: 'EEXIST', ...options });
  }
}

/** 期待した種別（ファイル/フォルダ）と違う。 */
export class NotAFileError extends DriveFsError {
  constructor(message, options = {}) {
    super(message, { code: 'EISDIR', ...options });
  }
}

export class NotADirectoryError extends DriveFsError {
  constructor(message, options = {}) {
    super(message, { code: 'ENOTDIR', ...options });
  }
}

/** 空でないフォルダを削除しようとした。 */
export class NotEmptyError extends DriveFsError {
  constructor(message, options = {}) {
    super(message, { code: 'ENOTEMPTY', ...options });
  }
}

/** 認証・認可の失敗。 */
export class AuthError extends DriveFsError {
  constructor(message, options = {}) {
    super(message, { code: 'EAUTH', ...options });
  }
}

/** Google Drive API がエラーを返した。 */
export class ApiError extends DriveFsError {
  /**
   * @param {string} message
   * @param {{ status?: number, reason?: string, retryable?: boolean, cause?: unknown, details?: object }} [options]
   */
  constructor(message, options = {}) {
    super(message, { code: 'EAPI', ...options });
    this.status = options.status ?? 0;
    this.reason = options.reason ?? '';
    this.retryable = options.retryable ?? false;
  }
}

/** 実装されていない操作。 */
export class NotImplementedError extends DriveFsError {
  constructor(message, options = {}) {
    super(message, { code: 'ENOTIMPLEMENTED', ...options });
  }
}
