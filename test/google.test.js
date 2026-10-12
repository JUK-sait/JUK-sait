import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_API_BASE,
  GoogleDriveBackend,
  buildMultipartBody,
  normalizeNode,
} from '../src/backends/google.js';
import { StaticTokenProvider } from '../src/auth.js';
import { ApiError } from '../src/errors.js';

/**
 * fetch を差し替えてリクエストを記録するヘルパ。
 * @param {(request: { method: string, url: URL, body: any, headers: any, index: number }) => any} handler
 */
function mockFetch(handler) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const request = {
      method: init.method ?? 'GET',
      url: url instanceof URL ? url : new URL(String(url)),
      body: init.body,
      headers: init.headers ?? {},
      index: requests.length,
    };
    requests.push(request);
    const result = await handler(request);
    if (result instanceof Response) return result;
    const { status = 200, json, buffer, headers = {} } = result ?? {};
    const noBody = status === 204 || status === 205 || status === 304;
    if (buffer) return new Response(noBody ? null : buffer, { status, headers });
    return new Response(noBody ? null : json === undefined ? '{}' : JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  };
  fetchImpl.requests = requests;
  return fetchImpl;
}

/** バックエンドを作る (リトライ待ちを最小化)。 */
function makeBackend(fetchImpl, options = {}) {
  return new GoogleDriveBackend({
    tokenProvider: new StaticTokenProvider({ accessToken: 'test-token' }),
    rootFolderId: 'ROOT',
    fetchImpl,
    baseDelayMs: 1,
    ...options,
  });
}

const FILE_JSON = {
  id: 'file-1',
  name: 'a.txt',
  mimeType: 'text/plain',
  parents: ['ROOT'],
  size: '5',
  modifiedTime: '2024-01-01T00:00:00.000Z',
  md5Checksum: 'abc',
};

