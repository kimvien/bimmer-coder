import type { ChassisFamily } from "../vehicle/modules.ts";
import type { ParameterLocation } from "../coding/model.ts";

export type TweakCategory = "confort" | "eclairage" | "multimedia" | "affichage" | "securite" | "moteur" | "autre";
export type TweakRisk = "faible" | "moyen" | "eleve";

export interface TweakChoice {
  id: string;
  label: string;
  changes: Array<{ location: ParameterLocation; value: number }>;
}

/**
 * Un réglage proposé à l'utilisateur, traduit en écritures de bits.
 *
 * ⚠️ `verified` est le champ le plus important du fichier. Les offsets réels
 * d'un paramètre de codage se déduisent des fichiers de description d'ECU du
 * constructeur (CAFD / PSdZData), que cette application n'embarque pas : c'est
 * précisément la base de données qui fait la valeur d'un BimmerCode. Un réglage
 * `verified: false` ne peut pas être écrit sans l'option explicite
 * `allowUnverified`, et le moteur refuse tout diff anormalement large.
 */
export interface Tweak {
  id: string;
  label: string;
  description?: string;
  category: TweakCategory;
  /** Nom logique du module (voir src/vehicle/modules.ts). */
  module: string;
  appliesTo: { families?: ChassisFamily[]; chassis?: string[] };
  risk: TweakRisk;
  /** Niveau d'accès sécurité (service 0x27) exigé par l'ECU, si besoin. */
  requiresSecurity?: number;
  /** Le paramètre ne prend effet qu'après reset ECU / cycle de contact. */
  requiresReset?: boolean;
  /** Offsets confirmés sur un véhicule réel ? */
  verified: boolean;
  source?: string;
  choices: TweakChoice[];
}

export interface ValidationIssue { tweakId: string; field: string; message: string; }

const ID_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

export function validateTweak(tweak: Tweak): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (field: string, message: string) => issues.push({ tweakId: tweak.id ?? "(sans id)", field, message });

  if (!tweak.id || !ID_PATTERN.test(tweak.id)) fail("id", "identifiant manquant ou non conforme (minuscules, chiffres, - _ .)");
  if (!tweak.label) fail("label", "libellé manquant");
  if (!tweak.module) fail("module", "module cible manquant");
  if (!tweak.choices?.length) fail("choices", "au moins un choix est requis");
  if (typeof tweak.verified !== "boolean") fail("verified", "champ obligatoire: offsets vérifiés ou non");

  const seen = new Set<string>();
  for (const choice of tweak.choices ?? []) {
    if (!choice.id) fail("choices[].id", "identifiant de choix manquant");
    if (seen.has(choice.id)) fail("choices[].id", `choix dupliqué: ${choice.id}`);
    seen.add(choice.id);
    if (!choice.changes?.length) fail(`choices[${choice.id}].changes`, "aucune modification définie");
    for (const change of choice.changes ?? []) {
      const location = change.location;
      if (!location?.container) { fail(`choices[${choice.id}].location`, "conteneur manquant"); continue; }
      if (location.container.kind === "memory" && (!location.container.size || location.container.size <= 0)) {
        fail(`choices[${choice.id}].location`, "taille de bloc mémoire manquante");
      }
      const bitLength = location.bitLength ?? 8;
      if (bitLength < 1 || bitLength > 32) fail(`choices[${choice.id}].location.bitLength`, "doit être entre 1 et 32");
      const limit = bitLength >= 32 ? 0xffffffff : (1 << bitLength) - 1;
      if (change.value < 0 || change.value > limit) {
        fail(`choices[${choice.id}].value`, `valeur ${change.value} hors plage 0-${limit}`);
      }
    }
  }
  return issues;
}

export class TweakCatalog {
  private readonly tweaks = new Map<string, Tweak>();

  /** @returns les anomalies rencontrées ; les réglages invalides sont écartés. */
  add(tweaks: Tweak[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const tweak of tweaks) {
      const found = validateTweak(tweak);
      if (found.length) { issues.push(...found); continue; }
      this.tweaks.set(tweak.id, tweak);
    }
    return issues;
  }

  get size(): number { return this.tweaks.size; }
  all(): Tweak[] { return [...this.tweaks.values()]; }
  byId(id: string): Tweak | undefined { return this.tweaks.get(id); }

  /** Réglages compatibles avec un véhicule et les modules réellement présents. */
  forVehicle(vehicle: { family?: ChassisFamily; chassis?: string | null; availableModules?: string[] }): Tweak[] {
    return this.all().filter((tweak) => {
      const { families, chassis } = tweak.appliesTo ?? {};
      if (families?.length && vehicle.family && !families.includes(vehicle.family)) return false;
      if (chassis?.length && vehicle.chassis && !chassis.includes(vehicle.chassis)) return false;
      if (vehicle.availableModules?.length && !vehicle.availableModules.includes(tweak.module)) return false;
      return true;
    });
  }

  byCategory(): Map<TweakCategory, Tweak[]> {
    const out = new Map<TweakCategory, Tweak[]>();
    for (const tweak of this.all()) {
      const list = out.get(tweak.category) ?? [];
      list.push(tweak);
      out.set(tweak.category, list);
    }
    return out;
  }
}
