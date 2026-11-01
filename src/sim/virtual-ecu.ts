import { bytesToHex, concat } from "../util/hex.ts";
import { silentLogger, type Logger } from "../util/log.ts";
import type { CanLink } from "../transport/types.ts";
import { IsoTpChannel } from "../isotp/isotp.ts";
import { SESSION, SID } from "../uds/nrc.ts";
import type { KeyProvider } from "../uds/uds.ts";
import { TESTER_ADDRESS } from "../vehicle/addressing.ts";

export interface VirtualEcuConfig {
  name: string;
  address: number;
  /** DID -> octets. */
  dids?: Record<number, Uint8Array>;
  /** Blocs mémoire adressables (données de codage). */
  memory?: Record<number, Uint8Array>;
  /** Niveau d'accès sécurité exigé avant écriture (undefined = aucun). */
  securityLevel?: number;
  /** Renvoie 0x78 "réponse en préparation" avant la réponse finale d'écriture. */
  simulatePendingWrites?: boolean;
  /**
   * ECU défaillante : acquitte les écritures mais ne les enregistre pas.
   * Sert à vérifier que la relecture détecte l'anomalie et déclenche le
   * retour arrière — le scénario qui fait peur en codage réel.
   */
  acknowledgeWritesWithoutStoring?: boolean;
  logger?: Logger;
}

/** Algorithme seed/key **de démonstration** — aucun lien avec BMW. */
export function demoKeyFromSeed(seed: Uint8Array): Uint8Array {
  const key = new Uint8Array(seed.length);
  for (let i = 0; i < seed.length; i++) key[i] = ((seed[i]! ^ 0x5a) + i + 1) & 0xff;
  return key;
}

export const demoKeyProvider: KeyProvider = {
  name: "démo (simulateur)",
  async computeKey(_level, seed) { return demoKeyFromSeed(seed); },
};

/**
 * ECU virtuelle : serveur UDS complet (sessions, sécurité, DID, transferts
 * mémoire) branché sur un bus CAN simulé, en adressage étendu BMW.
 *
 * C'est l'outil qui permet de développer et tester toute la pile sans voiture
 * — et de faire tourner la suite de tests en intégration continue.
 */
export class VirtualEcu {
  readonly name: string;
  readonly address: number;
  readonly dids: Map<number, Uint8Array>;
  readonly memory: Map<number, Uint8Array>;
  private readonly channel: IsoTpChannel;
  private readonly log: Logger;
  private readonly securityLevel: number | undefined;
  private readonly simulatePendingWrites: boolean;
  private readonly fakeWrites: boolean;
  private session: number = SESSION.DEFAULT;
  private unlocked = false;
  private lastSeed: Uint8Array | null = null;
  /** Transfert en cours (0x34/0x35). */
  private transfer: { mode: "download" | "upload"; address: number; size: number; buffer: number[]; counter: number } | null = null;
  /** Compteurs utiles aux tests. */
  readonly stats = { requests: 0, writes: 0, resets: 0 };

  constructor(link: CanLink, config: VirtualEcuConfig) {
    this.name = config.name;
    this.address = config.address;
    this.log = config.logger ?? silentLogger;
    this.securityLevel = config.securityLevel;
    this.simulatePendingWrites = config.simulatePendingWrites ?? false;
    this.fakeWrites = config.acknowledgeWritesWithoutStoring ?? false;
    this.dids = new Map(Object.entries(config.dids ?? {}).map(([k, v]) => [Number(k), v]));
    this.memory = new Map(Object.entries(config.memory ?? {}).map(([k, v]) => [Number(k), v]));

    this.channel = new IsoTpChannel(link, {
      txId: 0x600 + (config.address & 0xff),
      rxId: 0x6f1,
      extendedAddress: TESTER_ADDRESS,
      extendedAddressRx: config.address & 0xff,
      blockSize: 8,
      stMinMs: 0,
      padding: 0x00,
    }, this.log);

    this.channel.onMessage((request) => { void this.handle(request); });
  }

  async close(): Promise<void> { await this.channel.close(); }

  private async reply(payload: Uint8Array): Promise<void> {
    this.log.trace(`${this.name} <= ${bytesToHex(payload, " ")}`);
    await this.channel.send(payload);
  }

  private nrc(sid: number, code: number): Promise<void> {
    return this.reply(Uint8Array.of(0x7f, sid, code));
  }

