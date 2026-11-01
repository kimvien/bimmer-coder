/**
 * Modèle de données de codage.
 *
 * Un paramètre de codage, c'est l'adresse d'un champ de bits dans un conteneur
 * d'octets détenu par une ECU. Deux types de conteneurs existent côté BMW :
 *
 *  - un DID (Data IDentifier) lisible/écrivable par UDS 0x22 / 0x2E ;
 *  - un bloc mémoire de données de codage (NCD), lu par 0x35 et écrit par 0x34.
 *
 * Convention de bits : bit 0 = bit de poids faible de l'octet, et un champ qui
 * dépasse l'octet continue sur les bits de poids faible de l'octet suivant
 * (flux de bits « little endian »).
 */

export type ContainerRef =
  | { kind: "did"; did: number }
  | { kind: "memory"; address: number; size: number };

export interface ParameterLocation {
  container: ContainerRef;
  byteOffset: number;
  /** 0-7, défaut 0. */
  bitOffset?: number;
  /** Nombre de bits du champ, défaut 8. Max 32 pour la forme numérique. */
  bitLength?: number;
}

export interface ParameterOption { value: number; label: string; }

export interface ParameterDef {
  id: string;
  label: string;
  location: ParameterLocation;
  options?: ParameterOption[];
  /** Libellé lisible d'une valeur brute. */
  unit?: string;
}

export const containerKey = (ref: ContainerRef): string =>
  ref.kind === "did"
    ? `did:${ref.did.toString(16).padStart(4, "0")}`
    : `mem:${ref.address.toString(16)}+${ref.size}`;

export const containerLabel = (ref: ContainerRef): string =>
  ref.kind === "did"
    ? `DID 0x${ref.did.toString(16).toUpperCase().padStart(4, "0")}`
    : `mémoire 0x${ref.address.toString(16).toUpperCase()} (${ref.size} o)`;

export function normalizeLocation(location: ParameterLocation): Required<Omit<ParameterLocation, "container">> & { container: ContainerRef } {
  const bitOffset = location.bitOffset ?? 0;
  const bitLength = location.bitLength ?? 8;
  if (location.byteOffset < 0 || !Number.isInteger(location.byteOffset)) throw new RangeError(`byteOffset invalide: ${location.byteOffset}`);
  if (bitOffset < 0 || bitOffset > 7) throw new RangeError(`bitOffset hors 0-7: ${bitOffset}`);
  if (bitLength < 1 || bitLength > 32) throw new RangeError(`bitLength hors 1-32: ${bitLength}`);
  return { container: location.container, byteOffset: location.byteOffset, bitOffset, bitLength };
}

/** Valeur maximale représentable sur `bitLength` bits. */
export const maxValueFor = (bitLength: number): number => (bitLength >= 32 ? 0xffffffff : (1 << bitLength) - 1);

export function readBits(bytes: Uint8Array, location: ParameterLocation): number {
  const { byteOffset, bitOffset, bitLength } = normalizeLocation(location);
  let value = 0;
  for (let i = 0; i < bitLength; i++) {
    const absoluteBit = bitOffset + i;
    const index = byteOffset + (absoluteBit >> 3);
    const byte = bytes[index];
    if (byte === undefined) throw new RangeError(`lecture hors conteneur: octet ${index} (taille ${bytes.length})`);
    const bit = (byte >> (absoluteBit & 7)) & 1;
    value |= bit << i;
  }
  return value >>> 0;
}

/** Renvoie une **copie** du conteneur avec le champ modifié. */
export function writeBits(bytes: Uint8Array, location: ParameterLocation, value: number): Uint8Array {
  const { byteOffset, bitOffset, bitLength } = normalizeLocation(location);
  const limit = maxValueFor(bitLength);
  if (!Number.isInteger(value) || value < 0 || value > limit) {
    throw new RangeError(`valeur ${value} hors plage 0-${limit} pour un champ de ${bitLength} bit(s)`);
  }
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bitLength; i++) {
    const absoluteBit = bitOffset + i;
    const index = byteOffset + (absoluteBit >> 3);
    if (out[index] === undefined) throw new RangeError(`écriture hors conteneur: octet ${index} (taille ${out.length})`);
    const mask = 1 << (absoluteBit & 7);
    out[index] = ((value >>> i) & 1) ? (out[index]! | mask) : (out[index]! & ~mask);
  }
  return out;
}

/** Octets strictement modifiés entre deux états d'un conteneur. */
export function diffBytes(before: Uint8Array, after: Uint8Array): Array<{ offset: number; before: number; after: number }> {
  const out: Array<{ offset: number; before: number; after: number }> = [];
  const length = Math.max(before.length, after.length);
  for (let i = 0; i < length; i++) {
    const b = before[i] ?? 0;
    const a = after[i] ?? 0;
    if (a !== b) out.push({ offset: i, before: b, after: a });
  }
  return out;
}
