import { AdapterError, TimeoutError } from "../util/errors.ts";
import { bytesToHex, hexToBytes } from "../util/hex.ts";
import { silentLogger, type Logger } from "../util/log.ts";
import { Emitter, Mutex, type CanFrame, type CanLink, type MessageLink, type Transport, type Unsubscribe } from "../transport/types.ts";
import { IsoTpReassembler } from "../isotp/isotp.ts";

/** Protocoles ELM327 utiles côté BMW. */
export const ELM_PROTOCOL = {
  /** ISO 15765-4 CAN, 11 bits, 500 kbit/s — PT-CAN (moteur, boîte, châssis). */
  CAN_11B_500K: "6",
  /** ISO 15765-4 CAN, 29 bits, 500 kbit/s. */
  CAN_29B_500K: "7",
  /** ISO 15765-4 CAN, 11 bits, 250 kbit/s. */
  CAN_11B_250K: "8",
  /** ISO 15765-4 CAN, 29 bits, 250 kbit/s. */
  CAN_29B_250K: "9",
  /** Protocole utilisateur B — à paramétrer via ATPB pour le K-CAN BMW (100 kbit/s). */
  USER_B: "B",
} as const;

export interface Elm327Options {
  protocol?: string;
  /** Identifiants CAN sur 29 bits (influence le parsing des en-têtes reçus). */
  extendedIds?: boolean;
  /** Timeout d'une commande AT / d'un échange. */
  commandTimeoutMs?: number;
  /** Laisse l'adaptateur gérer la segmentation ISO-TP (recommandé : OBDLink). */
  autoFormat?: boolean;
  logger?: Logger;
}

const ELM_ERRORS = [
  "NO DATA", "CAN ERROR", "BUS ERROR", "BUS BUSY", "BUFFER FULL",
  "UNABLE TO CONNECT", "STOPPED", "ERROR", "FB ERROR", "DATA ERROR", "<RX ERROR",
];

/**
 * Pilote ELM327 / STN (OBDLink). Protocole texte : commandes terminées par \r,
 * réponses terminées par le prompt ">".
 *
 * Les clones ELM327 bas de gamme échouent dès qu'il faut du multi-trame ou un
 * en-tête personnalisé — raison pour laquelle BimmerCode impose une liste
 * d'adaptateurs. `probe()` vérifie ici les capacités réellement nécessaires.
 */
export class Elm327Adapter {
  readonly transport: Transport;
  private readonly opts: Required<Omit<Elm327Options, "logger">>;
  private readonly log: Logger;
  private readonly lock = new Mutex();
  private buffer = "";
  private readonly lines = new Emitter<string>();
  private readonly prompt = new Emitter<void>();
  private unsub: Unsubscribe | null = null;
  private currentHeader: string | null = null;
  private currentFilter: string | null = null;
  private currentExtendedAddress: string | null = null;
  /** Version renvoyée par ATZ/ATI, ex. "ELM327 v1.5" ou "STN2120 v5.x". */
  version = "";

  constructor(transport: Transport, options: Elm327Options = {}) {
    this.transport = transport;
    this.log = options.logger ?? silentLogger;
    this.opts = {
      protocol: options.protocol ?? ELM_PROTOCOL.CAN_11B_500K,
      extendedIds: options.extendedIds ?? false,
      commandTimeoutMs: options.commandTimeoutMs ?? 5000,
      autoFormat: options.autoFormat ?? true,
    };
  }

  async open(): Promise<void> {
    if (!this.transport.isOpen) await this.transport.open();
    this.unsub = this.transport.onData((chunk) => this.ingest(chunk));
    await this.init();
  }

  async close(): Promise<void> {
    this.unsub?.();
    this.lines.clear();
    this.prompt.clear();
    await this.transport.close();
  }

