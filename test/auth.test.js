import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  RefreshTokenProvider,
  ServiceAccountProvider,
  StaticTokenProvider,
  createTokenProviderFromEnv,
  loadServiceAccountCredentials,
} from '../src/auth.js';
import { AuthError } from '../src/errors.js';

/** テスト用の RSA 鍵ペア。 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** トークンエンドポイントを模した fetch。 */
function fakeTokenFetch(payload = { access_token: 'token-1', expires_in: 3600 }, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

describe('TokenProvider', () => {
  it('StaticTokenProvider は固定値を返す', async () => {
    const provider = new StaticTokenProvider({ accessToken: 'abc' });
    const token = await provider.getToken();
    assert.equal(token.accessToken, 'abc');
  });

  it('RefreshTokenProvider はトークンをキャッシュする', async () => {
    const fetchImpl = fakeTokenFetch();
    const provider = new RefreshTokenProvider({
      clientId: 'cid',
      clientSecret: 'secret',
      refreshToken: 'rt',
      fetchImpl,
    });
    const first = await provider.getToken();
    const second = await provider.getToken();
    assert.equal(first.accessToken, 'token-1');
    assert.equal(second.accessToken, 'token-1');
    assert.equal(fetchImpl.calls.length, 1, '2 回目はキャッシュを使う');
    assert.match(fetchImpl.calls[0].body, /grant_type=refresh_token/);
    provider.invalidate();
    await provider.getToken();
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('RefreshTokenProvider は失敗を AuthError にする', async () => {
    const fetchImpl = fakeTokenFetch(
      { error: 'invalid_grant', error_description: 'expired' },
      400,
    );
    const provider = new RefreshTokenProvider({
      clientId: 'cid',
      clientSecret: 'secret',
      refreshToken: 'rt',
      fetchImpl,
    });
    await assert.rejects(() => provider.getToken(), AuthError);
  });

  it('ServiceAccountProvider の JWT は RS256 で署名され検証できる', () => {
    const provider = new ServiceAccountProvider({
      credentials: {
        client_email: 'sa@example.iam.gserviceaccount.com',
        private_key: privateKey,
      },
      subject: 'user@example.com',
      scopes: ['https://www.googleapis.com/auth/drive'],
      fetchImpl: async () => new Response('{}'),
    });
    const assertion = provider.buildAssertion(1700000000);
    const [header, payload, signature] = assertion.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), {
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(claims.iss, 'sa@example.iam.gserviceaccount.com');
    assert.equal(claims.sub, 'user@example.com');
    assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
    assert.equal(claims.exp - claims.iat, 3600);
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
    assert.equal(ok, true);
  });

  it('ServiceAccountProvider は jwt-bearer でトークンを交換する', async () => {
    const fetchImpl = fakeTokenFetch();
    const provider = new ServiceAccountProvider({
      credentials: { client_email: 'sa@example.com', private_key: privateKey },
      fetchImpl,
    });
    const token = await provider.getToken();
    assert.equal(token.accessToken, 'token-1');
    assert.match(fetchImpl.calls[0].body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
  });

  it('loadServiceAccountCredentials は JSON 文字列もファイルも読む', () => {
    assert.deepEqual(loadServiceAccountCredentials('{"client_email":"a"}'), {
      client_email: 'a',
    });
    assert.throws(() => loadServiceAccountCredentials('{bad'), AuthError);
    assert.throws(() => loadServiceAccountCredentials(42), AuthError);
  });

  it('createTokenProviderFromEnv は優先順に選ぶ', () => {
    assert.equal(createTokenProviderFromEnv({}), null);
    const staticProvider = createTokenProviderFromEnv({ GOOGLE_DRIVE_ACCESS_TOKEN: 't' });
    assert.ok(staticProvider instanceof StaticTokenProvider);
    const refreshProvider = createTokenProviderFromEnv({
      GOOGLE_DRIVE_ACCESS_TOKEN: 't',
      GOOGLE_OAUTH_CLIENT_ID: 'c',
      GOOGLE_OAUTH_CLIENT_SECRET: 's',
      GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
    });
    assert.ok(refreshProvider instanceof StaticTokenProvider, '静的トークンが最優先');
    const saProvider = createTokenProviderFromEnv({
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'sa@example.com',
        private_key: privateKey,
      }),
    });
    assert.ok(saProvider instanceof ServiceAccountProvider);
  });
});