  private async handle(request: Uint8Array): Promise<void> {
    this.stats.requests++;
    const sid = request[0]!;
    const body = request.slice(1);
    this.log.trace(`${this.name} => ${bytesToHex(request, " ")}`);

    switch (sid) {
      case SID.DIAGNOSTIC_SESSION_CONTROL: {
        const level = body[0] ?? SESSION.DEFAULT;
        this.session = level;
        if (level === SESSION.DEFAULT) this.unlocked = false;
        return this.reply(Uint8Array.of(0x50, level, 0x00, 0x32, 0x01, 0xf4));
      }

      case SID.TESTER_PRESENT:
        if ((body[0] ?? 0) & 0x80) return;                  // réponse supprimée
        return this.reply(Uint8Array.of(0x7e, 0x00));

      case SID.ECU_RESET:
        this.stats.resets++;
        this.session = SESSION.DEFAULT;
        this.unlocked = false;
        return this.reply(Uint8Array.of(0x51, body[0] ?? 0x01));

      case SID.SECURITY_ACCESS: {
        const sub = body[0] ?? 0;
        if (sub % 2 === 1) {                                 // demande de graine
          this.lastSeed = Uint8Array.from([0x11, 0x22, 0x33, 0x44]);
          return this.reply(concat(Uint8Array.of(0x67, sub), this.lastSeed));
        }
        const expected = this.lastSeed ? demoKeyFromSeed(this.lastSeed) : new Uint8Array(0);
        const given = body.slice(1);
        if (given.length !== expected.length || given.some((byte, i) => byte !== expected[i])) {
          return this.nrc(sid, 0x35);                         // clé invalide
        }
        this.unlocked = true;
        return this.reply(Uint8Array.of(0x67, sub));
      }

      case SID.READ_DATA_BY_IDENTIFIER: {
        const did = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
        const value = this.dids.get(did);
        if (!value) return this.nrc(sid, 0x31);               // hors plage
        return this.reply(concat(Uint8Array.of(0x62, body[0]!, body[1]!), value));
      }

      case SID.WRITE_DATA_BY_IDENTIFIER: {
        const did = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
        if (this.session === SESSION.DEFAULT) return this.nrc(sid, 0x7f);
        if (this.securityLevel !== undefined && !this.unlocked) return this.nrc(sid, 0x33);
        if (!this.dids.has(did)) return this.nrc(sid, 0x31);
        if (this.simulatePendingWrites) await this.nrc(sid, 0x78);
        if (!this.fakeWrites) this.dids.set(did, body.slice(2));
        this.stats.writes++;
        return this.reply(Uint8Array.of(0x6e, body[0]!, body[1]!));
      }

      case SID.REQUEST_UPLOAD:
      case SID.REQUEST_DOWNLOAD: {
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const address = view.getUint32(2, false);
        const size = view.getUint32(6, false);
        const mode = sid === SID.REQUEST_DOWNLOAD ? "download" : "upload";
        if (mode === "download") {
          if (this.session === SESSION.DEFAULT) return this.nrc(sid, 0x7f);
          if (this.securityLevel !== undefined && !this.unlocked) return this.nrc(sid, 0x33);
        }
        if (!this.memory.has(address)) return this.nrc(sid, 0x31);
        this.transfer = { mode, address, size, buffer: [], counter: 1 };
        // 0x20 => longueur sur 2 octets ; blocs de 64 octets
        return this.reply(Uint8Array.of(sid + 0x40, 0x20, 0x00, 0x40));
      }

      case SID.TRANSFER_DATA: {
        const transfer = this.transfer;
        if (!transfer) return this.nrc(sid, 0x24);            // séquence incorrecte
        const counter = body[0] ?? 0;
        if (counter !== (transfer.counter & 0xff)) return this.nrc(sid, 0x73); // compteur de bloc
        transfer.counter++;
        if (transfer.mode === "upload") {
          const block = this.memory.get(transfer.address)!;
          const sent = transfer.buffer.length;
          const chunk = block.slice(sent, Math.min(sent + 62, transfer.size));
          transfer.buffer.push(...chunk);
          return this.reply(concat(Uint8Array.of(0x76, counter), chunk));
        }
        transfer.buffer.push(...body.slice(1));
        return this.reply(Uint8Array.of(0x76, counter));
      }

      case SID.REQUEST_TRANSFER_EXIT: {
        const transfer = this.transfer;
        this.transfer = null;
        if (!transfer) return this.nrc(sid, 0x24);
        if (transfer.mode === "download") {
          if (transfer.buffer.length !== transfer.size) return this.nrc(sid, 0x71); // transfert suspendu
          if (this.simulatePendingWrites) await this.nrc(sid, 0x78);
          if (!this.fakeWrites) this.memory.set(transfer.address, Uint8Array.from(transfer.buffer));
          this.stats.writes++;
        }
        return this.reply(Uint8Array.of(0x77));
      }

      case SID.READ_DTC_INFORMATION: {
        if ((body[0] ?? 0) !== 0x02) return this.nrc(sid, 0x12);
        return this.reply(Uint8Array.of(0x59, 0x02, 0xff, 0xd3, 0x5a, 0x01, 0x08, 0xa0, 0x11, 0x02, 0x0c));
      }

      case SID.CLEAR_DIAGNOSTIC_INFORMATION:
        return this.reply(Uint8Array.of(0x54));

      default:
        return this.nrc(sid, 0x11);                           // service non supporté
    }
  }
}
