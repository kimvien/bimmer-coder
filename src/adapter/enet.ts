import { AdapterError, TimeoutError } from "../util/errors.ts";
import { bytesToHex, concat } from "../util/hex.ts";
import { silentLogger, type Logger } from "../util/log.ts";
import { Emitter, Mutex, type MessageLink, type Transport, type Unsubscribe } from "../transport/types.ts";

/**
 * Lien Ethernet de diagnostic. Deux dialectes coexistent chez BMW :
 *
 *  - "bmw-enet" (F-series, port 6801) : [len:4][type:2][src:1][dst:1][uds...]
 *  - "doip"     (G-series, port 13400, ISO 13400) :
 *               [ver:1][~ver:1][type:2][len:4][src:2][dst:2][uds...]
 *
 * L'Ethernet n'a pas de limite de 8 octets : un message UDS passe d'un bloc,
 * sans ISO-TP. C'est pour ça que le codage par ENET est bien plus rapide.
 */
export type EnetDialect = "bmw-enet" | "doip";

export const DOIP_TYPE = {
  ROUTING_ACTIVATION_REQUEST: 0x0005,
  ROUTING_ACTIVATION_RESPONSE: 0x0006,
  ALIVE_CHECK_REQUEST: 0x0007,
  ALIVE_CHECK_RESPONSE: 0x0008,
  DIAG_MESSAGE: 0x8001,
  DIAG_ACK: 0x8002,
  DIAG_NACK: 0x8003,
} as const;

export const ENET_TYPE = { DIAG_MESSAGE: 0x0001, DIAG_ACK: 0x0002, DIAG_NACK: 0x0003 } as const;

export interface EnetPacket { type: number; payload: Uint8Array; }

export interface EnetOptions {
  dialect?: EnetDialect;
  /** Adresse du testeur. 0xF4 en ENET BMW, 0x0E00 en DoIP. */
  testerAddress?: number;
  timeoutMs?: number;
  logger?: Logger;
}

/** Découpe un flux TCP en paquets, quelle que soit la fragmentation. */
export class EnetFramer {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  readonly dialect: EnetDialect;

  constructor(dialect: EnetDialect) { this.dialect = dialect; }

  push(chunk: Uint8Array): EnetPacket[] {
    this.buffer = concat(this.buffer, chunk);
    const out: EnetPacket[] = [];
    const headerLen = this.dialect === "doip" ? 8 : 6;

    while (this.buffer.length >= headerLen) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      let type: number, length: number;
      if (this.dialect === "doip") {
        const version = this.buffer[0]!;
        if ((this.buffer[1]! ^ 0xff) !== version) throw new AdapterError("DoIP: version et son complément ne concordent pas");
        type = view.getUint16(2, false);
        length = view.getUint32(4, false);
      } else {
        length = view.getUint32(0, false);
        type = view.getUint16(4, false);
      }
      if (length > 0x00ffffff) throw new AdapterError(`paquet de taille invraisemblable (${length} o)`);
      if (this.buffer.length < headerLen + length) break;
      out.push({ type, payload: this.buffer.slice(headerLen, headerLen + length) });
      this.buffer = this.buffer.slice(headerLen + length);
    }
    return out;
  }
}

export function encodeEnetPacket(dialect: EnetDialect, type: number, payload: Uint8Array): Uint8Array {
  if (dialect === "doip") {
    const out = new Uint8Array(8 + payload.length);
    const view = new DataView(out.buffer);
    out[0] = 0x02; out[1] = 0xfd;            // version ISO 13400-2:2012 + complément
    view.setUint16(2, type, false);
    view.setUint32(4, payload.length, false);
    out.set(payload, 8);
    return out;
  }
  const out = new Uint8Array(6 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, false);
  view.setUint16(4, type, false);
  out.set(payload, 6);
  return out;
}

export class EnetAdapter {
  readonly transport: Transport;
  readonly dialect: EnetDialect;
  private readonly testerAddress: number;
  private readonly timeoutMs: number;
  private readonly log: Logger;
  private readonly framer: EnetFramer;
  private readonly packets = new Emitter<EnetPacket>();
  private readonly lock = new Mutex();
  private unsub: Unsubscribe | null = null;

  constructor(transport: Transport, options: EnetOptions = {}) {
    this.transport = transport;
    this.dialect = options.dialect ?? "bmw-enet";
    this.testerAddress = options.testerAddress ?? (this.dialect === "doip" ? 0x0e00 : 0xf4);
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.log = options.logger ?? silentLogger;
    this.framer = new EnetFramer(this.dialect);
  }

