import { TimeoutError, UdsNegativeResponse } from "../util/errors.ts";
import { bytesToHex, concat } from "../util/hex.ts";
import { silentLogger, type Logger } from "../util/log.ts";
import { Mutex, sleep, type MessageLink, type Unsubscribe } from "../transport/types.ts";
import { DID, RESET_TYPE, ROUTINE, SESSION, SID, nrcLabel } from "./nrc.ts";

export interface UdsOptions {
  /** P2 : délai de réponse normal. */
  p2Ms?: number;
  /** P2* : délai étendu accordé après un NRC 0x78 "réponse en préparation". */
  p2StarMs?: number;
  /** Nombre de tentatives sur NRC 0x21 (ECU occupée). */
  busyRetries?: number;
  logger?: Logger;
}

export interface RequestOptions {
  timeoutMs?: number;
  /** false pour les requêtes avec bit "suppressPosRsp" (ex. TesterPresent 0x3E 0x80). */
  expectResponse?: boolean;
}

/**
 * Fournisseur de clé pour l'accès sécurité (service 0x27).
 *
 * ⚠️ Les algorithmes seed/key des ECU BMW ne sont pas publics : ils vivent dans
 * les DLL de l'outillage constructeur. Rien de tel n'est embarqué ici. L'appli
 * expose ce point d'extension pour que l'utilisateur branche sa propre
 * implémentation, et le simulateur fournit un algorithme de démonstration.
 */
export interface KeyProvider {
  readonly name: string;
  computeKey(level: number, seed: Uint8Array, context: { target: number; ecuName?: string }): Promise<Uint8Array>;
}

export interface DtcRecord { code: number; codeHex: string; status: number; confirmed: boolean; pending: boolean; testFailed: boolean; }

export class UdsClient {
  readonly link: MessageLink;
  private readonly opts: Required<Omit<UdsOptions, "logger">>;
  private readonly log: Logger;
  private readonly lock = new Mutex();
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  constructor(link: MessageLink, options: UdsOptions = {}) {
    this.link = link;
    this.log = options.logger ?? silentLogger;
    this.opts = { p2Ms: options.p2Ms ?? 2000, p2StarMs: options.p2StarMs ?? 15000, busyRetries: options.busyRetries ?? 3 };
  }

  /** Requête brute. Renvoie la réponse complète, SID de réponse inclus. */
  rawRequest(request: Uint8Array, options: RequestOptions = {}): Promise<Uint8Array> {
    return this.lock.run(() => this.exchange(request, options));
  }

  /** Requête par service. Renvoie la réponse *sans* le SID. */
  async request(sid: number, data: Uint8Array = new Uint8Array(0), options: RequestOptions = {}): Promise<Uint8Array> {
    const response = await this.rawRequest(concat(Uint8Array.of(sid), data), options);
    return response.slice(1);
  }

  private async exchange(request: Uint8Array, options: RequestOptions): Promise<Uint8Array> {
    const sid = request[0]!;
    const expect = options.expectResponse !== false;
    let attempt = 0;

    while (true) {
      const waiter = expect ? this.waitForResponse(sid, options.timeoutMs ?? this.opts.p2Ms) : null;
      this.log.debug(`${this.link.name} -> ${bytesToHex(request, " ")}`);
      await this.link.send(request);
      if (!waiter) return new Uint8Array(0);

      const response = await waiter;
      this.log.debug(`${this.link.name} <- ${bytesToHex(response, " ")}`);

      if (response[0] === 0x7f) {
        const nrc = response[2] ?? 0;
        if (nrc === 0x21 && attempt < this.opts.busyRetries) { attempt++; await sleep(100 * attempt); continue; }
        throw new UdsNegativeResponse(sid, nrc, nrcLabel(nrc));
      }
      return response;
    }
  }

