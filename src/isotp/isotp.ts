import { IsoTpError, TimeoutError } from "../util/errors.ts";
import { bytesToHex } from "../util/hex.ts";
import { silentLogger, type Logger } from "../util/log.ts";
import { Emitter, Mutex, sleep, type CanFrame, type CanLink, type MessageLink, type Unsubscribe } from "../transport/types.ts";

/** Types de PCI ISO 15765-2. */
export const PCI = { SF: 0x0, FF: 0x1, CF: 0x2, FC: 0x3 } as const;
/** Statuts de Flow Control. */
export const FC_STATUS = { CTS: 0x0, WAIT: 0x1, OVERFLOW: 0x2 } as const;

export interface IsoTpConfig {
  /** Identifiant CAN d'émission (tester -> ECU). */
  txId: number;
  /** Identifiant CAN de réception (ECU -> tester). */
  rxId: number;
  /** BlockSize annoncé quand *nous* recevons (0 = envoyer tout sans FC intermédiaire). */
  blockSize?: number;
  /** STmin annoncé quand nous recevons, en ms. */
  stMinMs?: number;
  /** Octet de bourrage pour compléter à 8 ; null = trames de longueur variable. */
  padding?: number | null;
  /** Délai d'attente d'une Flow Control (N_Bs). */
  timeoutFcMs?: number;
  /** Délai d'attente d'une trame consécutive (N_Cr). */
  timeoutCfMs?: number;
  /** Nombre max de FC "WAIT" acceptées avant abandon (N_WFTmax). */
  maxWaitFrames?: number;
  /**
   * Adressage étendu ISO-TP : un octet d'adresse cible précède le PCI dans
   * chaque trame. C'est le mode utilisé par BMW sur PT-CAN/K-CAN (le testeur
   * émet sur 0x6F1 en préfixant l'adresse de l'ECU visée).
   * null = adressage normal.
   */
  extendedAddress?: number | null;
  /** Adresse attendue en réception (celle du testeur, 0xF1 chez BMW). */
  extendedAddressRx?: number | null;
}

interface Reassembly {
  expectedLength: number;
  received: number[];
  nextSequence: number;
  framesSinceFc: number;
}

/**
 * ISO-TP (ISO 15765-2) : segmentation/réassemblage par-dessus des trames CAN de 8 octets.
 * Implémenté nous-mêmes plutôt que de déléguer à l'ELM327, pour garder la main sur
 * le Flow Control, le padding et l'adressage 29 bits utilisés par BMW.
 */
export class IsoTpChannel implements MessageLink {
  readonly name: string;
  readonly target: number;
  private readonly messages = new Emitter<Uint8Array>();
  private readonly flowControl = new Emitter<{ status: number; blockSize: number; stMinMs: number }>();
  private readonly txLock = new Mutex();
  private rx: Reassembly | null = null;
  /** FC reçues avant qu'on les attende (fréquent : l'adaptateur rend la ligne après coup). */
  private pendingFc: Array<{ status: number; blockSize: number; stMinMs: number }> = [];
  private unsub: Unsubscribe;
  private readonly cfg: Required<IsoTpConfig>;
  private readonly link: CanLink;
  private readonly log: Logger;

  constructor(link: CanLink, config: IsoTpConfig, log: Logger = silentLogger) {
    this.link = link;
    this.log = log;
    this.cfg = {
      blockSize: 0,
      stMinMs: 0,
      padding: 0x00,
      timeoutFcMs: 1000,
      timeoutCfMs: 1000,
      maxWaitFrames: 8,
      extendedAddress: null,
      extendedAddressRx: null,
      ...config,
    };
    this.target = config.rxId;
    this.name = `isotp(${config.txId.toString(16)}->${config.rxId.toString(16)})`;
    this.unsub = link.onFrame((f) => this.handleFrame(f));
  }

  onMessage(cb: (payload: Uint8Array) => void): Unsubscribe { return this.messages.on(cb); }

  async close(): Promise<void> { this.unsub(); this.messages.clear(); this.flowControl.clear(); }

  /** Envoie un message complet, en une ou N trames selon sa taille. */
  send(payload: Uint8Array): Promise<void> {
    return this.txLock.run(async () => {
      if (payload.length === 0) throw new IsoTpError("message vide");
      this.pendingFc = [];
      if (payload.length <= this.sfCapacity) return this.sendSingleFrame(payload);
      return this.sendSegmented(payload);
    });
  }

  /** Octets de préfixe de chaque trame (adressage étendu). */
  private prefix(): number[] {
    return this.cfg.extendedAddress === null ? [] : [this.cfg.extendedAddress & 0xff];
  }