  async open(): Promise<void> {
    if (!this.transport.isOpen) await this.transport.open();
    this.unsub = this.transport.onData((chunk) => {
      try {
        for (const packet of this.framer.push(chunk)) this.handlePacket(packet);
      } catch (err) { this.log.error(`ENET: ${String(err)}`); }
    });
    if (this.dialect === "doip") await this.activateRouting();
  }

  async close(): Promise<void> { this.unsub?.(); this.packets.clear(); await this.transport.close(); }

  /** DoIP : sans activation de routage, la passerelle ignore tout message de diag. */
  private async activateRouting(): Promise<void> {
    const payload = new Uint8Array(7);
    new DataView(payload.buffer).setUint16(0, this.testerAddress, false);
    payload[2] = 0x00; // type d'activation : diagnostic par défaut
    const response = await this.exchange(DOIP_TYPE.ROUTING_ACTIVATION_REQUEST, payload, DOIP_TYPE.ROUTING_ACTIVATION_RESPONSE);
    const code = response.payload[4];
    if (code !== 0x10) throw new AdapterError(`DoIP: activation de routage refusée (code 0x${(code ?? 0).toString(16)})`);
    this.log.info("DoIP: routage activé");
  }

  private handlePacket(packet: EnetPacket): void {
    if (this.dialect === "doip" && packet.type === DOIP_TYPE.ALIVE_CHECK_REQUEST) {
      const payload = new Uint8Array(2);
      new DataView(payload.buffer).setUint16(0, this.testerAddress, false);
      void this.transport.write(encodeEnetPacket(this.dialect, DOIP_TYPE.ALIVE_CHECK_RESPONSE, payload));
      return;
    }
    this.packets.emit(packet);
  }

  private exchange(sendType: number, payload: Uint8Array, expectType: number): Promise<EnetPacket> {
    return this.lock.run(() => new Promise<EnetPacket>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new TimeoutError(`ENET: pas de réponse au paquet 0x${sendType.toString(16)}`)); }, this.timeoutMs);
      const off = this.packets.on((packet) => {
        if (packet.type !== expectType) return;
        clearTimeout(timer); off(); resolve(packet);
      });
      this.transport.write(encodeEnetPacket(this.dialect, sendType, payload)).catch((e) => { clearTimeout(timer); off(); reject(e); });
    }));
  }

  private encodeAddresses(target: number): Uint8Array {
    if (this.dialect === "doip") {
      const head = new Uint8Array(4);
      const view = new DataView(head.buffer);
      view.setUint16(0, this.testerAddress, false);
      view.setUint16(2, target, false);
      return head;
    }
    return Uint8Array.from([this.testerAddress & 0xff, target & 0xff]);
  }

  private addressWidth(): number { return this.dialect === "doip" ? 2 : 1; }

  /** Lien UDS vers une ECU donnée (adresse logique/diag). */
  openMessageLink(target: number): MessageLink {
    const adapter = this;
    const diagType = this.dialect === "doip" ? DOIP_TYPE.DIAG_MESSAGE : ENET_TYPE.DIAG_MESSAGE;
    const nackType = this.dialect === "doip" ? DOIP_TYPE.DIAG_NACK : ENET_TYPE.DIAG_NACK;
    const ackType = this.dialect === "doip" ? DOIP_TYPE.DIAG_ACK : ENET_TYPE.DIAG_ACK;
    const width = this.addressWidth();
    const messages = new Emitter<Uint8Array>();

    const off = this.packets.on((packet) => {
      if (packet.type === nackType) { adapter.log.error(`ENET: message de diag refusé par la passerelle (${bytesToHex(packet.payload, " ")})`); return; }
      if (packet.type === ackType) return; // accusé de réception : rien à remonter
      if (packet.type !== diagType) return;
      const source = width === 2
        ? (packet.payload[0]! << 8) | packet.payload[1]!
        : packet.payload[0]!;
      if (source !== target) return;
      messages.emit(packet.payload.slice(width * 2));
    });

    return {
      name: `${adapter.dialect}(${target.toString(16)})`,
      target,
      async send(payload: Uint8Array): Promise<void> {
        const packet = encodeEnetPacket(adapter.dialect, diagType, concat(adapter.encodeAddresses(target), payload));
        await adapter.transport.write(packet);
      },
      onMessage(cb) { return messages.on(cb); },
      async close(): Promise<void> { off(); messages.clear(); },
    };
  }
}
