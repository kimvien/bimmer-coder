/**
 * Table des calculateurs BMW.
 *
 * ⚠️ Honnêteté sur la source : les adresses de diagnostic viennent de la
 * documentation communautaire (NCSExpert / E-Sys / forums), pas d'une base
 * constructeur. Elles varient selon la plateforme et les options. Le champ
 * `confidence` dit ce qui est solide, et `scanModules()` reste la seule
 * autorité : on interroge le bus et on garde ce qui répond.
 */
export type ChassisFamily = "E" | "F" | "G" | "I" | "unknown";

export interface ModuleDef {
  /** Adresse de diagnostic sur le bus. */
  address: number;
  /** Nom court BMW. */
  name: string;
  /** Rôle en français. */
  role: string;
  families: ChassisFamily[];
  confidence: "documented" | "to-verify";
}

export const MODULES: ModuleDef[] = [
  { address: 0x12, name: "DME", role: "gestion moteur (essence)", families: ["E", "F", "G"], confidence: "documented" },
  { address: 0x13, name: "DDE", role: "gestion moteur (diesel)", families: ["E", "F", "G"], confidence: "to-verify" },
  { address: 0x18, name: "EGS", role: "boîte automatique", families: ["E", "F", "G"], confidence: "documented" },
  { address: 0x29, name: "DSC", role: "contrôle de stabilité / ABS", families: ["E", "F", "G"], confidence: "documented" },
  { address: 0x37, name: "ICM", role: "dynamique de châssis", families: ["F", "G"], confidence: "to-verify" },
  { address: 0x40, name: "FEM_BODY", role: "module de carrosserie avant (F2x/F3x)", families: ["F"], confidence: "documented" },
  { address: 0x40, name: "BDC_BODY", role: "Body Domain Controller (F15+/G)", families: ["G"], confidence: "documented" },
  { address: 0x40, name: "CAS", role: "accès véhicule (E-series)", families: ["E"], confidence: "documented" },
  { address: 0x60, name: "KOMBI", role: "combiné d'instruments", families: ["E", "F", "G"], confidence: "documented" },
  { address: 0x61, name: "REM", role: "module de carrosserie arrière", families: ["F"], confidence: "to-verify" },
  { address: 0x63, name: "HU", role: "unité centrale multimédia (CIC/NBT/MGU)", families: ["E", "F", "G"], confidence: "documented" },
  { address: 0x64, name: "ASD", role: "son moteur actif", families: ["F", "G"], confidence: "to-verify" },
  { address: 0x6f, name: "PDC", role: "aide au stationnement", families: ["E", "F"], confidence: "to-verify" },
  { address: 0x72, name: "FRM", role: "module d'éclairage / plancher (E/F)", families: ["E", "F"], confidence: "documented" },
  { address: 0x78, name: "CAS4", role: "accès véhicule (F-series)", families: ["F"], confidence: "to-verify" },
  { address: 0x7f, name: "IHKA", role: "climatisation", families: ["E", "F", "G"], confidence: "to-verify" },
  { address: 0xa0, name: "ACSM", role: "airbags / capteurs de choc", families: ["F", "G"], confidence: "to-verify" },
  { address: 0xa4, name: "EPS", role: "direction assistée", families: ["F", "G"], confidence: "to-verify" },
  { address: 0x10, name: "ZGW", role: "passerelle centrale", families: ["F", "G"], confidence: "documented" },
];

export const moduleByName = (name: string): ModuleDef | undefined =>
  MODULES.find((m) => m.name.toUpperCase() === name.toUpperCase());

export const modulesForFamily = (family: ChassisFamily): ModuleDef[] =>
  MODULES.filter((m) => m.families.includes(family));