  /** Capacité utile d'une trame simple / consécutive, selon l'adressage. */
  private get sfCapacity(): number { return 7 - this.prefix().length; }
  private get ffCapacity(): number { return 6 - this.prefix().length; }
  private get cfCapacity(): number { return 7 - this.prefix().length; }

  private pad(bytes: number[]): Uint8Array {
    const pad = this.cfg.padding;
    if (pad === null) return Uint8Array.from(bytes);
    while (bytes.length < 8) bytes.push(pad);
    return Uint8Array.from(bytes);
  }

  private async sendSingleFrame(payload: Uint8Array): Promise<void> {
    const frame = this.pad([...this.prefix(), payload.length, ...payload]);
    this.log.trace(`${this.name} SF`, bytesToHex(frame, " "));
    await this.link.send({ id: this.cfg.txId, data: frame });
  }

  private async sendSegmented(payload: Uint8Array): Promise<void> {
    if (payload.length > 0xfff) throw new IsoTpError(`message trop long pour ISO-TP classique (${payload.length} o)`);
    // First Frame : 0x1L LL + 6 octets de données
    const ff = this.pad([...this.prefix(), 0x10 | ((payload.length >> 8) & 0x0f), payload.length & 0xff, ...payload.slice(0, this.ffCapacity)]);
    this.log.trace(`${this.name} FF len=${payload.length}`, bytesToHex(ff, " "));
    await this.link.send({ id: this.cfg.txId, data: ff });

    let fc = await this.awaitFlowControl();
    let offset = this.ffCapacity;
    let sequence = 1;
    let framesInBlock = 0;

    while (offset < payload.length) {
      const chunk = payload.slice(offset, offset + this.cfCapacity);
      const cf = this.pad([...this.prefix(), 0x20 | (sequence & 0x0f), ...chunk]);
      await this.link.send({ id: this.cfg.txId, data: cf });
      this.log.trace(`${this.name} CF#${sequence}`, bytesToHex(cf, " "));
      offset += chunk.length;
      sequence = (sequence + 1) & 0x0f;
      framesInBlock++;

      if (offset >= payload.length) break;
      if (fc.blockSize !== 0 && framesInBlock >= fc.blockSize) {
        fc = await this.awaitFlowControl(); // bloc terminé : l'ECU redonne la main
        framesInBlock = 0;
      } else if (fc.stMinMs > 0) {
        await sleep(fc.stMinMs);
      }
    }
  }

  private async awaitFlowControl(): Promise<{ blockSize: number; stMinMs: number }> {
    for (let waits = 0; waits <= this.cfg.maxWaitFrames; waits++) {
      const fc = await this.nextFlowControl(this.cfg.timeoutFcMs);
      if (fc.status === FC_STATUS.CTS) return { blockSize: fc.blockSize, stMinMs: fc.stMinMs };
      if (fc.status === FC_STATUS.OVERFLOW) throw new IsoTpError("ECU: buffer saturé (FC OVERFLOW)");
      this.log.debug(`${this.name} FC WAIT (${waits + 1})`);
    }
    throw new IsoTpError("trop de Flow Control 'WAIT' consécutives");
  }

