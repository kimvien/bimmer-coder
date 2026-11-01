import type { ChassisFamily } from "./modules.ts";

export interface VinInfo {
  vin: string;
  valid: boolean;
  /** Code constructeur (WBA = BMW Allemagne, WMW = Mini...). */
  wmi: string;
  /** Code modèle/plateforme (positions 4-7 du VIN). */
  typeCode: string;
  /** Série déduite, ex. "F30", "G20" — null si non reconnue. */
  chassis: string | null;
  family: ChassisFamily;
  /** Année de production déduite (position 10), approximative. */
  modelYear: number | null;
}

/**
 * Codes type BMW les plus courants. Volontairement partiel : on préfère
 * renvoyer `null` que d'affirmer une plateforme fausse, car le choix de
 * plateforme conditionne ensuite les offsets de codage.
 */
const TYPE_CODES: Record<string, string> = {
  // Série 1 / 2
  "1A1": "F20", "1B3": "F20", "1C1": "F21", "1V1": "F22", "1Z1": "F23",
  // Série 3 / 4
  "3A9": "F30", "3B1": "F30", "3C9": "F31", "3D9": "F34", "3E1": "F32", "3F9": "F33", "3G1": "F36",
  "5R1": "G20", "5V1": "G20", "5W3": "G21",
  // Série 5 / 7
  "5A3": "F10", "5C1": "F11", "5E3": "G30", "5F1": "G31", "7C5": "F01", "7E1": "G11", "7F3": "G12",
  // X
  "VY1": "F25", "VZ3": "F26", "VU1": "F15", "VV1": "F16", "JR1": "G01", "JT3": "G02",
  // Mini
  "XR1": "F56", "XS3": "F55", "XU1": "F60",
};

const FAMILY_PREFIX: Array<[RegExp, ChassisFamily]> = [
  [/^E\d/, "E"], [/^F\d/, "F"], [/^G\d/, "G"], [/^I\d/, "I"],
];

export function decodeVin(raw: string): VinInfo {
  const vin = raw.trim().toUpperCase();
  const valid = /^[A-HJ-NPR-Z0-9]{17}$/.test(vin);
  const wmi = vin.slice(0, 3);
  const typeCode = vin.slice(3, 7);
  // Les tables communautaires indexent sur 3 caractères (positions 4-6).
  const chassis = TYPE_CODES[vin.slice(3, 6)] ?? null;
  let family: ChassisFamily = "unknown";
  if (chassis) {
    for (const [pattern, f] of FAMILY_PREFIX) if (pattern.test(chassis)) { family = f; break; }
  }
  const yearChar = vin[9];
  const modelYear = yearChar ? decodeModelYear(yearChar) : null;
  return { vin, valid, wmi, typeCode, chassis, family, modelYear };
}

function decodeModelYear(char: string): number | null {
  const letters = "ABCDEFGHJKLMNPRSTVWXY";      // 2010 -> 2030
  const idx = letters.indexOf(char);
  if (idx >= 0) return 2010 + idx;
  const digit = Number(char);
  if (Number.isInteger(digit) && digit >= 1 && digit <= 9) return 2001 + digit; // 1..9 -> 2002..2009 (approx.)
  return null;
}

/** Les Mini et BMW i ont leurs propres préfixes WMI. */
export function brandFromVin(vin: string): "BMW" | "Mini" | "Toyota" | "inconnu" {
  const wmi = vin.slice(0, 3).toUpperCase();
  if (wmi.startsWith("WB") || wmi === "5UX" || wmi === "4US" || wmi === "5YM") return "BMW";
  if (wmi.startsWith("WM")) return "Mini";
  if (wmi.startsWith("JT") || wmi.startsWith("WZ1")) return "Toyota"; // Supra A90 = plateforme G29
  return "inconnu";
}
