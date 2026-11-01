import { bytesToHex, hexToBytes } from "../util/hex.ts";
import { silentLogger, type Logger } from "../util/log.ts";
import type { CanFrame, CanLink, Unsubscribe } from "../transport/types.ts";
import type { MockTransport } from "../transport/mock.ts";

/**
 * Émulateur d'adaptateur ELM327 (mode trames brutes).
 *
 * Il parle le même dialecte texte qu'un vrai dongle : commandes AT, prompt ">",
 * en-têtes affichés. Branché sur un MockTransport d'un côté et sur le bus CAN
 * virtuel de l'autre, il permet de tester le pilote ELM327 lui-même, pas
 * seulement les couches au-dessus.
 */
export class VirtualElm327 {
  readonly version: string;
  private readonly transport: MockTransport;
  private readonly link: CanLink;
  private readonly log: Logger;
  private readonly unsub: Unsubscribe;
  private buffer = "";
  private header = 0x7df;
  private filter: number | null = null;
  private echo = false;
  private headersShown = true;
  private autoFormat = false;
  /** Commandes AT reçues, pour vérifier la séquence d'init dans les tests. */
  readonly commands: string[] = [];

  /** Faux dongle bas de gamme : refuse l'adressage étendu (ATCEA). */
  private readonly supportsExtendedAddressing: boolean;

  constructor(transport: MockTransport, link: CanLink, options: { version?: string; logger?: Logger; supportsExtendedAddressing?: boolean } = {}) {
    this.transport = transport;
    this.link = link;
    this.supportsExtendedAddressing = options.supportsExtendedAddressing ?? true;
    this.version = options.version ?? "ELM327 v1.5";
    this.log = options.logger ?? silentLogger;
    void this.transport.open();
    this.transport.onData((chunk) => { void this.ingest(chunk); });
    this.unsub = this.link.onFrame((frame) => this.onBusFrame(frame));
  }

  async close(): Promise<void> { this.unsub(); await this.link.close(); }

  private write(text: string): void { void this.transport.write(new TextEncoder().encode(text)); }

  private onBusFrame(frame: CanFrame): void {
    if (this.filter !== null && frame.id !== this.filter) return;
    const idHex = frame.id.toString(16).toUpperCase().padStart(3, "0");
    this.write(`${this.headersShown ? idHex : ""}${bytesToHex(frame.data)}\r`);
  }

  private async ingest(chunk: Uint8Array): Promise<void> {
    this.buffer += new TextDecoder().decode(chunk);
    while (true) {
      const idx = this.buffer.indexOf("\r");
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) await this.execute(line);
    }
  }

  private async execute(raw: string): Promise<void> {
    const cmd = raw.replace(/\s/g, "").toUpperCase();
    if (this.echo) this.write(raw + "\r");

    if (cmd.startsWith("AT")) {
      this.commands.push(cmd);
      this.write(this.handleAt(cmd) + "\r>");
      return;
    }

    // Trame de données : on l'émet sur le bus avec l'en-tête courant.
    try {
      const data = hexToBytes(cmd);
      await this.link.send({ id: this.header, data });
    } catch {
      this.write("?\r>");
      return;
    }
    // Laisse les ECU répondre (leurs trames s'impriment via onBusFrame),
    // comme un vrai ELM327 qui écoute jusqu'à son timeout ATST.
    await new Promise((resolve) => setTimeout(resolve, 2));
    this.write(">");
  }

  private handleAt(cmd: string): string {
    const body = cmd.slice(2);
    if (body === "Z" || body === "D" || body === "WS") { this.reset(); return `\r${this.version}\r`; }
    if (body === "I") return this.version;
    if (body === "E0") { this.echo = false; return "OK"; }
    if (body === "E1") { this.echo = true; return "OK"; }
    if (body === "H0") { this.headersShown = false; return "OK"; }
    if (body === "H1") { this.headersShown = true; return "OK"; }
    if (body === "CAF0") { this.autoFormat = false; return "OK"; }
    if (body === "CAF1") { this.autoFormat = true; return "OK"; }
    if (body.startsWith("SH")) { this.header = parseInt(body.slice(2), 16); return "OK"; }
    if (body.startsWith("CRA")) {
      const arg = body.slice(3);
      this.filter = arg ? parseInt(arg, 16) : null;
      return "OK";
    }
    if (body.startsWith("CEA") && !this.supportsExtendedAddressing) return "?";
    if (/^(L[01]|S[01]|AL|AT[0-2]|ST[0-9A-F]{1,2}|SP[0-9AB]|CFC[01]|FCSM[0-2]|CEA[0-9A-F]{0,2}|FCSH[0-9A-F]+|FCSD[0-9A-F]+|M[01]|PB[0-9A-F]+)$/.test(body)) return "OK";
    return "?";
  }

  private reset(): void {
    this.header = 0x7df;
    this.filter = null;
    this.echo = false;
    this.headersShown = false;
    this.autoFormat = true;
    this.log.debug("émulateur ELM327: reset");
  }
}
