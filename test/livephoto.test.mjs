// 实况照片识别的单元测试：全部用合成文件，不碰真实照片库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { classifyLocalFile, classifyBytes, clearCache, isPhotoName } from '../src/photos/livePhoto.mjs';

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pb-live-'));

function box(type, payload) {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(8 + payload.length, 0);
  b.write(type, 4, 'latin1');
  payload.copy(b, 8);
  return b;
}

/** 造一段最小可用的 MP4：ftyp + moov + mdat */
function fakeMp4(bytes = 64) {
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2mp41', 'latin1')),
    box('moov', Buffer.alloc(8, 0)),
    box('mdat', Buffer.alloc(bytes, 7)),
  ]);
}

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff, 0xe1]);

function jpegWithXmp(xmp) {
  return Buffer.concat([JPEG_SOI, Buffer.from(xmp, 'latin1'), Buffer.from([0xff, 0xd9])]);
}

async function writeTmp(name, buf) {
  const p = path.join(tmpRoot, name);
  await fsp.writeFile(p, buf);
  return p;
}

test('普通 JPEG：没有身份标记 → none', async () => {
  const p = await writeTmp('plain.jpg', Buffer.concat([JPEG_SOI, Buffer.alloc(1000, 1), Buffer.from([0xff, 0xd9])]));
  const r = await classifyLocalFile(p);
  assert.equal(r.kind, 'none');
});

test('JPEG 带 MotionPhoto 声明 + 尾部真视频 → live', async () => {
  const mp4 = fakeMp4(128);
  const xmp = `<x:xmpmeta><rdf:Description Item:Semantic="MotionPhoto" Container:Directory=""><Item:Length="${mp4.length}"/></rdf:Description></x:xmpmeta>`;
  const p = await writeTmp('live.jpg', Buffer.concat([jpegWithXmp(xmp), Buffer.alloc(2000, 2), mp4]));
  const r = await classifyLocalFile(p);
  assert.equal(r.kind, 'live');
  assert.equal(r.marker, 'Item:Semantic="MotionPhoto"');
  assert.equal(r.videoLength, mp4.length);
  assert.equal(r.videoOffset, (await fsp.stat(p)).size - mp4.length);
});

test('声明长度大于文件大小 → declared-missing（视频被剥掉）', async () => {
  const xmp = `<rdf:Description Item:Semantic="MotionPhoto" Item:Length="999999"/>`;
  const p = await writeTmp('missing.jpg', jpegWithXmp(xmp));
  const r = await classifyLocalFile(p);
  assert.equal(r.kind, 'declared-missing');
});

test('声明了但偏移处不是 ftyp → declared-missing', async () => {
  const xmp = `<rdf:Description Item:Semantic="MotionPhoto" Item:Length="100"/>`;
  const p = await writeTmp('fake.jpg', Buffer.concat([jpegWithXmp(xmp), Buffer.alloc(400, 9)]));
  const r = await classifyLocalFile(p);
  assert.equal(r.kind, 'declared-missing');
});

test('小米旧版 MicroVideoOffset → live', async () => {
  const mp4 = fakeMp4(96);
  const xmp = `<rdf:Description MicroVideo="1" MicroVideoOffset="${mp4.length}"/>`;
  const p = await writeTmp('micro.mp4.jpg', Buffer.concat([jpegWithXmp(xmp), Buffer.alloc(500, 3), mp4]));
  const r = await classifyLocalFile(p);
  assert.equal(r.kind, 'live');
  assert.equal(r.videoLength, mp4.length);
});

test('HEIC：XMP 只在尾部 → 必须读尾部才能判成 live', async () => {
  const mp4 = fakeMp4(80);
  const head = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(16, 0),
    Buffer.alloc(4096, 5),
  ]);
  const xmp = Buffer.from(`<rdf:Description Item:Semantic="MotionPhoto" Item:Length="${mp4.length}"/>`, 'latin1');
  const p = await writeTmp('live.heic', Buffer.concat([head, Buffer.alloc(3000, 6), xmp, mp4]));
  const r = await classifyLocalFile(p);
  assert.equal(r.kind, 'live', 'HEIC 的 XMP 在尾部，漏读尾部就会判错');
});

test('华为/荣耀的 LIVE_ 尾标 → live（engine=huawei）', async () => {
  const videoLen = 200;
  const liveSize = videoLen + 20;
  const video = fakeMp4(videoLen);
  const tailMark = Buffer.from(`LIVE_${liveSize}\0\0\0\0\0`, 'latin1');
  const exif = Buffer.from('Exif\0\0HUAWEI P60 Pro\0', 'latin1');
  const p = await writeTmp(
    'hw.jpg',
    Buffer.concat([JPEG_SOI, exif, Buffer.alloc(800, 4), Buffer.from([0xff, 0xd9]), Buffer.alloc(40, 0), video, tailMark]),
  );
  const r = await classifyLocalFile(p);
  assert.equal(r.kind, 'live');
  assert.equal(r.engine, 'huawei');
});

test('苹果 ContentIdentifier：有同名 MOV → paired，没有 → declared-missing', async () => {
  const xmp = `<rdf:Description ContentIdentifier="ABC-123"/>`;
  const heicHead = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(64, 0)]);
  const p = await writeTmp('IMG_0001.heic', Buffer.concat([heicHead, Buffer.from(xmp, 'latin1'), Buffer.alloc(200, 1)]));
  const r1 = await classifyLocalFile(p);
  assert.equal(r1.kind, 'declared-missing');
  await writeTmp('IMG_0001.MOV', fakeMp4(32));
  clearCache();
  const r2 = await classifyLocalFile(p);
  assert.equal(r2.kind, 'paired');
  assert.ok(r2.pairedVideo && r2.pairedVideo.toLowerCase().endsWith('.mov'));
});

test('classifyBytes 支持注入 probe，长度对不上就不算 live', () => {
  const mp4 = fakeMp4(64);
  const head = Buffer.concat([jpegWithXmp(`<r Item:Semantic="MotionPhoto" Item:Length="${mp4.length}"/>`), mp4]);
  const ok = classifyBytes({ head, tail: Buffer.alloc(0), size: head.length, probe: () => mp4.slice(0, 12) });
  assert.equal(ok.kind, 'live');
  const bad = classifyBytes({ head, tail: Buffer.alloc(0), size: head.length, probe: () => Buffer.alloc(12, 0) });
  assert.equal(bad.kind, 'declared-missing');
});

test('isPhotoName 认常见照片扩展名', () => {
  assert.equal(isPhotoName('a.HEIC'), true);
  assert.equal(isPhotoName('a.jpg'), true);
  assert.equal(isPhotoName('a.mp4'), false);
  assert.equal(isPhotoName('a.pdf'), false);
});

test('缓存：同样大小的文件不会重复读（第二次命中缓存）', async () => {
  const p = await writeTmp('cache.jpg', jpegWithXmp('<r Item:Semantic="MotionPhoto" Item:Length="999999"/>'));
  const a = await classifyLocalFile(p);
  const b = await classifyLocalFile(p);
  assert.equal(a.kind, b.kind);
  assert.equal(a.kind, 'declared-missing');
});

test('不存在的文件 → unknown，不抛异常', async () => {
  const r = await classifyLocalFile(path.join(tmpRoot, 'nope.jpg'));
  assert.equal(r.kind, 'unknown');
});

test('清理临时目录', async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});