describe('GoogleDriveBackend リクエスト生成', () => {
  it('listChildren は parents クエリと fields を送る', async () => {
    const fetchImpl = mockFetch(() => ({ json: { files: [FILE_JSON] } }));
    const backend = makeBackend(fetchImpl);
    const { nodes } = await backend.listChildren('ROOT', { pageSize: 50 });
    const url = fetchImpl.requests[0].url;
    assert.equal(url.pathname, '/drive/v3/files');
    assert.equal(url.searchParams.get('q'), "'ROOT' in parents and trashed = false");
    assert.equal(url.searchParams.get('pageSize'), '50');
    assert.match(url.searchParams.get('fields'), /nextPageToken,files\(/);
    assert.equal(fetchImpl.requests[0].headers.authorization, 'Bearer test-token');
    assert.equal(nodes[0].name, 'a.txt');
    assert.equal(nodes[0].size, 5, 'size は数値に正規化される');
  });

  it('findChild はクォートをエスケープする', async () => {
    const fetchImpl = mockFetch(() => ({ json: { files: [] } }));
    const backend = makeBackend(fetchImpl);
    await backend.findChild('ROOT', "it's a \\ test");
    const q = fetchImpl.requests[0].url.searchParams.get('q');
    assert.match(q, /name = 'it\\'s a \\\\ test'/);
  });

  it('共有ドライブ指定時は corpora / driveId を付ける', async () => {
    const fetchImpl = mockFetch(() => ({ json: { files: [] } }));
    const backend = makeBackend(fetchImpl, { sharedDriveId: 'DRIVE', rootFolderId: undefined });
    assert.equal(backend.rootId(), 'DRIVE');
    await backend.listChildren('DRIVE');
    const url = fetchImpl.requests[0].url;
    assert.equal(url.searchParams.get('corpora'), 'drive');
    assert.equal(url.searchParams.get('driveId'), 'DRIVE');
    assert.equal(url.searchParams.get('includeItemsFromAllDrives'), 'true');
    assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
  });

  it('apiBase を差し替えられる', async () => {
    const fetchImpl = mockFetch(() => ({ json: { files: [] } }));
    const backend = makeBackend(fetchImpl, { apiBase: 'https://proxy.example.test/' });
    await backend.listChildren('ROOT');
    assert.equal(fetchImpl.requests[0].url.origin, 'https://proxy.example.test');
    assert.equal(DEFAULT_API_BASE, 'https://www.googleapis.com');
  });

  it('createFolder はフォルダ MIME で POST する', async () => {
    const fetchImpl = mockFetch(() => ({
      json: { ...FILE_JSON, id: 'fld', mimeType: 'application/vnd.google-apps.folder' },
    }));
    const backend = makeBackend(fetchImpl);
    const node = await backend.createFolder({ name: 'docs', parentId: 'ROOT' });
    const request = fetchImpl.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.url.pathname, '/drive/v3/files');
    assert.deepEqual(JSON.parse(request.body), {
      name: 'docs',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['ROOT'],
    });
    assert.equal(node.mimeType, 'application/vnd.google-apps.folder');
  });

  it('createFile は内容があると multipart アップロードする', async () => {
    const fetchImpl = mockFetch(() => ({ json: FILE_JSON }));
    const backend = makeBackend(fetchImpl);
    await backend.createFile({
      name: 'a.txt',
      parentId: 'ROOT',
      mimeType: 'text/plain',
      content: 'hello',
    });
    const request = fetchImpl.requests[0];
    assert.equal(request.url.pathname, '/upload/drive/v3/files');
    assert.equal(request.url.searchParams.get('uploadType'), 'multipart');
    assert.match(request.headers['content-type'], /^multipart\/related; boundary=/);
    const bodyText = Buffer.from(request.body).toString('utf8');
    assert.match(bodyText, /"name":"a\.txt"/);
    assert.match(bodyText, /hello/);
  });

  it('createFile は内容が無いとメタデータのみ POST する', async () => {
    const fetchImpl = mockFetch(() => ({
      json: { ...FILE_JSON, mimeType: 'application/vnd.google-apps.document' },
    }));
    const backend = makeBackend(fetchImpl);
    await backend.createFile({
      name: 'memo',
      parentId: 'ROOT',
      mimeType: 'application/vnd.google-apps.document',
    });
    const request = fetchImpl.requests[0];
    assert.equal(request.url.pathname, '/drive/v3/files');
    assert.deepEqual(JSON.parse(request.body), {
      name: 'memo',
      parents: ['ROOT'],
      mimeType: 'application/vnd.google-apps.document',
    });
  });

  it('updateFile は内容の有無で PATCH 先を切り替える', async () => {
    const fetchImpl = mockFetch(() => ({ json: FILE_JSON }));
    const backend = makeBackend(fetchImpl);
    await backend.updateFile({
      id: 'file-1',
      name: 'b.txt',
      addParents: 'X',
      removeParents: 'ROOT',
    });
    const metaRequest = fetchImpl.requests[0];
    assert.equal(metaRequest.method, 'PATCH');
    assert.equal(metaRequest.url.pathname, '/drive/v3/files/file-1');
    assert.equal(metaRequest.url.searchParams.get('addParents'), 'X');
    assert.equal(metaRequest.url.searchParams.get('removeParents'), 'ROOT');

    await backend.updateFile({ id: 'file-1', content: 'new' });
    const mediaRequest = fetchImpl.requests[1];
    assert.equal(mediaRequest.url.pathname, '/upload/drive/v3/files/file-1');
    assert.equal(mediaRequest.url.searchParams.get('uploadType'), 'multipart');
  });

  it('deleteNode / trashNode が正しいメソッドを使う', async () => {
    const fetchImpl = mockFetch(() => ({ status: 204 }));
    const backend = makeBackend(fetchImpl);
    await backend.deleteNode('file-1');
    assert.equal(fetchImpl.requests[0].method, 'DELETE');

    const trashFetch = mockFetch(() => ({ json: { ...FILE_JSON, trashed: true } }));
    const backend2 = makeBackend(trashFetch);
    const node = await backend2.trashNode('file-1');
    assert.equal(trashFetch.requests[0].method, 'PATCH');
    assert.deepEqual(JSON.parse(trashFetch.requests[0].body), { trashed: true });
    assert.equal(node.trashed, true);
  });

  it('download は alt=media、Google ネイティブは export を使う', async () => {
    const fetchImpl = mockFetch((request) =>
      request.url.searchParams.get('alt') === 'media'
        ? { buffer: Buffer.from('raw-bytes') }
        : { json: FILE_JSON },
    );
    const backend = makeBackend(fetchImpl);
    assert.equal((await backend.download('file-1')).toString(), 'raw-bytes');

    const nativeFetch = mockFetch((request) =>
      request.url.pathname.endsWith('/export')
        ? { buffer: Buffer.from('exported') }
        : { json: { ...FILE_JSON, mimeType: 'application/vnd.google-apps.document' } },
    );
    const backend2 = makeBackend(nativeFetch);
    assert.equal((await backend2.download('file-1')).toString(), 'exported');
    const exportRequest = nativeFetch.requests.find((r) => r.url.pathname.endsWith('/export'));
    assert.equal(
      exportRequest.url.searchParams.get('mimeType'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('download に node を渡すと余分なメタデータ取得をしない', async () => {
    const fetchImpl = mockFetch(() => ({ buffer: Buffer.from('data') }));
    const backend = makeBackend(fetchImpl);
    const node = normalizeNode(FILE_JSON);
    await backend.download('file-1', { node });
    assert.equal(fetchImpl.requests.length, 1);
    assert.equal(fetchImpl.requests[0].url.searchParams.get('alt'), 'media');
  });

  it('about は user/storageQuota を取得する', async () => {
    const fetchImpl = mockFetch(() => ({
      json: {
        user: { emailAddress: 'me@example.com' },
        rootId: 'ROOT',
        storageQuota: { usage: '1' },
      },
    }));
    const backend = makeBackend(fetchImpl);
    const info = await backend.about();
    assert.equal(info.user.emailAddress, 'me@example.com');
    assert.equal(fetchImpl.requests[0].url.pathname, '/drive/v3/about');
  });

  it('getNode は 404 を null に変換する', async () => {
    const fetchImpl = mockFetch(() => ({
      status: 404,
      json: { error: { message: 'not found' } },
    }));
    const backend = makeBackend(fetchImpl);
    assert.equal(await backend.getNode('missing'), null);
  });

  it('resolveRootId は未指定なら about から取得する', async () => {
    const fetchImpl = mockFetch(() => ({ json: { rootId: 'REAL-ROOT' } }));
    const backend = new GoogleDriveBackend({
      tokenProvider: new StaticTokenProvider({ accessToken: 't' }),
      fetchImpl,
      baseDelayMs: 1,
    });
    assert.equal(backend.rootId(), 'root');
    assert.equal(await backend.resolveRootId(), 'REAL-ROOT');
  });
});


describe('GoogleDriveBackend 空内容と異常応答', () => {
  it('空の内容でも multipart で送って切り詰める', async () => {
    const fetchImpl = mockFetch(() => ({ json: FILE_JSON }));
    const backend = makeBackend(fetchImpl);
    await backend.updateFile({ id: 'file-1', content: Buffer.alloc(0) });
    const request = fetchImpl.requests[0];
    assert.equal(request.url.pathname, '/upload/drive/v3/files/file-1');
    assert.equal(request.url.searchParams.get('uploadType'), 'multipart');
  });

  it('emptyUploadStrategy: metadata-only なら本文を送らない', async () => {
    const fetchImpl = mockFetch(() => ({ json: FILE_JSON }));
    const backend = makeBackend(fetchImpl, { emptyUploadStrategy: 'metadata-only' });
    await backend.updateFile({ id: 'file-1', content: Buffer.alloc(0) });
    assert.equal(fetchImpl.requests[0].url.pathname, '/drive/v3/files/file-1');
  });

  it('200 でも壊れた JSON なら ApiError にする', async () => {
    const backend = makeBackend(async () => new Response('not json', { status: 200 }));
    await assert.rejects(
      () => backend.listChildren('ROOT'),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 200);
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });

  it('401 は 1 回だけ再試行して打ち切る', async () => {
    let invalidated = 0;
    const provider = new StaticTokenProvider({ accessToken: 'bad' });
    provider.invalidate = () => {
      invalidated += 1;
    };
    const fetchImpl = mockFetch(() => ({
      status: 401,
      json: { error: { message: 'invalid credentials' } },
    }));
    const backend = new GoogleDriveBackend({
      tokenProvider: provider,
      rootFolderId: 'ROOT',
      fetchImpl,
      baseDelayMs: 1,
      maxRetries: 4,
    });
    await assert.rejects(() => backend.listChildren('ROOT'), (error) => error.status === 401);
    assert.equal(invalidated, 1);
    assert.equal(fetchImpl.requests.length, 2);
  });
});

describe('GoogleDriveBackend リトライとエラー', () => {
  it('429 のあと成功する (Retry-After を尊重)', async () => {
    const fetchImpl = mockFetch((request) =>
      request.index === 0
        ? {
            status: 429,
            json: { error: { message: 'rate limited' } },
            headers: { 'retry-after': '0' },
          }
        : { json: { files: [FILE_JSON] } },
    );
    const backend = makeBackend(fetchImpl);
    const { nodes } = await backend.listChildren('ROOT');
    assert.equal(nodes.length, 1);
    assert.equal(backend.stats.retries, 1);
    assert.equal(fetchImpl.requests.length, 2);
  });

  it('5xx はリトライし、上限で ApiError になる', async () => {
    const fetchImpl = mockFetch(() => ({
      status: 503,
      json: { error: { message: 'backend error', errors: [{ reason: 'backendError' }] } },
    }));
    const backend = makeBackend(fetchImpl, { maxRetries: 3 });
    await assert.rejects(
      () => backend.listChildren('ROOT'),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 503);
        assert.equal(error.reason, 'backendError');
        assert.equal(error.retryable, true);
        return true;
      },
    );
    assert.equal(fetchImpl.requests.length, 3);
  });

  it('401 はトークンを捨てて 1 度だけ再試行する', async () => {
    let invalidated = 0;
    const provider = new StaticTokenProvider({ accessToken: 'stale' });
    provider.invalidate = () => {
      invalidated += 1;
    };
    const fetchImpl = mockFetch((request) =>
      request.index === 0
        ? { status: 401, json: { error: { message: 'invalid credentials' } } }
        : { json: { files: [] } },
    );
    const backend = new GoogleDriveBackend({
      tokenProvider: provider,
      rootFolderId: 'ROOT',
      fetchImpl,
      baseDelayMs: 1,
    });
    const result = await backend.listChildren('ROOT');
    assert.deepEqual(result.nodes, []);
    assert.equal(invalidated, 1);
  });

  it('403 のような恒久エラーは即座に投げる', async () => {
    const fetchImpl = mockFetch(() => ({
      status: 403,
      json: {
        error: { message: 'insufficient permissions', errors: [{ reason: 'forbidden' }] },
      },
    }));
    const backend = makeBackend(fetchImpl);
    await assert.rejects(
      () => backend.listChildren('ROOT'),
      (error) => error.status === 403 && error.retryable === false,
    );
    assert.equal(fetchImpl.requests.length, 1);
  });

  it('ネットワーク例外もリトライする', async () => {
    let attempts = 0;
    const backend = makeBackend(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('ECONNRESET');
      return new Response(JSON.stringify({ files: [FILE_JSON] }), { status: 200 });
    });
    const { nodes } = await backend.listChildren('ROOT');
    assert.equal(nodes.length, 1);
    assert.equal(attempts, 2);
  });
});

describe('multipart ボディ', () => {
  it('メタデータと本体を含み、boundary で閉じる', () => {
    const { body, contentType } = buildMultipartBody(
      { name: 'x.txt' },
      Buffer.from('DATA'),
      'text/plain',
    );
    const text = body.toString('utf8');
    const boundary = /boundary=(.+)$/.exec(contentType)[1];
    assert.ok(text.startsWith(`--${boundary}\r\n`));
    assert.match(text, /content-type: application\/json/);
    assert.match(text, /"name":"x\.txt"/);
    assert.match(text, /content-type: text\/plain/);
    assert.ok(text.includes('DATA'));
    assert.ok(text.trimEnd().endsWith(`--${boundary}--`));
  });

  it('内容が空でもメタデータ部だけは作る', () => {
    const { body } = buildMultipartBody({ name: 'empty' }, null);
    assert.match(body.toString('utf8'), /"name":"empty"/);
  });

  it('normalizeNode は欠損フィールドを補う', () => {
    const node = normalizeNode({ id: 'i', name: 'n', mimeType: 'text/plain' });
    assert.deepEqual(node.parents, []);
    assert.equal(node.trashed, false);
    assert.equal(normalizeNode(null), null);
  });
});

