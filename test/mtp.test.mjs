// MTP 通道的单元测试：只测纯逻辑（路径解析、协议封装、adb→MTP 自动降级）。
// 真正连手机的部分要手动跑（tools/mtp-bridge.ps1 probe），这里不依赖硬件。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { toSegments, findBridge, createMtpSource, MtpError } from '../src/sources/mtp.mjs';
import { openPhoneSource, SourceError } from '../src/sources/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('toSegments: 把远程路径切成 MTP 需要的层级', () => {
  assert.deepEqual(toSegments('/sdcard/DCIM/Camera'), ['DCIM', 'Camera']);
  assert.deepEqual(toSegments('/sdcard/DCIM/Camera/'), ['DCIM', 'Camera']);
  assert.deepEqual(toSegments('/sdcard'), []);
  assert.deepEqual(toSegments('/sdcard/'), []);
  assert.deepEqual(toSegments(''), []);
  assert.deepEqual(toSegments(null), []);
  assert.deepEqual(toSegments('\\sdcard\\Pictures\\WeiXin'), ['Pictures', 'WeiXin']);
  assert.deepEqual(toSegments('/sdcard/DCIM/多的'), ['DCIM', '多的']);
  assert.deepEqual(toSegments('/SDCARD/DCIM'), ['DCIM']);
});

test('findBridge: 能找到项目里的 mtp-bridge.ps1', () => {
  const found = findBridge();
  assert.ok(found, '应该找得到 tools/mtp-bridge.ps1');
  assert.ok(fs.existsSync(found));
  assert.equal(path.basename(found), 'mtp-bridge.ps1');
});

test('findBridge: 显式路径优先，不存在时回退', () => {
  const real = path.join(HERE, '..', 'tools', 'mtp-bridge.ps1');
  assert.equal(findBridge(real), path.resolve(real));
  const fallback = findBridge('C:\\definitely\\not\\here.ps1');
  assert.ok(fallback && fs.existsSync(fallback));
});

test('createMtpSource: 接口形状和 adb 一致', () => {
  const s = createMtpSource();
  assert.equal(s.kind, 'mtp');
  assert.equal(s.transport, 'mtp');
  for (const fn of ['describe', 'list', 'listEntries', 'fetchTo', 'copyMany', 'listMany']) {
    assert.equal(typeof s[fn], 'function', `缺少 ${fn}`);
  }
});

test('MtpError: 带 code / stage / hint', () => {
  const e = new MtpError('no device', { code: 'NO_DEVICE', stage: 'no-device', hint: '插线' });
  assert.equal(e.code, 'NO_DEVICE');
  assert.equal(e.stage, 'no-device');
  assert.equal(e.hint, '插线');
});

function fakeAdb(fail = true) {
  return {
    kind: 'adb',
    async describe() {
      if (fail) throw new SourceError('没有检测到手机', { code: 'NO_DEVICE', hint: '开 USB 调试' });
      return { label: '手机 X（adb 已授权）' };
    },
  };
}

function fakeMtp({ fail = false } = {}) {
  return {
    kind: 'mtp',
    transport: 'mtp',
    async describe() {
      if (fail) throw new MtpError('MTP 也没看到设备', { code: 'NO_DEVICE', hint: '选传输文件' });
      return { label: '手机 X（MTP 文件传输）', transport: 'mtp' };
    },
  };
}

test('openPhoneSource: adb 通了就用 adb', async () => {
  const r = await openPhoneSource(
    { phone: { transport: 'auto' } },
    { adbFactory: () => fakeAdb(false), mtpFactory: () => fakeMtp() },
  );
  assert.equal(r.transport, 'adb');
  assert.match(r.info.label, /adb/);
});

test('openPhoneSource: adb 看不到设备时自动退到 MTP', async () => {
  const r = await openPhoneSource(
    { phone: { transport: 'auto' } },
    { adbFactory: () => fakeAdb(true), mtpFactory: () => fakeMtp() },
  );
  assert.equal(r.transport, 'mtp');
  assert.match(r.info.label, /MTP/);
  assert.ok(r.adbError, '应该把 adb 的原始错误带上，方便界面解释');
  assert.equal(r.adbError.code, 'NO_DEVICE');
});

test('openPhoneSource: 两条通道都失败 → 报错里两边原因都有', async () => {
  await assert.rejects(
    () =>
      openPhoneSource(
        { phone: { transport: 'auto' } },
        { adbFactory: () => fakeAdb(true), mtpFactory: () => fakeMtp({ fail: true }) },
      ),
    (err) => {
      assert.ok(err instanceof SourceError);
      assert.match(err.message, /没有检测到手机/);
      assert.match(err.hint, /开 USB 调试/);
      assert.match(err.hint, /MTP 通道也没成功/);
      return true;
    },
  );
});

test('openPhoneSource: transport=adb 时不做降级（用户明确指定）', async () => {
  await assert.rejects(
    () =>
      openPhoneSource(
        { phone: { transport: 'adb' } },
        { adbFactory: () => fakeAdb(true), mtpFactory: () => fakeMtp() },
      ),
    /没有检测到手机/,
  );
});

test('openPhoneSource: transport=mtp 时直接用 MTP', async () => {
  let adbCalled = false;
  const r = await openPhoneSource(
    { phone: { transport: 'mtp' } },
    {
      adbFactory: () => {
        adbCalled = true;
        return fakeAdb(true);
      },
      mtpFactory: () => fakeMtp(),
    },
  );
  assert.equal(r.transport, 'mtp');
  assert.equal(adbCalled, false, '指定 MTP 就不该去碰 adb');
});
