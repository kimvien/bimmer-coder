import { silentLogger, type Logger } from "../util/log.ts";
import { DID } from "../uds/nrc.ts";
import type { UdsClient } from "../uds/uds.ts";
import { decodeVin, type VinInfo } from "./chassis.ts";
import { MODULES, type ChassisFamily, type ModuleDef } from "./modules.ts";

export interface DiscoveredModule {
  name: string;
  address: number;
  role: string;
  /** Numéro de logiciel lu dans l'ECU (DID 0xF188), si disponible. */
  softwareNumber?: string;
  serial?: string;
  responded: boolean;
}

export interface VehicleIdentity {
  vin: VinInfo | null;
  family: ChassisFamily;
  modules: DiscoveredModule[];
}

const ascii = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).replace(/[^\x20-\x7e]/g, "").trim();

/**
 * Interroge chaque adresse connue et ne garde que ce qui répond.
 *
 * C'est la seule source de vérité sur le contenu d'un véhicule : les tables
 * d'adresses sont indicatives, les options et la plateforme changent tout.
 */
export async function scanModules(
  clientFor: (address: number, name: string) => UdsClient,
  options: { candidates?: ModuleDef[]; family?: ChassisFamily; timeoutMs?: number; logger?: Logger } = {},
): Promise<DiscoveredModule[]> {
  const log = options.logger ?? silentLogger;
  const seen = new Set<number>();
  const candidates = (options.candidates ?? MODULES)
    .filter((m) => !options.family || m.families.includes(options.family))
    .filter((m) => { if (seen.has(m.address)) return false; seen.add(m.address); return true; });

  const found: DiscoveredModule[] = [];
  for (const def of candidates) {
    const client = clientFor(def.address, def.name);
    const entry: DiscoveredModule = { name: def.name, address: def.address, role: def.role, responded: false };
    try {
      const sw = await client.readDataByIdentifier(DID.SW_NUMBER).catch(() => null);
      const serial = await client.readDataByIdentifier(DID.ECU_SERIAL).catch(() => null);
      if (sw || serial) {
        entry.responded = true;
        if (sw) entry.softwareNumber = ascii(sw);
        if (serial) entry.serial = ascii(serial);
      }
      log.debug(`${def.name} (0x${def.address.toString(16)}): ${entry.responded ? "présent" : "pas de réponse"}`);
    } catch (err) {
      log.debug(`${def.name} (0x${def.address.toString(16)}): ${String(err)}`);
    } finally {
      await client.close().catch(() => undefined);
    }
    if (entry.responded) found.push(entry);
  }
  return found;
}

/** Identité complète : VIN (lu sur la première ECU qui répond) + modules présents. */
export async function identifyVehicle(
  clientFor: (address: number, name: string) => UdsClient,
  options: { logger?: Logger; family?: ChassisFamily } = {},
): Promise<VehicleIdentity> {
  const modules = await scanModules(clientFor, options);
  let vin: VinInfo | null = null;

  for (const module of modules) {
    const client = clientFor(module.address, module.name);
    try {
      const raw = await client.readVin();
      if (raw && raw.length >= 11) { vin = decodeVin(raw); break; }
    } catch { /* ECU muette sur le VIN : on essaie la suivante */ }
    finally { await client.close().catch(() => undefined); }
  }

  return { vin, family: vin?.family ?? options.family ?? "unknown", modules };
}
