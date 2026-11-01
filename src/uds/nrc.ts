/** Codes de réponse négative UDS (ISO 14229), libellés en français. */
export const NRC: Record<number, string> = {
  0x10: "rejet général",
  0x11: "service non supporté",
  0x12: "sous-fonction non supportée",
  0x13: "longueur de message incorrecte",
  0x14: "réponse trop longue",
  0x21: "ECU occupée, réessayer",
  0x22: "conditions non remplies (contact, moteur, vitesse...)",
  0x24: "séquence de requêtes incorrecte",
  0x25: "pas de réponse d'un sous-composant",
  0x31: "requête hors plage (identifiant ou valeur invalide)",
  0x33: "accès sécurité refusé",
  0x35: "clé invalide",
  0x36: "trop de tentatives de clé",
  0x37: "délai avant nouvelle tentative non écoulé",
  0x70: "échec d'écriture mémoire",
  0x71: "transfert de données suspendu",
  0x72: "erreur de programmation mémoire",
  0x73: "compteur de bloc erroné",
  0x78: "réponse en cours de préparation",
  0x7e: "sous-fonction non supportée dans cette session",
  0x7f: "service non supporté dans cette session",
  0x81: "régime moteur trop élevé",
  0x82: "régime moteur trop bas",
  0x83: "moteur en marche",
  0x84: "moteur à l'arrêt",
  0x87: "véhicule en mouvement",
  0x92: "tension d'alimentation trop élevée",
  0x93: "tension d'alimentation trop basse",
};

export const nrcLabel = (nrc: number): string => NRC[nrc] ?? `inconnu (0x${nrc.toString(16)})`;

/** Services UDS utilisés par l'application. */
export const SID = {
  DIAGNOSTIC_SESSION_CONTROL: 0x10,
  ECU_RESET: 0x11,
  CLEAR_DIAGNOSTIC_INFORMATION: 0x14,
  READ_DTC_INFORMATION: 0x19,
  READ_DATA_BY_IDENTIFIER: 0x22,
  READ_MEMORY_BY_ADDRESS: 0x23,
  SECURITY_ACCESS: 0x27,
  WRITE_DATA_BY_IDENTIFIER: 0x2e,
  ROUTINE_CONTROL: 0x31,
  REQUEST_DOWNLOAD: 0x34,
  REQUEST_UPLOAD: 0x35,
  TRANSFER_DATA: 0x36,
  REQUEST_TRANSFER_EXIT: 0x37,
  TESTER_PRESENT: 0x3e,
} as const;

export const SESSION = { DEFAULT: 0x01, PROGRAMMING: 0x02, EXTENDED: 0x03, SAFETY: 0x04 } as const;
export const RESET_TYPE = { HARD: 0x01, KEY_OFF_ON: 0x02, SOFT: 0x03 } as const;
export const ROUTINE = { START: 0x01, STOP: 0x02, REQUEST_RESULTS: 0x03 } as const;

/** Identifiants de données standard, communs à toutes les ECU BMW. */
export const DID = {
  VIN: 0xf190,
  ECU_SERIAL: 0xf18c,
  SW_NUMBER: 0xf188,
  HW_NUMBER: 0xf191,
  SUPPLIER_ECU_HW_VERSION: 0xf193,
  PROGRAMMING_DATE: 0xf199,
  ACTIVE_SESSION: 0xf186,
} as const;
