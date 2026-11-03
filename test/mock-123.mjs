// 本地假的 123 开放平台服务器：让测试不需要真账号、不联网。
import http from 'node:http';

export function startMock123({ sliceSize = 4 } = {}) {
  const state = {
    tokenCalls: 0,
    mkdirCalls: [],
    creates: [],
    parts: [],
    completeCalls: 0,
    dirId: 100,
    existingMd5: new Set(),
    files: [],
    sliceSize,
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const text = body.toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');

    const json = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'PUT' && url.pathname.startsWith('/put/')) {
      state.parts.push({ key: url.pathname, size: body.length });
      res.writeHead(200);
      res.end('ok');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/v2/file/list') {
      const parent = Number(url.searchParams.get('parentFileId') || 0);
      const fileList = state.files
        .filter((f) => f.parentFileId === parent)
        .map((f) => ({ fileID: f.fileID, filename: f.filename, type: 1 }));
      return json({ code: 0, data: { lastFileId: -1, fileList } });
    }

    if (url.pathname === '/api/v1/access_token') {
      state.tokenCalls += 1;
      if (!text.includes('clientID')) return json({ code: 400, message: 'bad body' });
      return json({
        code: 0,
        data: { accessToken: 'tok-abc', expiredAt: new Date(Date.now() + 86400_000).toISOString() },
      });
    }

    if (url.pathname === '/upload/v1/file/mkdir') {
      const parsed = JSON.parse(text || '{}');
      state.mkdirCalls.push(parsed);
      state.dirId += 1;
      state.files.push({ fileID: state.dirId, filename: parsed.name, parentFileId: parsed.parentID });
      return json({ code: 0, data: { dirID: state.dirId } });
    }

    if (url.pathname === '/upload/v1/file/create') {
      const parsed = JSON.parse(text || '{}');
      state.creates.push(parsed);
      if (state.existingMd5.has(parsed.etag)) {
        return json({ code: 0, data: { reuse: true, fileID: 777 } });
      }
      return json({ code: 0, data: { reuse: false, preuploadID: `p-${state.creates.length}`, sliceSize: state.sliceSize } });
    }

    if (url.pathname === '/upload/v1/file/get_upload_url') {
      const parsed = JSON.parse(text || '{}');
      return json({
        code: 0,
        data: {
          presignedURL: `http://127.0.0.1:${server.address().port}/put/${parsed.preuploadID}/${parsed.sliceNo}`,
        },
      });
    }

    if (url.pathname === '/upload/v1/file/list_upload_parts') {
      return json({ code: 0, data: { parts: state.parts.map((p, i) => ({ partNumber: i + 1, size: p.size })) } });
    }

    if (url.pathname === '/upload/v1/file/upload_complete') {
      state.completeCalls += 1;
      return json({ code: 0, data: { async: false, completed: true, fileID: 888 } });
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 404, message: `no route ${url.pathname}` }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const baseURL = `http://127.0.0.1:${server.address().port}`;
      resolve({
        server,
        state,
        baseURL,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
