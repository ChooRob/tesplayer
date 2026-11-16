// Find a complete initialization segment without assuming fetch chunk boundaries.
export function mp4InitEnd(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) return null;
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      header = 16;
    }
    if (!Number.isSafeInteger(size) || size < header) throw new Error('Invalid MP4 box size');
    if (offset + size > bytes.length) return null;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'moov') return offset + size;
    offset += size;
  }
  return null;
}

export function joinBytes(a, b) {
  const result = new Uint8Array(a.length + b.length);
  result.set(a); result.set(b, a.length);
  return result;
}
