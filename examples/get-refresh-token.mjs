/**
 * OAuth2 リフレッシュトークンを取得する補助スクリプト（初回のみ実行）。
 *
 *   GOOGLE_OAUTH_CLIENT_ID=xxx GOOGLE_OAUTH_CLIENT_SECRET=yyy \
 *     node examples/get-refresh-token.mjs
 *
 * 流れ:
 *   1. 認可 URL を表示するのでブラウザで開いて許可
 *   2. リダイレクト先の `code`（URL の ?code=... 部分）を貼り付ける
 *   3. リフレッシュトークンを表示（環境変数 GOOGLE_OAUTH_REFRESH_TOKEN に設定）
 *
 * 前提: Google Cloud で OAuth クライアント（デスクトップ アプリ）を作成しておくこと。
 */

import { createInterface } from 'node:readline/promises';

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI ?? 'http://localhost';
const scope = 'https://www.googleapis.com/auth/drive';

if (!clientId || !clientSecret) {
  console.error('GOOGLE_OAUTH_CLIENT_ID と GOOGLE_OAUTH_CLIENT_SECRET を設定してください。');
  process.exit(2);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', scope);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

console.log('次の URL をブラウザで開き、許可後にリダイレクトされた URL の code を貼り付けてください:\n');
console.log(authUrl.toString());
console.log();

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('code (またはリダイレクト URL 全体): ')).trim();
rl.close();

const code = answer.startsWith('http') ? new URL(answer).searchParams.get('code') : answer;
if (!code) {
  console.error('code を取得できませんでした。');
  process.exit(1);
}

const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  }),
});

const payload = await response.json();
if (!response.ok || !payload.refresh_token) {
  console.error('トークン交換に失敗しました:', payload);
  process.exit(1);
}

console.log('\n以下を環境変数に設定してください（refresh_token は再表示されません）:\n');
console.log(`export GOOGLE_OAUTH_CLIENT_ID=${clientId}`);
console.log(`export GOOGLE_OAUTH_CLIENT_SECRET=${clientSecret}`);
console.log(`export GOOGLE_OAUTH_REFRESH_TOKEN=${payload.refresh_token}`);
