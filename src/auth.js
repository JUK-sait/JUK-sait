/**
 * Google API のアクセストークンを得るためのプロバイダ群。
 *
 * 対応する 3 方式:
 *  1. 静的アクセストークン          … 短命な検証・CI 用 (`GOOGLE_DRIVE_ACCESS_TOKEN`)
 *  2. OAuth2 リフレッシュトークン    … 個人アカウント/通常のサーバ用途 (推奨)
 *  3. サービスアカウント (JWT RS256) … 共有ドライブ/サーバ間連携
 *
 * すべて `getToken()` で `{ accessToken, expiresAt }` を返し、有効期限が
 * 近づくまでキャッシュする。外部依存は使わず `node:crypto` と `fetch` のみ。
 */

import { createSign, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AuthError } from './errors.js';

export const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const DEFAULT_SCOPES = ['https://www.googleapis.com/auth/drive'];

/** 期限切れ判定の余裕 (秒)。 */
const EXPIRY_SKEW_SECONDS = 60;

/** base64url エンコード。 */
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

export class TokenProvider {
  /** @returns {Promise<{ accessToken: string, expiresAt: number, scopes?: string[] }>} */
  async getToken() {
    throw new AuthError('getToken() が実装されていません');
  }

  /** 認証情報を破棄して次回に再取得させる。 */
  invalidate() {}
}

/** 固定トークン (テストや短命トークンの手渡し用)。 */
export class StaticTokenProvider extends TokenProvider {
  /**
   * @param {{ accessToken: string, expiresAt?: number }} params
   */
  constructor({ accessToken, expiresAt }) {
    super();
    if (!accessToken) throw new AuthError('accessToken が空です');
    this.accessToken = accessToken;
    this.expiresAt = expiresAt ?? Number.POSITIVE_INFINITY;
  }

  async getToken() {
    return { accessToken: this.accessToken, expiresAt: this.expiresAt };
  }
}

/** OAuth2 リフレッシュトークン方式。 */
export class RefreshTokenProvider extends TokenProvider {
  /**
   * @param {{ clientId: string, clientSecret: string, refreshToken: string, tokenUri?: string, fetchImpl?: typeof fetch, scopes?: string[] }} params
   */
  constructor({ clientId, clientSecret, refreshToken, tokenUri, fetchImpl, scopes } = {}) {
    super();
    if (!clientId || !clientSecret) {
      throw new AuthError('clientId と clientSecret が必要です');
    }
    if (!refreshToken) throw new AuthError('refreshToken が必要です');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.tokenUri = tokenUri ?? DEFAULT_TOKEN_URI;
    this.scopes = scopes ?? DEFAULT_SCOPES;
    this._fetch = fetchImpl ?? globalThis.fetch;
    this._cache = null;
    if (typeof this._fetch !== 'function') {
      throw new AuthError('fetch が利用できません (Node 18 以降が必要です)');
    }
  }

  invalidate() {
    this._cache = null;
  }

  async getToken() {
    const now = Date.now() / 1000;
    if (this._cache && this._cache.expiresAt - EXPIRY_SKEW_SECONDS > now) {
      return this._cache;
    }
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await this._fetch(this.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = await safeJson(response);
    if (!response.ok || !payload?.access_token) {
      throw new AuthError(
        `アクセストークンの更新に失敗しました: ${payload?.error ?? response.status} ${
          payload?.error_description ?? ''
        }`.trim(),
        { details: { status: response.status, error: payload?.error } },
      );
    }
    this._cache = {
      accessToken: payload.access_token,
      expiresAt: now + (Number(payload.expires_in) || 3600),
      scopes: payload.scope ? String(payload.scope).split(' ') : this.scopes,
    };
    return this._cache;
  }
}

/** サービスアカウント方式 (JWT Bearer フロー)。 */
export class ServiceAccountProvider extends TokenProvider {
  /**
   * @param {{ credentials: { client_email: string, private_key: string, token_uri?: string }, subject?: string, scopes?: string[], fetchImpl?: typeof fetch }} params
   */
  constructor({ credentials, subject, scopes, fetchImpl } = {}) {
    super();
    if (!credentials?.client_email || !credentials?.private_key) {
      throw new AuthError('サービスアカウント情報に client_email と private_key が必要です');
    }
    this.credentials = credentials;
    this.subject = subject;
    this.scopes = scopes ?? DEFAULT_SCOPES;
    this.tokenUri = credentials.token_uri ?? DEFAULT_TOKEN_URI;
    this._fetch = fetchImpl ?? globalThis.fetch;
    this._cache = null;
    if (typeof this._fetch !== 'function') {
      throw new AuthError('fetch が利用できません (Node 18 以降が必要です)');
    }
  }

