import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildPlan, summarize } from '../src/plan.mjs';
import { makeFilter } from '../src/filter.mjs';
import { StateStore, recordKey } from '../src/state.mjs';

const BASE = path.join(process.cwd(), '_test_out', `plan-${process.pid}`);

function makeCfg(root) {
  return {
    local: { root, collision: 'skip' },
    phone: { enabledSources: [] },
    cloud: { mode: 'off' },
  };
}

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
    basis: 'name:yyyymmddhhmmss',
    ...over,
  };
}

test.before(async () => {
  await fsp.mkdir(BASE, { recursive: true });
});

test.after(async () => {
  await fsp.rm(BASE, { recursive: true, force: true }).catch(() => {});
});

test('全新文件 → 进复制清单', async () => {
  const root = path.join(BASE, 'case1');
  await fsp.mkdir(root, { recursive: true });
  const state = new StateStore(path.join(root, 'state.json'));
  const plan = buildPlan({ items: [item()], filter: makeFilter({}), state, cfg: makeCfg(root) });
  assert.equal(plan.copy.length, 1);
  assert.equal(plan.skip.length, 0);
  assert.equal(plan.copy[0].targetPath, path.join(root, 'Camera', 'IMG20270101093000.heic'));
});

test('状态库已记录 → 跳过（幂等的基础）', async () => {
  const root = path.join(BASE, 'case2');
  await fsp.mkdir(root, { recursive: true });
  const state = new StateStore(path.join(root, 'state.json'));
  const it = item();
  state.setRecord(recordKey(it.sourceId, it.remote), { size: it.size, localPath: 'x' });
  const plan = buildPlan({ items: [it], filter: makeFilter({}), state, cfg: makeCfg(root) });
  assert.equal(plan.copy.length, 0);
  assert.equal(plan.skip[0].code, 'already-synced');
});

test('硬盘已有同大小文件 → 跳过并补记录（外部拷入的）', async () => {
  const root = path.join(BASE, 'case3');
  const target = path.join(root, 'Camera', 'IMG20270101093000.heic');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, Buffer.alloc(2048));
  const state = new StateStore(path.join(root, 'state.json'));
  const it = item();
  const plan = buildPlan({ items: [it], filter: makeFilter({}), state, cfg: makeCfg(root) });
  assert.equal(plan.copy.length, 0);
  assert.equal(plan.skip[0].code, 'exists');
  assert.ok(state.getRecord(recordKey(it.sourceId, it.remote)).adopted);
});

test('同名但大小不同 → 冲突，默认不覆盖', async () => {
  const root = path.join(BASE, 'case4');
  const target = path.join(root, 'Camera', 'IMG20270101093000.heic');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, Buffer.alloc(100));
  const state = new StateStore(path.join(root, 'state.json'));
  const plan = buildPlan({ items: [item()], filter: makeFilter({}), state, cfg: makeCfg(root) });
  assert.equal(plan.copy.length, 0);
  assert.equal(plan.skip[0].code, 'conflict');
  assert.equal(plan.conflicts.length, 1);
  // 原文件一个字节都没被改
  assert.equal(fs.statSync(target).size, 100);
});

test('同名冲突 + rename 策略 → 自动改名复制', async () => {
  const root = path.join(BASE, 'case5');
  const target = path.join(root, 'Camera', 'IMG20270101093000.heic');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, Buffer.alloc(100));
  const state = new StateStore(path.join(root, 'state.json'));
  const cfg = makeCfg(root);
  cfg.local.collision = 'rename';
  const plan = buildPlan({ items: [item()], filter: makeFilter({}), state, cfg });
  assert.equal(plan.copy.length, 1);
  assert.match(path.basename(plan.copy[0].targetPath), /\(2\)\.heic$/);
});

test('被区间筛掉的不进清单', async () => {
  const root = path.join(BASE, 'case6');
  await fsp.mkdir(root, { recursive: true });
  const state = new StateStore(path.join(root, 'state.json'));
  const old = item({ date: new Date('2026-09-01T18:19:43') });
  const plan = buildPlan({
    items: [old],
    filter: makeFilter({ since: new Date('2027-01-01T00:00:00') }),
    state,
    cfg: makeCfg(root),
  });
  assert.equal(plan.copy.length, 0);
  assert.equal(plan.skip[0].code, 'before');
});

test('汇总：按目录、按天、按时间依据', async () => {
  const root = path.join(BASE, 'case7');
  await fsp.mkdir(root, { recursive: true });
  const state = new StateStore(path.join(root, 'state.json'));
  const sources = [
    { id: 'camera', remote: '/sdcard/DCIM/Camera', targetSubdir: 'Camera' },
    { id: 'weixin', remote: '/sdcard/Pictures/WeiXin', targetSubdir: 'WeiXin' },
  ];
  const items = [
    item(),
    item({ remote: '/sdcard/DCIM/Camera/b.heic', relPath: 'b.heic', name: 'b.heic', date: new Date('2027-03-05T10:00:00') }),
    item({
      sourceId: 'weixin',
      remote: '/sdcard/Pictures/WeiXin/c.jpg',
      relPath: 'c.jpg',
      name: 'c.jpg',
      date: new Date('2027-03-05T11:00:00'),
    }),
  ];
  const plan = buildPlan({ items, filter: makeFilter({}), state, cfg: { ...makeCfg(root), phone: { enabledSources: sources } } });
  const summary = summarize(plan, sources);
  assert.equal(summary.count, 3);
  assert.equal(summary.sources.find((s) => s.id === 'camera').add, 2);
  assert.equal(summary.sources.find((s) => s.id === 'weixin').add, 1);
  assert.equal(summary.byDay.get('2027-03-05'), 2);
  assert.equal(summary.byDay.get('2027-01-01'), 1);
});
