import { bytesToHex } from "../util/hex.ts";
import { silentLogger, type Logger } from "../util/log.ts";
import { Emitter, type CanFrame, type CanLink, type Unsubscribe } from "../transport/types.ts";

/** Bus CAN en mémoire : ce qu'un nœud émet, tous les autres le reçoivent. */
export class VirtualCanBus {
  private readonly nodes = new Set<Emitter<CanFrame>>();
  private readonly log: Logger;
  /** Historique des trames, pour les assertions de test. */
  readonly traffic: Array<{ from: string; frame: CanFrame }> = [];

  constructor(log: Logger = silentLogger) { this.log = log; }

  attach(name: string): CanLink {
    const inbox = new Emitter<CanFrame>();
    this.nodes.add(inbox);
    const bus = this;
    return {
      name: `vbus:${name}`,
      async send(frame: CanFrame): Promise<void> {
        bus.traffic.push({ from: name, frame });
        bus.log.trace(`${name} > ${frame.id.toString(16)} ${bytesToHex(frame.data, " ")}`);
        for (const node of bus.nodes) if (node !== inbox) node.emit(frame);
      },
      onFrame(cb: (frame: CanFrame) => void): Unsubscribe { return inbox.on(cb); },
      async close(): Promise<void> { bus.nodes.delete(inbox); inbox.clear(); },
    };
  }
}
