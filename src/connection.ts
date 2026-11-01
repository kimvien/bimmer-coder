import { silentLogger, type Logger } from "./util/log.ts";
import { MockTransport } from "./transport/mock.ts";
import { TcpTransport } from "./transport/tcp.ts";
import type { Transport } from "./transport/types.ts";
import { Elm327Adapter, ELM_PROTOCOL, type Elm327Options } from "./adapter/elm327.ts";
import { EnetAdapter, type EnetDialect } from "./adapter/enet.ts";
import { IsoTpChannel } from "./isotp/isotp.ts";
import { UdsClient } from "./uds/uds.ts";
import { bmwIsoTpConfig } from "./vehicle/addressing.ts";
import { createVirtualVehicle, type VirtualVehicle } from "./sim/vehicle.ts";
import { VirtualElm327 } from "./sim/virtual-elm327.ts";
import { VirtualCanBus } from "./sim/virtual-bus.ts";
import { VirtualEcu } from "./sim/virtual-ecu.ts";
import { DID } from "./uds/nrc.ts";
import { demoCodingBlock, DEMO_CODING_ADDRESS } from "./sim/vehicle.ts";

/**
 * Qui fait l'ISO-TP ?
 *  - "app"     : nous, sur des trames brutes (ATCAF0). Obligatoire pour
 *                l'adressage étendu BMW, et c'est le mode testé de bout en bout.
 *  - "adapter" : l'ELM327 segmente lui-même (ATCAF1 + ATCEA). Plus rapide,
 *                mais tous les dongles n'en sont pas capables.
 */
export type IsoTpMode = "app" | "adapter";

export type ConnectionSpec =
  | { kind: "sim"; secureFem?: boolean; simulatePendingWrites?: boolean; vin?: string }
  | { kind: "sim-elm" }
  | { kind: "elm327"; transport: Transport; options?: Elm327Options; isoTpMode?: IsoTpMode }
  | { kind: "elm327-wifi"; host?: string; port?: number; options?: Elm327Options; isoTpMode?: IsoTpMode }
  | { kind: "enet"; host: string; port?: number; dialect?: EnetDialect };

export interface VehicleConnection {
  readonly name: string;
  /** Ouvre un client UDS vers une ECU par son adresse de diagnostic. */
  clientFor(address: number, ecuName?: string): UdsClient;
  close(): Promise<void>;
}

export async function openConnection(spec: ConnectionSpec, logger: Logger = silentLogger): Promise<VehicleConnection> {
  switch (spec.kind) {
    case "sim": {
      const car: VirtualVehicle = createVirtualVehicle({
        logger,
        secureFem: spec.secureFem ?? false,
        simulatePendingWrites: spec.simulatePendingWrites ?? false,
        ...(spec.vin ? { vin: spec.vin } : {}),
      });
      const byAddress = new Map<number, string>([...car.ecus.values()].map((ecu) => [ecu.address, ecu.name]));
      return {
        name: "simulateur",
        clientFor(address: number): UdsClient {
          const name = byAddress.get(address);
          if (!name) {
            // Adresse inexistante : on renvoie un client vers le vide, qui
            // expirera — exactement ce que fait un scan sur une vraie voiture.
            const channel = new IsoTpChannel(car.bus.attach(`tester:${address}`), bmwIsoTpConfig(address), logger);
            return new UdsClient(channel, { logger, p2Ms: 60 });
          }
          return car.connect(name);
        },
        close: () => car.close(),
      };
    }

    case "sim-elm": {
      // Même véhicule, mais vu à travers un émulateur d'ELM327 : la pile
      // complète est exercée, pilote d'adaptateur inclus.
      const bus = new VirtualCanBus(logger);
      const vin = new TextEncoder().encode("WBA3A91050F123456");
      const defs = [
        { name: "ZGW", address: 0x10 }, { name: "FEM_BODY", address: 0x40 },
        { name: "KOMBI", address: 0x60 }, { name: "HU", address: 0x63 },
      ];
      const ecus = defs.map((def) => new VirtualEcu(bus.attach(def.name), {
        ...def,
        dids: { [DID.VIN]: vin, [DID.SW_NUMBER]: new TextEncoder().encode(`000${def.name.slice(0, 3)}01`) },
        memory: { [DEMO_CODING_ADDRESS]: demoCodingBlock() },
        logger,
      }));
      const [appSide, adapterSide] = MockTransport.pair("app", "dongle");
      const emulator = new VirtualElm327(adapterSide, bus.attach("elm327"), { logger });
      const adapter = new Elm327Adapter(appSide, { autoFormat: false, logger, commandTimeoutMs: 1000 });
      await adapter.open();
      const canLink = adapter.openCanLink();
      return {
        name: `simulateur via ${emulator.version}`,
        clientFor(address: number): UdsClient {
          return new UdsClient(new IsoTpChannel(canLink, bmwIsoTpConfig(address), logger), { logger, p2Ms: 1500 });
        },
        async close(): Promise<void> {
          await adapter.close();
          await emulator.close();
          for (const ecu of ecus) await ecu.close();
        },
      };
    }

    case "elm327":
    case "elm327-wifi": {
      const transport = spec.kind === "elm327"
        ? spec.transport
        : new TcpTransport(spec.host ?? "192.168.0.10", spec.port ?? 35000);
      const mode: IsoTpMode = spec.isoTpMode ?? "app";
      const adapter = new Elm327Adapter(transport, {
        protocol: ELM_PROTOCOL.CAN_11B_500K,
        autoFormat: mode === "adapter",
        logger,
        ...spec.options,
      });
      await adapter.open();
      const probe = await adapter.probe();
      if (!probe.ok) {
        logger.error(`adaptateur incomplet (${probe.version}) : ${probe.missing.join(", ")} — le codage BMW ne fonctionnera pas`);
      }
      const canLink = mode === "app" ? adapter.openCanLink() : null;
      return {
        name: `ELM327 ${probe.version} via ${transport.name}`,
        clientFor(address: number): UdsClient {
          if (canLink) return new UdsClient(new IsoTpChannel(canLink, bmwIsoTpConfig(address), logger), { logger });
          const link = adapter.openMessageLink(0x6f1, 0x600 + address, address);
          return new UdsClient(link, { logger });
        },
        close: () => adapter.close(),
      };
    }

    case "enet": {
      const port = spec.port ?? (spec.dialect === "doip" ? 13400 : 6801);
      const transport = new TcpTransport(spec.host, port);
      const adapter = new EnetAdapter(transport, { dialect: spec.dialect ?? "bmw-enet", logger });
      await adapter.open();
      return {
        name: `${spec.dialect ?? "bmw-enet"} via ${transport.name}`,
        clientFor(address: number): UdsClient {
          return new UdsClient(adapter.openMessageLink(address), { logger, p2Ms: 3000 });
        },
        close: () => adapter.close(),
      };
    }
  }
}
