// 目标开关：只导硬盘 / 只传 123 云盘 / 两边都导
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runSync, resolveTargets, targetLabelOf } from '../src/sync.mjs';
import { buildPlan } from '../src/plan.mjs';
import { makeFilter } from '../src/filter.mjs';
import { StateStore, recordKey } from '../src/state.mjs';
import { startMock123 } from './mock-123.mjs';

const BASE = path.join(process.cwd(), '_test_out', `target-${Date.now()}`);
test.after(async () => {
  await fsp.rm(BASE, { recursive: true, force: true }).catch(() => {});
});

function item(over = {}) {
  return {
    sourceId: 'camera',
    remote: '/sdcard/DCIM/Camera/IMG20270101093000.heic',
    relPath: 'IMG20270101093000.heic',
    name: 'IMG20270101093000.heic',
    size: 2048,
    mtimeMs: new Date('2027-01-01T09:30:00').getTime(),
    targetSubdir: 'Camera',
    date: new Date('2027-01-01T09:30:00'),
    confidence: 'filename',
    ...over,
  };
}

function planCfg(root) {
  return { local: { root, collision: 'skip' }, phone: { enabledSources: [] }, cloud: { mode: 'open123' } };
}

test('目标解析：三种选择 + 别名', () => {
  assert.deepEqual(resolveTargets({ target: 'disk' }, { run: {} }), { disk: true, cloud: false });
  assert.deepEqual(resolveTargets({ target: 'cloud' }, { run: {} }), { disk: false, cloud: true });
  assert.deepEqual(resolveTargets({ target: 'both' }, { run: {} }), { disk: true, cloud: true });
  assert.deepEqual(resolveTargets({ target: '1' }, { run: {} }), { disk: true, cloud: false });
  assert.deepEqual(resolveTargets({ target: '3' }, { run: {} }), { disk: false, cloud: true });
  assert.deepEqual(resolveTargets({ to: 'hdd' }, { run: {} }), { disk: true, cloud: false });
  assert.deepEqual(resolveTargets({}, { run: { target: 'cloud' } }), { disk: false, cloud: true });
  assert.deepEqual(resolveTargets({}, { run: {} }), { disk: true, cloud: true });
  assert.throws(() => resolveTargets({ target: 'usb' }, { run: {} }), /目标只能填/);
});

test('目标文案', () => {
  assert.match(targetLabelOf({ disk: true, cloud: false }, 'open123'), /仅硬盘/);
  assert.match(targetLabelOf({ disk: false, cloud: true }, 'open123'), /仅 123 云盘/);
  assert.match(targetLabelOf({ disk: true, cloud: true }, 'handoff'), /硬盘 \+ 123 云盘/);
});

test('计划层：只传云盘时不需要落盘', () => {
  const root = path.join(BASE, 'p1');
  const state = new StateStore(path.join(root, 'state.json'));
  const plan = buildPlan({
    items: [item()],
    filter: makeFilter({}),
    state,
    cfg: planCfg(root),
    targets: { disk: false, cloud: true },
  });
  assert.equal(plan.copy.length, 1);
  assert.equal(plan.copy[0].needCloud, true);
  assert.equal(plan.copy[0].needDisk, false);
});

test('计划层：只导硬盘时不需要上云', () => {
  const root = path.join(BASE, 'p2');
  const state = new StateStore(path.join(root, 'state.json'));
  const plan = buildPlan({
    items: [item()],
    filter: makeFilter({}),
    state,
    cfg: planCfg(root),
    targets: { disk: true, cloud: false },
  });
  assert.equal(plan.copy[0].needDisk, true);
  assert.equal(plan.copy[0].needCloud, false);
});

test('计划层：云盘已有记录 → 只传云盘时应跳过', () => {
  const root = path.join(BASE, 'p3');
  const state = new StateStore(path.join(root, 'state.json'));
  const it = item();
  state.setRecord(recordKey(it.sourceId, it.remote), { size: it.size, cloudFileID: 888, onDisk: false });
  const plan = buildPlan({
    items: [it],
    filter: makeFilter({}),
    state,
    cfg: planCfg(root),
    targets: { disk: false, cloud: true },
  });
  assert.equal(plan.copy.length, 0);
  assert.equal(plan.skip[0].code, 'already-synced');
});

test('计划层：盘上有、云上没有 → 两边都要时应只补上云', () => {
  const root = path.join(BASE, 'p4');
  const it = item();
  const target = path.join(root, 'Camera', it.name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(it.size));
  const state = new StateStore(path.join(root, 'state.json'));
  const plan = buildPlan({
    items: [it],
    filter: makeFilter({}),
    state,
    cfg: planCfg(root),
    targets: { disk: true, cloud: true },
  });
  assert.equal(plan.copy.length, 1);
  assert.equal(plan.copy[0].needDisk, false, '盘上已有，不该重拷');
  assert.equal(plan.copy[0].needCloud, true, '云上没有，应该补传');
});

