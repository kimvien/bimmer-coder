import type { IsoTpConfig } from "../isotp/isotp.ts";

/**
 * Adressage BMW sur bus CAN.
 *
 * BMW n'utilise pas les identifiants OBD normalisés (0x7E0/0x7E8) pour le
 * diagnostic constructeur, mais un adressage étendu :
 *
 *   testeur -> ECU : identifiant 0x6F1, 1er octet = adresse de l'ECU
 *   ECU -> testeur : identifiant 0x600 + adresse ECU, 1er octet = 0xF1
 *
 * C'est pour cela qu'un adaptateur incapable de changer l'en-tête CAN
 * (ATSH/ATCEA) ne peut rien coder : il ne sait parler qu'OBD standard.
 */
export const TESTER_ADDRESS = 0xf1;
export const TESTER_CAN_ID = 0x6f1;

export function bmwIsoTpConfig(ecuAddress: number): IsoTpConfig {
  return {
    txId: TESTER_CAN_ID,
    rxId: 0x600 + (ecuAddress & 0xff),
    extendedAddress: ecuAddress & 0xff,
    extendedAddressRx: TESTER_ADDRESS,
    blockSize: 0,
    stMinMs: 0,
    padding: 0x00,
  };
}

/** Adressage OBD-II normalisé (lecture de DTC génériques, mode 0x01). */
export function obdIsoTpConfig(functional = false): IsoTpConfig {
  return { txId: functional ? 0x7df : 0x7e0, rxId: 0x7e8, extendedAddress: null, padding: 0x00 };
}
