export class TransportError extends Error {}
export class AdapterError extends Error {}
export class TimeoutError extends Error {}

export class IsoTpError extends Error {}

/** Réponse négative UDS (0x7F). `nrc` = Negative Response Code. */
export class UdsNegativeResponse extends Error {
  readonly service: number;
  readonly nrc: number;
  readonly label: string;
  constructor(service: number, nrc: number, label: string) {
    super(`UDS NRC 0x${nrc.toString(16).padStart(2, "0")} (${label}) sur service 0x${service.toString(16).padStart(2, "0")}`);
    this.service = service;
    this.nrc = nrc;
    this.label = label;
  }
}

/** Refus du moteur de codage : garde-fou déclenché avant toute écriture. */
export class CodingGuardError extends Error {}
