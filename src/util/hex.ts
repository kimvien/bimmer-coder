/** Conversions hex <-> octets, utilisées partout (logs, catalogue, sauvegardes). */

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[\s:_-]/g, "");
  if (clean.length % 2 !== 0) throw new Error(`hex de longueur impaire: "${hex}"`);
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error(`hex invalide: "${hex}"`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array | number[], sep = ""): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(sep);
}

export const b = (...values: number[]): Uint8Array => Uint8Array.from(values);

export function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export function equalBytes(a: Uint8Array, b2: Uint8Array): boolean {
  if (a.length !== b2.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b2[i]) return false;
  return true;
}

/** CRC-32 (IEEE) — intégrité des sauvegardes de codage. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
