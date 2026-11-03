// 用本地假服务器验证 123 开放平台客户端（不联网、不需要真账号）
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Open123Client } from '../src/cloud/open123.mjs';
import { startMock123 } from './mock-123.mjs';

test('123 开放平台客户端：换 token / 建目录 / 分片上传 / 秒传', async (t) => {
  const mock = await startMock123();
  const { server, state, baseURL } = mock;
  t.after(async () => {
    await mock.close();
  });

  const tmp = path.join(process.cwd(), '_test_out', `cloud-${process.pid}`);
  await fsp.mkdir(tmp, { recursive: true });
  t.after(async () => {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const localFile = path.join(tmp, 'a.heic');
  await fsp.writeFile(localFile, Buffer.from('0123456789')); // 10 字节，sliceSize=4 → 3 片

  const client = new Open123Client({
    baseURL,
    clientId: 'cid',
    clientSecret: 'csecret',
    duplicate: 1,
  });

  // 建目录链：/手机备份/Camera
  const dirId = await client.resolveDir('/手机备份/Camera');
  assert.ok(dirId > 100);
  assert.equal(state.mkdirCalls.length, 2);
  assert.deepEqual(
    state.mkdirCalls.map((c) => c.name),
    ['手机备份', 'Camera'],
  );

  // 上传（走分片）
  const r = await client.uploadFile({
    localPath: localFile,
    parentFileID: dirId,
    filename: 'a.heic',
    size: 10,
    md5: 'a-md5-not-known',
  });
  assert.equal(r.fileID, 888);
  assert.equal(r.reuse, false);
  assert.equal(state.parts.length, 3, '10 字节按 4 字节切片应为 3 片');
  assert.deepEqual(
    state.parts.map((p) => p.size),
    [4, 4, 2],
  );
  assert.equal(state.completeCalls, 1);
  assert.equal(state.creates[0].etag, 'a-md5-not-known');

  // token 只换一次
  assert.equal(state.tokenCalls, 1);
  await client.resolveDir('/手机备份');
  assert.equal(state.tokenCalls, 1, 'token 应被缓存复用');

  // 秒传
  state.existingMd5.add('known-md5');
  const r2 = await client.uploadFile({
    localPath: localFile,
    parentFileID: dirId,
    filename: 'a.heic',
    size: 10,
    md5: 'known-md5',
  });
  assert.equal(r2.reuse, true);
  assert.equal(r2.fileID, 777);

  assert.ok(server.listening);
});
