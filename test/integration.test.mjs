// 端到端：拿一个本地目录当"手机"，跑完整 run / dry 流程。
// 核心断言：--since 2027-01-01 时，只搬 2027 年的照片，2026 年的一个都不动；重跑幂等。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runSync } from '../src/sync.mjs';

const BASE = path.join(process.cwd(), '_test_out', `it-${Date.now()}`);

test.after(async () => {
  await fsp.rm(BASE, { recursive: true, force: true }).catch(() => {});
});

async function makeFixture() {
  const phone = path.join(BASE, 'phone');
  const camera = path.join(phone, 'DCIM', 'Camera');
  await fsp.mkdir(camera, { recursive: true });
  const specs = [
    ['IMG20260901181943.heic', '2026-09-01T18:19:43'],
    ['IMG20261003120000.heic', '2026-10-03T12:00:00'],
    ['IMG20261231235959.heic', '2026-12-31T23:59:59'],
    ['IMG20270101000000.heic', '2027-01-01T00:00:00'],
    ['IMG20270305101010.heic', '2027-03-05T10:10:10'],
    ['IMG20270701080000.heic', '2027-07-01T08:00:00'],
  ];
  for (const [name, iso] of specs) {
    const p = path.join(camera, name);
    await fsp.writeFile(p, Buffer.alloc(3000, name.charCodeAt(20) || 65));
    const t = new Date(iso);
    await fsp.utimes(p, t, t);
  }
  return { phone, camera };
}

async function run(dir, extra = {}) {
  return runSync({
    _: ['run'],
    'source-dir': dir.phone,
    root: path.join(dir.root),
    state: path.join(dir.root, 'state.json'),
    reports: path.join(dir.root, 'reports'),
    logs: path.join(dir.root, 'logs'),
    cloud: 'off',
    yes: true,
    'no-open': true,
    quiet: true,
    ...extra,
  });
}

test('dry：只出清单，硬盘一个字节都不动', async () => {
  const dir = { root: path.join(BASE, 'dry') };
  const fx = await makeFixture();
  const res = await runSync(
    {
      _: ['dry'],
      'source-dir': fx.phone,
      root: dir.root,
      state: path.join(dir.root, 'state.json'),
      reports: path.join(dir.root, 'reports'),
      logs: path.join(dir.root, 'logs'),
      cloud: 'off',
      since: '2027-01-01',
      'no-open': true,
      quiet: true,
    },
    { command: 'dry' },
  );
  assert.equal(res.exitCode, 0);
  assert.equal(res.summary.count, 3, '2027 年应有 3 张');
  assert.equal(fs.existsSync(path.join(dir.root, 'Camera')), false, 'dry 模式不该创建任何目录');
});

test('--since 2027-01-01：只搬 2027 年的，2026 年的一张不碰', async () => {
  const dir = { root: path.join(BASE, 'run1'), phone: path.join(BASE, 'run1-phone') };
  // 独立 fixture，避免与 dry 用例互相干扰
  const camera = path.join(dir.phone, 'DCIM', 'Camera');
  await fsp.mkdir(camera, { recursive: true });
  const oldOnes = ['IMG20260901181943.heic', 'IMG20261003120000.heic', 'IMG20261231235959.heic'];
  const newOnes = ['IMG20270101000000.heic', 'IMG20270305101010.heic', 'IMG20270701080000.heic'];
  for (const name of [...oldOnes, ...newOnes]) {
    const p = path.join(camera, name);
    await fsp.writeFile(p, Buffer.alloc(3000, 65));
    const t = new Date(`${name.slice(3, 7)}-${name.slice(7, 9)}-${name.slice(9, 11)}T${name.slice(11, 13)}:${name.slice(13, 15)}:${name.slice(15, 17)}`);
    await fsp.utimes(p, t, t);
  }

  const res = await run(dir, { since: '2027-01-01' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.summary.count, 3);
  assert.equal(res.copied, 3);

  const outDir = path.join(dir.root, 'Camera');
  const got = (await fsp.readdir(outDir)).sort();
  assert.deepEqual(got, newOnes, '硬盘上只应该有 2027 的三张');

  const skipped = res.plan.skip.map((s) => s.name);
  for (const name of oldOnes) assert.ok(skipped.includes(name), `${name} 应出现在跳过清单里`);
});

test('幂等：紧接着再跑一次 → 新增 0', async () => {
  const dir = { root: path.join(BASE, 'run2'), phone: path.join(BASE, 'run2-phone') };
  const camera = path.join(dir.phone, 'DCIM', 'Camera');
  await fsp.mkdir(camera, { recursive: true });
  const p = path.join(camera, 'IMG20270305101010.heic');
  await fsp.writeFile(p, Buffer.alloc(3000, 66));

  const r1 = await run(dir, { since: '2027-01-01' });
  assert.equal(r1.copied, 1);

  const r2 = await run(dir, { since: '2027-01-01' });
  assert.equal(r2.summary.count, 0);
  assert.equal(r2.copied, 0);
  assert.equal(r2.plan.skip[0].code, 'already-synced');
});

test('落盘后保留手机端修改时间', async () => {
  const dir = { root: path.join(BASE, 'run3'), phone: path.join(BASE, 'run3-phone') };
  const camera = path.join(dir.phone, 'DCIM', 'Camera');
  await fsp.mkdir(camera, { recursive: true });
  const p = path.join(camera, 'IMG20270305101010.heic');
  await fsp.writeFile(p, Buffer.alloc(3000, 67));
  const t = new Date('2027-03-05T10:10:10');
  await fsp.utimes(p, t, t);

  await run(dir, { since: '2027-01-01' });
  const out = path.join(dir.root, 'Camera', 'IMG20270305101010.heic');
  const st = await fsp.stat(out);
  assert.ok(Math.abs(st.mtimeMs - t.getTime()) < 2000, `mtime 应被还原，实际 ${new Date(st.mtimeMs).toISOString()}`);
});

test('没有区间时全都要（含 2026）', async () => {
  const dir = { root: path.join(BASE, 'run4'), phone: path.join(BASE, 'run4-phone') };
  const camera = path.join(dir.phone, 'DCIM', 'Camera');
  await fsp.mkdir(camera, { recursive: true });
  for (const name of ['IMG20260901181943.heic', 'IMG20270101000000.heic']) {
    await fsp.writeFile(path.join(camera, name), Buffer.alloc(3000, 68));
  }
  const res = await run(dir, {});
  assert.equal(res.summary.count, 2);
});

test('--years 2027 等价于 2027 全区间', async () => {
  const dir = { root: path.join(BASE, 'run5'), phone: path.join(BASE, 'run5-phone') };
  const camera = path.join(dir.phone, 'DCIM', 'Camera');
  await fsp.mkdir(camera, { recursive: true });
  for (const name of ['IMG20261231235959.heic', 'IMG20270101000000.heic']) {
    await fsp.writeFile(path.join(camera, name), Buffer.alloc(3000, 69));
  }
  const res = await run(dir, { years: '2027' });
  assert.equal(res.summary.count, 1);
});
