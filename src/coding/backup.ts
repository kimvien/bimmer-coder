import fs from "node:fs/promises";
import path from "node:path";
import { bytesToHex, crc32, hexToBytes } from "../util/hex.ts";
import { containerKey, type ContainerRef } from "./model.ts";

/**
 * Sauvegarde d'un conteneur de codage AVANT écriture.
 * C'est le filet de sécurité : sans sauvegarde valide, le moteur refuse d'écrire.
 */
export interface CodingBackup {
  id: string;
  createdAt: string;
  vin: string;
  ecuName: string;
  address: number;
  container: ContainerRef;
  dataHex: string;
  crc32: string;
  note?: string;
}

export interface BackupStore {
  save(backup: CodingBackup): Promise<void>;
  list(filter?: { vin?: string; ecuName?: string }): Promise<CodingBackup[]>;
  get(id: string): Promise<CodingBackup | null>;
}

export function makeBackup(input: { vin: string; ecuName: string; address: number; container: ContainerRef; data: Uint8Array; note?: string }): CodingBackup {
  const createdAt = new Date().toISOString();
  return {
    id: `${input.vin || "VIN?"}_${input.ecuName}_${containerKey(input.container).replace(/[:+]/g, "-")}_${createdAt.replace(/[:.]/g, "-")}`,
    createdAt,
    vin: input.vin,
    ecuName: input.ecuName,
    address: input.address,
    container: input.container,
    dataHex: bytesToHex(input.data),
    crc32: crc32(input.data).toString(16).padStart(8, "0"),
    note: input.note,
  };
}

/** Relit les octets d'une sauvegarde en vérifiant son intégrité. */
export function backupData(backup: CodingBackup): Uint8Array {
  const data = hexToBytes(backup.dataHex);
  const actual = crc32(data).toString(16).padStart(8, "0");
  if (actual !== backup.crc32) throw new Error(`sauvegarde ${backup.id} corrompue (CRC ${actual} ≠ ${backup.crc32})`);
  return data;
}

export class MemoryBackupStore implements BackupStore {
  private readonly items = new Map<string, CodingBackup>();
  async save(backup: CodingBackup): Promise<void> { this.items.set(backup.id, backup); }
  async list(filter?: { vin?: string; ecuName?: string }): Promise<CodingBackup[]> {
    return [...this.items.values()]
      .filter((b) => (!filter?.vin || b.vin === filter.vin) && (!filter?.ecuName || b.ecuName === filter.ecuName))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async get(id: string): Promise<CodingBackup | null> { return this.items.get(id) ?? null; }
}

/** Sauvegardes sur disque, un fichier JSON par conteneur sauvegardé. */
export class FileBackupStore implements BackupStore {
  readonly dir: string;
  constructor(dir: string) { this.dir = dir; }

  private async ensureDir(): Promise<void> { await fs.mkdir(this.dir, { recursive: true }); }

  async save(backup: CodingBackup): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(path.join(this.dir, `${backup.id}.json`), JSON.stringify(backup, null, 2), "utf8");
  }

  async list(filter?: { vin?: string; ecuName?: string }): Promise<CodingBackup[]> {
    await this.ensureDir();
    const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith(".json"));
    const out: CodingBackup[] = [];
    for (const file of files) {
      try {
        const backup = JSON.parse(await fs.readFile(path.join(this.dir, file), "utf8")) as CodingBackup;
        if (filter?.vin && backup.vin !== filter.vin) continue;
        if (filter?.ecuName && backup.ecuName !== filter.ecuName) continue;
        out.push(backup);
      } catch { /* fichier illisible : ignoré, il ne doit pas bloquer la liste */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<CodingBackup | null> {
    try { return JSON.parse(await fs.readFile(path.join(this.dir, `${id}.json`), "utf8")) as CodingBackup; }
    catch { return null; }
  }
}
