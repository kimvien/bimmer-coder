import AsyncStorage from "@react-native-async-storage/async-storage";
import type { BackupStore, CodingBackup } from "@core/coding/backup.ts";

const INDEX_KEY = "bimmer-coder:sauvegardes";
const itemKey = (id: string) => `bimmer-coder:sauvegarde:${id}`;

/**
 * Sauvegardes de codage stockées sur le téléphone.
 * Même interface que la version fichier du CLI : le moteur de codage ignore
 * complètement où atterrissent les octets d'origine.
 */
export class AsyncBackupStore implements BackupStore {
  async save(backup: CodingBackup): Promise<void> {
    const index = await this.readIndex();
    if (!index.includes(backup.id)) index.unshift(backup.id);
    await AsyncStorage.multiSet([
      [itemKey(backup.id), JSON.stringify(backup)],
      [INDEX_KEY, JSON.stringify(index)],
    ]);
  }

  async list(filter?: { vin?: string; ecuName?: string }): Promise<CodingBackup[]> {
    const index = await this.readIndex();
    if (index.length === 0) return [];
    const entries = await AsyncStorage.multiGet(index.map(itemKey));
    const out: CodingBackup[] = [];
    for (const [, raw] of entries) {
      if (!raw) continue;
      try {
        const backup = JSON.parse(raw) as CodingBackup;
        if (filter?.vin && backup.vin !== filter.vin) continue;
        if (filter?.ecuName && backup.ecuName !== filter.ecuName) continue;
        out.push(backup);
      } catch { /* entrée illisible : ignorée */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<CodingBackup | null> {
    const raw = await AsyncStorage.getItem(itemKey(id));
    return raw ? (JSON.parse(raw) as CodingBackup) : null;
  }

  private async readIndex(): Promise<string[]> {
    const raw = await AsyncStorage.getItem(INDEX_KEY);
    try { return raw ? (JSON.parse(raw) as string[]) : []; } catch { return []; }
  }
}