/* ------------------------- 端到端（配假 123 服务器） ------------------------- */

async function makePhone(dir, names) {
  const cam = path.join(dir, 'DCIM', 'Camera');
  await fsp.mkdir(cam, { recursive: true });
  for (const n of names) {
    await fsp.writeFile(path.join(cam, n), Buffer.alloc(4096, 70));
  }
  return path.join(dir);
}

function argsFor({ phone, root, cloud = 'open123', target, extra = {} }) {
  return {
    _: ['run'],
    'source-dir': phone,
    root,
    state: path.join(root, 'state.json'),
    reports: path.join(root, 'reports'),
    logs: path.join(root, 'logs'),
    'staging-dir': path.join(root, 'staging'),
    cloud,
    target,
    yes: true,
    'no-open': true,
    quiet: true,
    ...extra,
  };
}

test('端到端：只导硬盘 → 文件落盘、云盘零请求', async (t) => {
  const mock = await startMock123({ sliceSize: 1 << 20 });
  t.after(() => mock.close());
  const dir = path.join(BASE, 'e2e-disk');
  const phone = await makePhone(path.join(dir, 'phone'), ['IMG20270101000000.heic', 'IMG20270305101010.heic']);

  const res = await runSync(
    argsFor({
      phone,
      root: path.join(dir, 'root'),
      target: 'disk',
      extra: { 'cloud-url': mock.baseURL, 'cloud-id': 'cid', 'cloud-secret': 'sec' },
    }),
  );
  assert.equal(res.exitCode, 0);
  assert.equal(res.copied, 2);
  assert.equal(fs.readdirSync(path.join(dir, 'root', 'Camera')).length, 2);
  assert.equal(mock.state.creates.length, 0, '只导硬盘时不该向云盘发任何上传请求');
  assert.equal(mock.state.tokenCalls, 0, '连 token 都不该去换');
});

test('端到端：只传云盘 → 硬盘不存在、云盘收到 2 个文件', async (t) => {
  const mock = await startMock123({ sliceSize: 1 << 20 });
  t.after(() => mock.close());
  const dir = path.join(BASE, 'e2e-cloud');
  const phone = await makePhone(path.join(dir, 'phone'), ['IMG20270101000000.heic', 'IMG20270305101010.heic']);
  const root = path.join(dir, 'root');

  const res = await runSync(
    argsFor({
      phone,
      root,
      target: 'cloud',
      extra: { 'cloud-url': mock.baseURL, 'cloud-id': 'cid', 'cloud-secret': 'sec' },
    }),
  );
  assert.equal(res.exitCode, 0);
  assert.equal(res.uploaded, 2);
  assert.equal(mock.state.creates.length, 2);
  assert.equal(fs.existsSync(path.join(root, 'Camera')), false, '只传云盘时不该在硬盘上建目录');

  // 再跑一次：云盘已有记录 → 0 个
  const again = await runSync(
    argsFor({
      phone,
      root,
      target: 'cloud',
      extra: { 'cloud-url': mock.baseURL, 'cloud-id': 'cid', 'cloud-secret': 'sec' },
    }),
  );
  assert.equal(again.summary.count, 0);
  assert.equal(mock.state.creates.length, 2, '第二次不该重复上传');
});

test('端到端：两边都导 → 硬盘有、云盘也有', async (t) => {
  const mock = await startMock123({ sliceSize: 1 << 20 });
  t.after(() => mock.close());
  const dir = path.join(BASE, 'e2e-both');
  const phone = await makePhone(path.join(dir, 'phone'), ['IMG20270101000000.heic']);
  const root = path.join(dir, 'root');

  const res = await runSync(
    argsFor({
      phone,
      root,
      target: 'both',
      extra: { 'cloud-url': mock.baseURL, 'cloud-id': 'cid', 'cloud-secret': 'sec' },
    }),
  );
  assert.equal(res.copied, 1);
  assert.equal(res.uploaded, 1);
  assert.equal(fs.readdirSync(path.join(root, 'Camera')).length, 1);
  assert.equal(mock.state.creates.length, 1);
});

test('T1 交管档位不能只传云盘 → 明确报错', async () => {
  const dir = path.join(BASE, 'e2e-handoff');
  const phone = await makePhone(path.join(dir, 'phone'), ['IMG20270101000000.heic']);
  await assert.rejects(
    () => runSync(argsFor({ phone, root: path.join(dir, 'root'), cloud: 'handoff', target: 'cloud' })),
    /不能只传云盘不要硬盘/,
  );
});