  /** Séquence d'initialisation. L'ordre compte : écho coupé avant tout parsing. */
  private async init(): Promise<void> {
    this.version = (await this.command("ATZ", 3000)).join(" ").trim();   // reset
    await this.command("ATE0");                                          // écho off
    await this.command("ATL0");                                          // pas de linefeed
    await this.command("ATS0");                                          // pas d'espaces
    await this.command("ATH1");                                          // en-têtes affichés (indispensable)
    await this.command("ATAL");                                          // autorise les messages longs
    await this.command(`ATSP${this.opts.protocol}`);                     // protocole
    await this.command(this.opts.autoFormat ? "ATCAF1" : "ATCAF0");      // formatage ISO-TP par l'adaptateur
    if (this.opts.autoFormat) {
      await this.command("ATCFC1");                                      // FC automatiques
      await this.command("ATFCSM0");
    }
    await this.command("ATAT1");                                         // timing adaptatif
    await this.command("ATST32");                                        // timeout ~200 ms
    this.log.info(`adaptateur prêt: ${this.version || "inconnu"} (protocole ${this.opts.protocol})`);
  }

  /**
   * Vérifie les capacités dont dépend le codage : en-tête libre, filtre de
   * réception, messages longs. Un clone qui répond "?" ici n'ira pas plus loin.
   */
  async probe(): Promise<{ ok: boolean; version: string; missing: string[] }> {
    const missing: string[] = [];
    for (const [cmd, label] of [["ATSH6F1", "en-tête personnalisé (ATSH)"], ["ATCRA612", "filtre de réception (ATCRA)"], ["ATAL", "messages longs (ATAL)"]] as const) {
      try {
        const res = await this.command(cmd);
        if (res.some((l) => l.includes("?"))) missing.push(label);
      } catch { missing.push(label); }
    }
    await this.command("ATCRA");  // réinitialise le filtre
    this.currentFilter = null;
    return { ok: missing.length === 0, version: this.version, missing };
  }

  /** Envoie une commande et renvoie les lignes de réponse (hors prompt). */
  command(cmd: string, timeoutMs = this.opts.commandTimeoutMs): Promise<string[]> {
    return this.lock.run(() => this.rawCommand(cmd, timeoutMs));
  }

