import net from "node:net";
import { Emitter, type Transport, type Unsubscribe } from "./types.ts";
import { TransportError } from "../util/errors.ts";

/**
 * Transport TCP : couvre les deux cas Wi-Fi du monde BMW
 *  - adaptateur ELM327 Wi-Fi            : 192.168.0.10:35000
 *  - câble/boîtier ENET (F/G series)    : 169.254.x.x:6801 (ENET) ou :13400 (DoIP)
 */
export class TcpTransport implements Transport {
  readonly name: string;
  private socket: net.Socket | null = null;
  private readonly data = new Emitter<Uint8Array>();

  private readonly host: string;
  private readonly port: number;
  private readonly connectTimeoutMs: number;

  constructor(host: string, port: number, connectTimeoutMs = 5000) {
    this.host = host;
    this.port = port;
    this.connectTimeoutMs = connectTimeoutMs;
    this.name = `tcp://${host}:${port}`;
  }

  get isOpen(): boolean { return !!this.socket && !this.socket.destroyed; }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      sock.setNoDelay(true);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new TransportError(`connexion ${this.name} : délai dépassé`));
      }, this.connectTimeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        this.socket = sock;
        sock.on("data", (buf) => this.data.emit(new Uint8Array(buf)));
        sock.on("error", () => { /* remonté au close */ });
        resolve();
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(new TransportError(`${this.name} : ${err.message}`));
      });
    });
  }

  async close(): Promise<void> {
    this.socket?.destroy();
    this.socket = null;
    this.data.clear();
  }

  write(data: Uint8Array): Promise<void> {
    const sock = this.socket;
    if (!sock) throw new TransportError(`${this.name} fermé`);
    return new Promise((resolve, reject) => {
      sock.write(data, (err) => (err ? reject(new TransportError(err.message)) : resolve()));
    });
  }

  onData(cb: (chunk: Uint8Array) => void): Unsubscribe { return this.data.on(cb); }
}
