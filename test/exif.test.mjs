import test from 'node:test';
import assert from 'node:assert/strict';
import { readExifDate } from '../src/time/exif.mjs';

function buildJpegWithExif(dateStr) {
  const ifd0Offset = 8;
  const exifIfdOffset = ifd0Offset + 2 + 12 + 4; // 26
  const valueOffset = exifIfdOffset + 2 + 12 + 4; // 44
  const tiff = Buffer.alloc(valueOffset + 20);

  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(ifd0Offset, 4);

  tiff.writeUInt16LE(1, ifd0Offset);
  const e0 = ifd0Offset + 2;
  tiff.writeUInt16LE(0x8769, e0);
  tiff.writeUInt16LE(4, e0 + 2);
  tiff.writeUInt32LE(1, e0 + 4);
  tiff.writeUInt32LE(exifIfdOffset, e0 + 8);
  tiff.writeUInt32LE(0, ifd0Offset + 2 + 12);

  tiff.writeUInt16LE(1, exifIfdOffset);
  const e1 = exifIfdOffset + 2;
  tiff.writeUInt16LE(0x9003, e1);
  tiff.writeUInt16LE(2, e1 + 2);
  tiff.writeUInt32LE(20, e1 + 4);
  tiff.writeUInt32LE(valueOffset, e1 + 8);
  tiff.writeUInt32LE(0, exifIfdOffset + 2 + 12);

  tiff.write(`${dateStr}\0`, valueOffset, 'latin1');

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = payload.length + 2;
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([head, payload, Buffer.from([0xff, 0xd9])]);
}

test('能读出 EXIF DateTimeOriginal', () => {
  const buf = buildJpegWithExif('2026:09:01 18:19:43');
  const d = readExifDate(buf);
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 18);
  assert.equal(d.getMinutes(), 19);
  assert.equal(d.getSeconds(), 43);
});

test('非 JPEG 返回 null', () => {
  assert.equal(readExifDate(Buffer.from('hello world, not a jpeg at all')), null);
});

test('空缓冲不炸', () => {
  assert.equal(readExifDate(null), null);
  assert.equal(readExifDate(Buffer.alloc(0)), null);
});

test('只有 SOI/EOI 的 JPEG 返回 null', () => {
  assert.equal(readExifDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
});