  /**
   * Attend la réponse au service demandé. Un NRC 0x78 ne termine pas l'attente :
   * l'ECU annonce qu'elle travaille (effacement de mémoire, écriture de codage)
   * et on lui accorde alors P2* au lieu de P2.
   */
  private waitForResponse(sid: number, timeoutMs: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let off: Unsubscribe = () => {};
      const fail = (ms: number) => {
        timer = setTimeout(() => { off(); reject(new TimeoutError(`${this.link.name}: pas de réponse au service 0x${sid.toString(16)} (${ms} ms)`)); }, ms);
      };
      off = this.link.onMessage((payload) => {
        if (payload.length === 0) return;
        const isPositive = payload[0] === (sid + 0x40);
        const isNegative = payload[0] === 0x7f && payload[1] === sid;
        if (!isPositive && !isNegative) return;              // réponse d'un autre service : on ignore
        if (isNegative && payload[2] === 0x78) {             // réponse en préparation
          clearTimeout(timer);
          this.log.debug(`${this.link.name}: ECU occupée (0x78), attente étendue`);
          fail(this.opts.p2StarMs);
          return;
        }
        clearTimeout(timer);
        off();
        resolve(payload);
      });
      fail(timeoutMs);
    });
  }

  // ---------------------------------------------------------------- services

  async startSession(level: number = SESSION.EXTENDED): Promise<Uint8Array> {
    return this.request(SID.DIAGNOSTIC_SESSION_CONTROL, Uint8Array.of(level));
  }

  async ecuReset(type: number = RESET_TYPE.HARD): Promise<void> {
    await this.request(SID.ECU_RESET, Uint8Array.of(type));
  }

  async testerPresent(suppressResponse = true): Promise<void> {
    await this.request(SID.TESTER_PRESENT, Uint8Array.of(suppressResponse ? 0x80 : 0x00), { expectResponse: !suppressResponse });
  }

  /** Maintient la session ouverte pendant une opération longue (codage). */
  startKeepAlive(intervalMs = 2000): void {
    this.stopKeepAlive();
    this.keepAlive = setInterval(() => {
      this.testerPresent(true).catch((e) => this.log.debug(`keep-alive échoué: ${String(e)}`));
    }, intervalMs);
    this.keepAlive.unref?.();
  }

  stopKeepAlive(): void {
    if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
  }

  async readDataByIdentifier(did: number): Promise<Uint8Array> {
    const response = await this.request(SID.READ_DATA_BY_IDENTIFIER, Uint8Array.of((did >> 8) & 0xff, did & 0xff));
    const echo = ((response[0] ?? 0) << 8) | (response[1] ?? 0);
    if (echo !== did) throw new Error(`l'ECU a répondu pour le DID 0x${echo.toString(16)} au lieu de 0x${did.toString(16)}`);
    return response.slice(2);
  }

  async writeDataByIdentifier(did: number, data: Uint8Array): Promise<void> {
    await this.request(SID.WRITE_DATA_BY_IDENTIFIER, concat(Uint8Array.of((did >> 8) & 0xff, did & 0xff), data));
  }

  async readVin(): Promise<string> {
    const raw = await this.readDataByIdentifier(DID.VIN);
    return new TextDecoder().decode(raw).replace(/[^\x20-\x7e]/g, "").trim();
  }

  async routineControl(subFunction: number, routineId: number, data: Uint8Array = new Uint8Array(0)): Promise<Uint8Array> {
    const response = await this.request(SID.ROUTINE_CONTROL, concat(Uint8Array.of(subFunction, (routineId >> 8) & 0xff, routineId & 0xff), data));
    return response.slice(3);
  }

  /** Accès sécurité : demande de graine puis envoi de la clé. */
  async securityAccess(level: number, provider: KeyProvider, ecuName?: string): Promise<void> {
    const seed = (await this.request(SID.SECURITY_ACCESS, Uint8Array.of(level))).slice(1);
    if (seed.every((byte) => byte === 0)) { this.log.info("ECU déjà déverrouillée (graine nulle)"); return; }
    const key = await provider.computeKey(level, seed, { target: this.link.target, ecuName });
    await this.request(SID.SECURITY_ACCESS, concat(Uint8Array.of(level + 1), key));
    this.log.info(`accès sécurité niveau 0x${level.toString(16)} accordé (${provider.name})`);
  }

  async readDtcs(statusMask = 0xff): Promise<DtcRecord[]> {
    const response = await this.request(SID.READ_DTC_INFORMATION, Uint8Array.of(0x02, statusMask));
    const records: DtcRecord[] = [];
    for (let i = 2; i + 3 < response.length + 1 && i + 3 <= response.length; i += 4) {
      const code = ((response[i] ?? 0) << 16) | ((response[i + 1] ?? 0) << 8) | (response[i + 2] ?? 0);
      const status = response[i + 3] ?? 0;
      records.push({
        code,
        codeHex: code.toString(16).toUpperCase().padStart(6, "0"),
        status,
        testFailed: (status & 0x01) !== 0,
        pending: (status & 0x04) !== 0,
        confirmed: (status & 0x08) !== 0,
      });
    }
    return records;
  }

  async clearDtcs(group = 0xffffff): Promise<void> {
    await this.request(SID.CLEAR_DIAGNOSTIC_INFORMATION, Uint8Array.of((group >> 16) & 0xff, (group >> 8) & 0xff, group & 0xff));
  }

  // ------------------------------------------------- transferts (bloc codage)

  /**
   * Lit un bloc mémoire via 0x35 RequestUpload + 0x36 TransferData.
   * C'est ainsi qu'on récupère le bloc de données de codage (NCD) d'une ECU.
   */
  async uploadBlock(address: number, size: number, formatIdentifier = 0x00): Promise<Uint8Array> {
    const alfid = 0x44; // 4 octets d'adresse, 4 octets de longueur
    const header = new Uint8Array(10);
    header[0] = formatIdentifier;
    header[1] = alfid;
    new DataView(header.buffer).setUint32(2, address, false);
    new DataView(header.buffer).setUint32(6, size, false);
    await this.request(SID.REQUEST_UPLOAD, header);

    const chunks: Uint8Array[] = [];
    let counter = 1;
    let received = 0;
    while (received < size) {
      const response = await this.request(SID.TRANSFER_DATA, Uint8Array.of(counter & 0xff), { timeoutMs: this.opts.p2StarMs });
      const data = response.slice(1);
      if (data.length === 0) break;
      chunks.push(data);
      received += data.length;
      counter++;
    }
    await this.request(SID.REQUEST_TRANSFER_EXIT);
    return concat(...chunks).slice(0, size);
  }

  /**
   * Écrit un bloc mémoire via 0x34 RequestDownload + 0x36 TransferData + 0x37.
   * `maxBlockLength` est imposé par l'ECU dans sa réponse au 0x34.
   */
  async downloadBlock(address: number, data: Uint8Array, formatIdentifier = 0x00): Promise<void> {
    const alfid = 0x44;
    const header = new Uint8Array(10);
    header[0] = formatIdentifier;
    header[1] = alfid;
    new DataView(header.buffer).setUint32(2, address, false);
    new DataView(header.buffer).setUint32(6, data.length, false);
    const response = await this.request(SID.REQUEST_DOWNLOAD, header);

    const lengthFormat = (response[0] ?? 0x20) >> 4;
    let maxBlockLength = 0;
    for (let i = 0; i < lengthFormat; i++) maxBlockLength = (maxBlockLength << 8) | (response[1 + i] ?? 0);
    const payloadPerBlock = Math.max(1, (maxBlockLength || 0x100) - 2); // - SID - compteur
    this.log.debug(`téléchargement: ${data.length} o par blocs de ${payloadPerBlock} o`);

    let counter = 1;
    for (let offset = 0; offset < data.length; offset += payloadPerBlock) {
      const chunk = data.slice(offset, offset + payloadPerBlock);
      await this.request(SID.TRANSFER_DATA, concat(Uint8Array.of(counter & 0xff), chunk), { timeoutMs: this.opts.p2StarMs });
      counter++;
    }
    await this.request(SID.REQUEST_TRANSFER_EXIT, new Uint8Array(0), { timeoutMs: this.opts.p2StarMs });
  }

  async close(): Promise<void> { this.stopKeepAlive(); await this.link.close(); }
}

export { DID, RESET_TYPE, ROUTINE, SESSION, SID };