  private nextFlowControl(timeoutMs: number): Promise<{ status: number; blockSize: number; stMinMs: number }> {
    const buffered = this.pendingFc.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new TimeoutError(`${this.name}: pas de Flow Control reçue`)); }, timeoutMs);
      const off = this.flowControl.on((fc) => { clearTimeout(timer); off(); resolve(fc); });
    });
  }

  /** Décode STmin : 0x00-0x7F = ms, 0xF1-0xF9 = 100-900 µs (arrondi à 1 ms). */
  static decodeStMin(raw: number): number {
    if (raw <= 0x7f) return raw;
    if (raw >= 0xf1 && raw <= 0xf9) return 1;
    return 0;
  }

  private handleFrame(frame: CanFrame): void {
    if (frame.id !== this.cfg.rxId || frame.data.length === 0) return;
    let data = frame.data;
    if (this.cfg.extendedAddress !== null) {
      const expected = this.cfg.extendedAddressRx;
      if (expected !== null && data[0] !== (expected & 0xff)) return; // trame destinée à un autre testeur
      data = data.slice(1);
      if (data.length === 0) return;
    }
    frame = { id: frame.id, data };
    const first = frame.data[0]!;
    const type = (first >> 4) & 0x0f;

    switch (type) {
      case PCI.SF: {
        const len = first & 0x0f;
        if (len === 0 || len > 7) { this.log.debug(`${this.name} SF de longueur invalide ${len}`); return; }
        this.rx = null;
        this.messages.emit(frame.data.slice(1, 1 + len));
        return;
      }
      case PCI.FF: {
        const expected = ((first & 0x0f) << 8) | (frame.data[1] ?? 0);
        this.rx = { expectedLength: expected, received: [...frame.data.slice(2, 8)], nextSequence: 1, framesSinceFc: 0 };
        this.log.trace(`${this.name} <- FF len=${expected}`);
        void this.sendFlowControl(FC_STATUS.CTS);
        return;
      }
      case PCI.CF: {
        const rx = this.rx;
        if (!rx) { this.log.debug(`${this.name} CF orpheline, ignorée`); return; }
        const sequence = first & 0x0f;
        if (sequence !== rx.nextSequence) {
          this.log.error(`${this.name} séquence ISO-TP rompue: attendu ${rx.nextSequence}, reçu ${sequence}`);
          this.rx = null;
          return;
        }
        const remaining = rx.expectedLength - rx.received.length;
        rx.received.push(...frame.data.slice(1, 1 + Math.min(7, remaining)));
        rx.nextSequence = (rx.nextSequence + 1) & 0x0f;
        rx.framesSinceFc++;

        if (rx.received.length >= rx.expectedLength) {
          const payload = Uint8Array.from(rx.received.slice(0, rx.expectedLength));
          this.rx = null;
          this.messages.emit(payload);
          return;
        }
        if (this.cfg.blockSize !== 0 && rx.framesSinceFc >= this.cfg.blockSize) {
          rx.framesSinceFc = 0;
          void this.sendFlowControl(FC_STATUS.CTS);
        }
        return;
      }
      case PCI.FC: {
        const fc = {
          status: first & 0x0f,
          blockSize: frame.data[1] ?? 0,
          stMinMs: IsoTpChannel.decodeStMin(frame.data[2] ?? 0),
        };
        if (this.flowControl.size > 0) this.flowControl.emit(fc);
        else this.pendingFc.push(fc);   // personne n'attend encore : on garde
        return;
      }
      default:
        this.log.debug(`${this.name} PCI inconnu 0x${first.toString(16)}`);
    }
  }

  private async sendFlowControl(status: number): Promise<void> {
    const frame = this.pad([...this.prefix(), 0x30 | status, this.cfg.blockSize, this.cfg.stMinMs]);
    await this.link.send({ id: this.cfg.txId, data: frame }).catch((e) => this.log.error(`${this.name} FC non envoyée: ${String(e)}`));
  }
}

/**
 * Réassembleur ISO-TP seul (sans émission de Flow Control).
 * Utilisé avec un ELM327 en mode auto : l'adaptateur envoie déjà les FC,
 * nous n'avons plus qu'à recoller les trames qu'il nous recrache.
 */
export class IsoTpReassembler {
  private rx: Reassembly | null = null;
  private readonly messages = new Emitter<Uint8Array>();

  onMessage(cb: (payload: Uint8Array) => void): Unsubscribe { return this.messages.on(cb); }
  reset(): void { this.rx = null; }

  /** @returns le message complet si cette trame le termine, sinon null. */
  push(data: Uint8Array): Uint8Array | null {
    if (data.length === 0) return null;
    const first = data[0]!;
    switch ((first >> 4) & 0x0f) {
      case PCI.SF: {
        const len = first & 0x0f;
        if (len === 0 || len > 7) return null;
        this.rx = null;
        const msg = data.slice(1, 1 + len);
        this.messages.emit(msg);
        return msg;
      }
      case PCI.FF: {
        const expected = ((first & 0x0f) << 8) | (data[1] ?? 0);
        this.rx = { expectedLength: expected, received: [...data.slice(2, 8)], nextSequence: 1, framesSinceFc: 0 };
        return null;
      }
      case PCI.CF: {
        const rx = this.rx;
        if (!rx) return null;
        if ((first & 0x0f) !== rx.nextSequence) { this.rx = null; throw new IsoTpError("séquence ISO-TP rompue"); }
        const remaining = rx.expectedLength - rx.received.length;
        rx.received.push(...data.slice(1, 1 + Math.min(7, remaining)));
        rx.nextSequence = (rx.nextSequence + 1) & 0x0f;
        if (rx.received.length >= rx.expectedLength) {
          const msg = Uint8Array.from(rx.received.slice(0, rx.expectedLength));
          this.rx = null;
          this.messages.emit(msg);
          return msg;
        }
        return null;
      }
      default:
        return null; // FC côté réception : rien à faire ici
    }
  }
}
