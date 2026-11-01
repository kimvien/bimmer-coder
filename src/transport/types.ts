/**
 * Pile de communication, en 3 niveaux. Chaque niveau est remplaçable, ce qui
 * permet de tester tout le reste sans voiture (voir src/sim/).
 *
 *   Transport    flux d'octets brut   (BLE, TCP/Wi-Fi, USB série, mock)
 *   CanLink      trames CAN           (ELM327 en mode brut ATCAF0)
 *   MessageLink  messages complets    (ISO-TP par-dessus CanLink, ou DoIP/ENET direct)
 *                                     -> c'est ce que consomme UdsClient
 */

export type Unsubscribe = () => void;

export interface Transport {
  readonly name: string;
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  onData(cb: (chunk: Uint8Array) => void): Unsubscribe;
}

export interface CanFrame {
  /** Identifiant CAN (11 ou 29 bits). */
  id: number;
  data: Uint8Array;
}

export interface CanLink {
  readonly name: string;
  send(frame: CanFrame): Promise<void>;
  onFrame(cb: (frame: CanFrame) => void): Unsubscribe;
  close(): Promise<void>;
}

/** Un lien capable de transporter un message de diagnostic complet (jusqu'à 4095+ octets). */
export interface MessageLink {
  readonly name: string;
  /** Adresse logique / diag du destinataire, pour les logs et le routage. */
  readonly target: number;
  send(payload: Uint8Array): Promise<void>;
  onMessage(cb: (payload: Uint8Array) => void): Unsubscribe;
  close(): Promise<void>;
}

/** Petit bus d'abonnés, réutilisé par toutes les implémentations. */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  on(cb: (value: T) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  emit(value: T): void {
    for (const cb of [...this.listeners]) {
      try { cb(value); } catch { /* un abonné fautif ne casse pas le bus */ }
    }
  }
  get size(): number { return this.listeners.size; }
  clear(): void { this.listeners.clear(); }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Sérialise les accès concurrents (un seul échange en vol sur un bus de diag). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
