import { BleManager, type Characteristic, type Device, type Subscription } from "react-native-ble-plx";
import { Buffer } from "buffer";
import { Emitter, Mutex, type Transport, type Unsubscribe } from "@core/transport/types.ts";
import { TransportError } from "@core/util/errors.ts";

/**
 * Profils BLE des adaptateurs OBD courants.
 * Un dongle expose un service série : une caractéristique en écriture, une en
 * notification. Les UUID varient selon le fabricant, d'où cette table.
 */
export interface BleProfile { name: string; service: string; write: string; notify: string; }

export const BLE_PROFILES: BleProfile[] = [
  {
    name: "Service série 0xFFF0 (Vgate iCar, LELink, nombreux ELM327 BLE)",
    service: "0000fff0-0000-1000-8000-00805f9b34fb",
    write: "0000fff2-0000-1000-8000-00805f9b34fb",
    notify: "0000fff1-0000-1000-8000-00805f9b34fb",
  },
  {
    name: "Nordic UART (OBDLink CX et dérivés)",
    service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
    write: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
    notify: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
  },
  {
    name: "Service série 0xFFE0 (HM-10 et clones)",
    service: "0000ffe0-0000-1000-8000-00805f9b34fb",
    write: "0000ffe1-0000-1000-8000-00805f9b34fb",
    notify: "0000ffe1-0000-1000-8000-00805f9b34fb",
  },
];

export interface BleScanResult { id: string; name: string; rssi: number | null; }

/** Recherche les adaptateurs visibles. À appeler après avoir obtenu les permissions. */
export function scanForAdapters(
  manager: BleManager,
  onFound: (device: BleScanResult) => void,
  durationMs = 8000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const seen = new Set<string>();
    manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) { manager.stopDeviceScan(); reject(new TransportError(error.message)); return; }
      if (!device || seen.has(device.id)) return;
      seen.add(device.id);
      const name = device.name ?? device.localName ?? "";
      // On ne montre que ce qui ressemble à un adaptateur, sinon la liste est noyée.
      if (!/obd|elm|vgate|veepeak|link|carly|bimmer|icar|vlinker/i.test(name)) return;
      onFound({ id: device.id, name, rssi: device.rssi });
    });
    setTimeout(() => { manager.stopDeviceScan(); resolve(); }, durationMs);
  });
}

/**
 * Transport BLE : expose un dongle Bluetooth comme un simple flux d'octets,
 * que le pilote ELM327 du cœur consomme sans rien savoir du Bluetooth.
 */
export class BleTransport implements Transport {
  readonly name: string;
  private readonly manager: BleManager;
  private readonly deviceId: string;
  private readonly data = new Emitter<Uint8Array>();
  private readonly writeLock = new Mutex();
  private device: Device | null = null;
  private profile: BleProfile | null = null;
  private subscription: Subscription | null = null;
  /** Taille utile d'une écriture BLE : 20 octets sur le MTU par défaut. */
  private chunkSize = 20;

  constructor(manager: BleManager, deviceId: string, label?: string) {
    this.manager = manager;
    this.deviceId = deviceId;
    this.name = `ble://${label ?? deviceId}`;
  }

  get isOpen(): boolean { return this.device !== null; }

  async open(): Promise<void> {
    const device = await this.manager.connectToDevice(this.deviceId, { requestMTU: 185 }).catch((e) => {
      throw new TransportError(`connexion Bluetooth impossible: ${String(e)}`);
    });
    await device.discoverAllServicesAndCharacteristics();
    const services = await device.services();
    const uuids = services.map((s) => s.uuid.toLowerCase());

    const profile = BLE_PROFILES.find((p) => uuids.includes(p.service));
    if (!profile) {
      await device.cancelConnection();
      throw new TransportError(
        `aucun profil série reconnu sur cet appareil (services: ${uuids.join(", ")}). ` +
        `Ajoutez son UUID à BLE_PROFILES.`,
      );
    }

    this.device = device;
    this.profile = profile;
    if (device.mtu && device.mtu > 23) this.chunkSize = device.mtu - 3;

    this.subscription = device.monitorCharacteristicForService(
      profile.service, profile.notify,
      (error: unknown, characteristic: Characteristic | null) => {
        if (error || !characteristic?.value) return;
        this.data.emit(new Uint8Array(Buffer.from(characteristic.value, "base64")));
      },
    );
  }

  async close(): Promise<void> {
    this.subscription?.remove();
    this.subscription = null;
    this.data.clear();
    if (this.device) await this.device.cancelConnection().catch(() => undefined);
    this.device = null;
  }

  /** Les écritures sont découpées au MTU et strictement sérialisées. */
  write(payload: Uint8Array): Promise<void> {
    const device = this.device;
    const profile = this.profile;
    if (!device || !profile) throw new TransportError(`${this.name} fermé`);

    return this.writeLock.run(async () => {
      for (let offset = 0; offset < payload.length; offset += this.chunkSize) {
        const chunk = payload.slice(offset, offset + this.chunkSize);
        const base64 = Buffer.from(chunk).toString("base64");
        await device.writeCharacteristicWithoutResponseForService(profile.service, profile.write, base64);
      }
    });
  }

  onData(cb: (chunk: Uint8Array) => void): Unsubscribe { return this.data.on(cb); }
}
