import { crc32 } from 'node:zlib';

export function pngChunk(type: string, data: Uint8Array, corruptCrc = false): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  chunk.set(data, 8);
  const crc = crc32(chunk.subarray(4, -4));
  chunk.writeUInt32BE(corruptCrc ? (crc + 1) % 0x100000000 : crc, chunk.length - 4);
  return chunk;
}

export function withPngChunk(png: Uint8Array, type: string, data: Uint8Array, corruptCrc = false): Buffer {
  return Buffer.concat([png.subarray(0, 33), pngChunk(type, data, corruptCrc), png.subarray(33)]);
}
