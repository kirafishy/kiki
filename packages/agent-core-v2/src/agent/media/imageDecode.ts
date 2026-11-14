import { decodeWebp } from './webp-decode';
import { pngWithoutAncillaryChunks } from './pngDecode';

type JimpImage = Awaited<ReturnType<(typeof import('jimp'))['Jimp']['fromBuffer']>>;

export async function decodeToJimp(bytes: Uint8Array, normalizedMime: string): Promise<JimpImage> {
  const { Jimp } = await import('jimp');
  if (normalizedMime === 'image/webp') {
    const decoded = await decodeWebp(bytes);
    return Jimp.fromBitmap({
      data: Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
      width: decoded.width,
      height: decoded.height,
    });
  }
  const buffer = Buffer.from(bytes);
  try {
    return await Jimp.fromBuffer(buffer);
  } catch (error) {
    if (normalizedMime !== 'image/png') throw error;
    const stripped = pngWithoutAncillaryChunks(buffer);
    if (stripped === undefined) throw error;
    return Jimp.fromBuffer(stripped);
  }
}

export async function decodeImageVerdict(bytes: Uint8Array, mimeType: string): Promise<boolean> {
  try { await decodeToJimp(bytes, mimeType); return true; }
  catch { return false; }
}