  invalidate() {
    this._cache = null;
  }

  /**
   * 署名付き JWT アサーションを組み立てる。
   * (検証しやすいよう公開している。)
   * @param {number} [nowSeconds]
   * @returns {string}
   */
  buildAssertion(nowSeconds = Math.floor(Date.now() / 1000)) {
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: this.credentials.client_email,
      scope: this.scopes.join(' '),
      aud: this.tokenUri,
      exp: nowSeconds + 3600,
      iat: nowSeconds,
      jti: randomUUID(),
      ...(this.subject ? { sub: this.subject } : {}),
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(this.credentials.private_key).toString('base64url');
    return `${signingInput}.${signature}`;
  }

  async getToken() {
    const now = Date.now() / 1000;
    if (this._cache && this._cache.expiresAt - EXPIRY_SKEW_SECONDS > now) {
      return this._cache;
    }
    const assertion = this.buildAssertion(Math.floor(now));
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    const response = await this._fetch(this.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = await safeJson(response);
    if (!response.ok || !payload?.access_token) {
      throw new AuthError(
        `サービスアカウントのトークン取得に失敗しました: ${
          payload?.error ?? response.status
        } ${payload?.error_description ?? ''}`.trim(),
        { details: { status: response.status, error: payload?.error } },
      );
    }
    this._cache = {
      accessToken: payload.access_token,
      expiresAt: now + (Number(payload.expires_in) || 3600),
      scopes: this.scopes,
    };
    return this._cache;
  }
}

/**
 * サービスアカウント JSON をファイルパス/JSON 文字列/オブジェクトから読む。
 * @param {string|object} source
 * @returns {object}
 */
export function loadServiceAccountCredentials(source) {
  if (typeof source === 'object' && source !== null) return source;
  if (typeof source !== 'string') {
    throw new AuthError('サービスアカウント情報の形式が不正です');
  }
  const trimmed = source.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new AuthError('サービスアカウント JSON のパースに失敗しました', { cause: error });
    }
  }
  try {
    return JSON.parse(readFileSync(trimmed, 'utf8'));
  } catch (error) {
    throw new AuthError(`サービスアカウント JSON を読み込めません: ${trimmed}`, { cause: error });
  }
}

/**
 * 環境変数からプロバイダを作る。
 *
 * | 環境変数 | 用途 |
 * | --- | --- |
 * | `GOOGLE_DRIVE_ACCESS_TOKEN` | 静的トークン (最優先) |
 * | `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` | OAuth2 |
 * | `GOOGLE_SERVICE_ACCOUNT_FILE` / `GOOGLE_SERVICE_ACCOUNT_JSON` | サービスアカウント |
 * | `GOOGLE_IMPERSONATE_SUBJECT` | サービスアカウントの代理ユーザ (任意) |
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {TokenProvider|null} 認証情報が何も無ければ null
 */
export function createTokenProviderFromEnv(env = process.env, options = {}) {
  if (env.GOOGLE_DRIVE_ACCESS_TOKEN) {
    return new StaticTokenProvider({
      accessToken: env.GOOGLE_DRIVE_ACCESS_TOKEN,
      expiresAt: env.GOOGLE_DRIVE_ACCESS_TOKEN_EXPIRES_AT
        ? Number(env.GOOGLE_DRIVE_ACCESS_TOKEN_EXPIRES_AT)
        : undefined,
    });
  }
  if (
    env.GOOGLE_OAUTH_CLIENT_ID &&
    env.GOOGLE_OAUTH_CLIENT_SECRET &&
    env.GOOGLE_OAUTH_REFRESH_TOKEN
  ) {
    return new RefreshTokenProvider({
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN,
      fetchImpl: options.fetchImpl,
    });
  }
  const serviceAccountSource = env.GOOGLE_SERVICE_ACCOUNT_FILE ?? env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountSource) {
    return new ServiceAccountProvider({
      credentials: loadServiceAccountCredentials(serviceAccountSource),
      subject: env.GOOGLE_IMPERSONATE_SUBJECT || undefined,
      fetchImpl: options.fetchImpl,
    });
  }
  return null;
}

/** @param {Response} response */
async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
