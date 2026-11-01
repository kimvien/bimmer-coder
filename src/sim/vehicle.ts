import { silentLogger, type Logger } from "../util/log.ts";
import { IsoTpChannel } from "../isotp/isotp.ts";
import { UdsClient } from "../uds/uds.ts";
import { bmwIsoTpConfig } from "../vehicle/addressing.ts";
import { VirtualCanBus } from "./virtual-bus.ts";
import { VirtualEcu, type VirtualEcuConfig } from "./virtual-ecu.ts";
import { DID } from "../uds/nrc.ts";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Bloc de données de codage de démonstration, aligné sur src/catalog/tweaks.ts. */
export const DEMO_CODING_ADDRESS = 0x3000;
export const demoCodingBlock = (): Uint8Array =>
  Uint8Array.from([0x02, 0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

export interface VirtualVehicleOptions {
  vin?: string;
  logger?: Logger;
  /** Ajoute une exigence d'accès sécurité sur FEM_BODY (comme un vrai véhicule). */
  secureFem?: boolean;
  simulatePendingWrites?: boolean;
  /** Rend une ECU défaillante à l'écriture (test du retour arrière). */
  brokenWritesOn?: string[];
}

export interface VirtualVehicle {
  bus: VirtualCanBus;
  ecus: Map<string, VirtualEcu>;
  /** Ouvre un client UDS sur une ECU, en adressage BMW (0x6F1 / 0x6xx). */
  connect(ecuName: string): UdsClient;
  close(): Promise<void>;
}

/**
 * Véhicule virtuel : passerelle + 3 calculateurs codables, VIN cohérent,
 * blocs de codage préremplis. Sert aux tests et à la commande `--transport sim`.
 */
export function createVirtualVehicle(options: VirtualVehicleOptions = {}): VirtualVehicle {
  const log = options.logger ?? silentLogger;
  const vin = options.vin ?? "WBA3A91050F123456";
  const bus = new VirtualCanBus(log);

  const defs: VirtualEcuConfig[] = [
    { name: "ZGW", address: 0x10, dids: { [DID.VIN]: text(vin), [DID.SW_NUMBER]: text("000ZGW01") } },
    {
      name: "FEM_BODY", address: 0x40,
      dids: { [DID.VIN]: text(vin), [DID.SW_NUMBER]: text("000FEM42"), [DID.ECU_SERIAL]: text("FEM0001234") },
      memory: { [DEMO_CODING_ADDRESS]: demoCodingBlock() },
      ...(options.secureFem ? { securityLevel: 0x01 } : {}),
    },
    {
      name: "KOMBI", address: 0x60,
      dids: { [DID.VIN]: text(vin), [DID.SW_NUMBER]: text("000KOM17"), 0x3100: Uint8Array.from([0x00, 0x00]) },
      memory: { [DEMO_CODING_ADDRESS]: demoCodingBlock() },
    },
    {
      name: "HU", address: 0x63,
      dids: { [DID.VIN]: text(vin), [DID.SW_NUMBER]: text("000NBT09") },
      memory: { [DEMO_CODING_ADDRESS]: demoCodingBlock() },
    },
  ];

  const ecus = new Map<string, VirtualEcu>();
  for (const def of defs) {
    const ecu = new VirtualEcu(bus.attach(def.name), {
      ...def,
      logger: log,
      simulatePendingWrites: options.simulatePendingWrites ?? false,
      acknowledgeWritesWithoutStoring: options.brokenWritesOn?.includes(def.name) ?? false,
    });
    ecus.set(def.name, ecu);
  }

  return {
    bus,
    ecus,
    connect(ecuName: string): UdsClient {
      const ecu = ecus.get(ecuName);
      if (!ecu) throw new Error(`ECU "${ecuName}" absente du véhicule virtuel (${[...ecus.keys()].join(", ")})`);
      const channel = new IsoTpChannel(bus.attach(`tester:${ecuName}`), bmwIsoTpConfig(ecu.address), log);
      return new UdsClient(channel, { logger: log, p2Ms: 2000 });
    },
    async close(): Promise<void> {
      for (const ecu of ecus.values()) await ecu.close();
    },
  };
}
