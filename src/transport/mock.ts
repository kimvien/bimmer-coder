import { Emitter, type Transport, type Unsubscribe } from "./types.ts";

/**
 * Transport en mémoire. Deux MockTransport reliés par `pair()` forment un câble
 * virtuel : on branche l'app d'un côté, l'émulateur d'adaptateur de l'autre.
 */
export class MockTransport implements Transport {
  readonly name: string;
  isOpen = false;
  private readonly data = new Emitter<Uint8Array>();
  private peer: MockTransport | null = null;
  /** Tout ce qui a été écrit, pour les assertions de test. */
  readonly written: Uint8Array[] = [];
  /** Latence simulée du lien (ms) — utile pour tester les timeouts. */
  latencyMs = 0;

  constructor(name = "mock") { this.name = name; }

  static pair(nameA = "mock:a", nameB = "mock:b"): [MockTransport, MockTransport] {
    const a = new MockTransport(nameA);
    const b = new MockTransport(nameB);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  async open(): Promise<void> { this.isOpen = true; if (this.peer) this.peer.isOpen = true; }
  async close(): Promise<void> { this.isOpen = false; this.data.clear(); }

  async write(chunk: Uint8Array): Promise<void> {
    this.written.push(chunk);
    const deliver = () => this.peer?.data.emit(chunk);
    if (this.latencyMs > 0) setTimeout(deliver, this.latencyMs);
    else deliver();
  }

  /** Injecte des octets comme s'ils venaient du câble (tests de parsing). */
  inject(chunk: Uint8Array): void { this.data.emit(chunk); }

  onData(cb: (chunk: Uint8Array) => void): Unsubscribe { return this.data.on(cb); }
}