  private rawCommand(cmd: string, timeoutMs: number): Promise<string[]> {
    const collected: string[] = [];
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new TimeoutError(`ELM327: pas de réponse à "${cmd}"`)); }, timeoutMs);
      const offLines = this.lines.on((line) => { if (line) collected.push(line); });
      const offPrompt = this.prompt.on(() => { cleanup(); resolve(collected); });
      const cleanup = () => { clearTimeout(timer); offLines(); offPrompt(); };
      this.log.trace(`-> ${cmd}`);
      this.transport.write(new TextEncoder().encode(cmd + "\r")).catch((e) => { cleanup(); reject(e); });
    });
  }

  private ingest(chunk: Uint8Array): void {
    this.buffer += new TextDecoder().decode(chunk);
    // Les lignes sont séparées par \r ; ">" marque la fin de la réponse.
    while (true) {
      const idx = this.buffer.search(/[\r\n>]/);
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim();
      const sep = this.buffer[idx]!;
      this.buffer = this.buffer.slice(idx + 1);
      if (line) { this.log.trace(`<- ${line}`); this.lines.emit(line); }
      if (sep === ">") this.prompt.emit();
    }
  }

  private static assertNoError(lines: string[], context: string): void {
    for (const line of lines) {
      const upper = line.toUpperCase();
      if (ELM_ERRORS.some((e) => upper.includes(e))) throw new AdapterError(`ELM327 "${line}" (${context})`);
      if (upper.startsWith("?")) throw new AdapterError(`ELM327 n'a pas compris la commande (${context})`);
    }
  }

  private async setHeader(id: number): Promise<void> {
    const hex = id.toString(16).toUpperCase().padStart(this.opts.extendedIds ? 8 : 3, "0");
    if (this.currentHeader === hex) return;
    Elm327Adapter.assertNoError(await this.rawCommand(`ATSH${hex}`, this.opts.commandTimeoutMs), "ATSH");
    this.currentHeader = hex;
  }

  private async setFilter(id: number): Promise<void> {
    const hex = id.toString(16).toUpperCase().padStart(this.opts.extendedIds ? 8 : 3, "0");
    if (this.currentFilter === hex) return;
    Elm327Adapter.assertNoError(await this.rawCommand(`ATCRA${hex}`, this.opts.commandTimeoutMs), "ATCRA");
    this.currentFilter = hex;
  }

  /** Adressage étendu CAN (ATCEA) : requis pour parler aux ECU BMW en mode auto. */
  private async setExtendedAddress(address: number): Promise<void> {
    const hex = (address & 0xff).toString(16).toUpperCase().padStart(2, "0");
    if (this.currentExtendedAddress === hex) return;
    const lines = await this.rawCommand(`ATCEA${hex}`, this.opts.commandTimeoutMs);
    if (lines.some((l) => l.includes("?"))) {
      throw new AdapterError("cet adaptateur ne gère pas l'adressage étendu (ATCEA) : utilisez isoTpMode \"app\"");
    }
    this.currentExtendedAddress = hex;
  }

  /** Découpe une ligne "7E8037F2211" en { id, data }. */
  parseFrameLine(line: string): CanFrame | null {
    const clean = line.replace(/\s/g, "").toUpperCase();
    const idLen = this.opts.extendedIds ? 8 : 3;
    if (clean.length <= idLen || !/^[0-9A-F]+$/.test(clean)) return null;
    const idHex = clean.slice(0, idLen);
    let payload = clean.slice(idLen);
    if (payload.length % 2 !== 0) payload = payload.slice(0, -1); // ligne tronquée
    return { id: parseInt(idHex, 16), data: hexToBytes(payload) };
  }

  /**
   * Ouvre un lien "message" vers une ECU : on écrit la requête UDS complète,
   * l'adaptateur segmente, et on réassemble les trames de réponse.
   */
  openMessageLink(txId: number, rxId: number, extendedAddress?: number): MessageLink {
    const adapter = this;
    const reassembler = new IsoTpReassembler();
    const messages = new Emitter<Uint8Array>();

    return {
      name: `elm327(${txId.toString(16)}->${rxId.toString(16)})`,
      target: rxId,
      async send(payload: Uint8Array): Promise<void> {
        await adapter.lock.run(async () => {
          await adapter.setHeader(txId);
          await adapter.setFilter(rxId);
          if (extendedAddress !== undefined) await adapter.setExtendedAddress(extendedAddress);
          reassembler.reset();
          const lines = await adapter.rawCommand(bytesToHex(payload), adapter.opts.commandTimeoutMs);
          Elm327Adapter.assertNoError(lines, `envoi ${bytesToHex(payload, " ")}`);
          for (const line of lines) {
            const frame = adapter.parseFrameLine(line);
            if (!frame || frame.id !== rxId) continue;
            const complete = reassembler.push(frame.data);
            if (complete) messages.emit(complete);
          }
        });
      },
      onMessage(cb) { return messages.on(cb); },
      async close(): Promise<void> { messages.clear(); },
    };
  }

  /** Lien CAN brut (ATCAF0) : c'est nous qui faisons l'ISO-TP. Pour le sniffing/expert. */
  openCanLink(): CanLink {
    const adapter = this;
    const frames = new Emitter<CanFrame>();
    const off = this.lines.on((line) => {
      const frame = adapter.parseFrameLine(line);
      if (frame) frames.emit(frame);
    });
    return {
      name: "elm327:can",
      async send(frame: CanFrame): Promise<void> {
        await adapter.lock.run(async () => {
          await adapter.setHeader(frame.id);
          await adapter.rawCommand(bytesToHex(frame.data), adapter.opts.commandTimeoutMs);
        });
      },
      onFrame(cb) { return frames.on(cb); },
      async close(): Promise<void> { off(); frames.clear(); },
    };
  }
}
