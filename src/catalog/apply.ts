import fs from "node:fs/promises";
import { CodingGuardError } from "../util/errors.ts";
import type { CodingSession, PlannedChange } from "../coding/engine.ts";
import { TweakCatalog, validateTweak, type Tweak, type TweakChoice } from "./schema.ts";

export interface ApplyOptions {
  /** Autorise un réglage dont les offsets ne sont pas confirmés. */
  allowUnverified?: boolean;
  /** Autorise les réglages à risque élevé (sécurité, conformité). */
  allowHighRisk?: boolean;
}

/** Prépare un réglage dans la session (sans écrire). */
export async function stageTweak(
  session: CodingSession,
  tweak: Tweak,
  choiceId: string,
  options: ApplyOptions = {},
): Promise<{ choice: TweakChoice; staged: PlannedChange[] }> {
  const issues = validateTweak(tweak);
  if (issues.length) throw new CodingGuardError(`réglage "${tweak.id}" invalide: ${issues.map((i) => `${i.field}: ${i.message}`).join("; ")}`);

  const choice = tweak.choices.find((c) => c.id === choiceId);
  if (!choice) throw new CodingGuardError(`choix "${choiceId}" inconnu pour "${tweak.id}" (disponibles: ${tweak.choices.map((c) => c.id).join(", ")})`);

  if (!tweak.verified && !options.allowUnverified) {
    throw new CodingGuardError(
      `les offsets de "${tweak.id}" ne sont pas confirmés sur un véhicule réel. ` +
      `Relisez-les contre la description de votre ECU, puis repassez avec allowUnverified.`,
    );
  }
  if (tweak.risk === "eleve" && !options.allowHighRisk) {
    throw new CodingGuardError(`"${tweak.id}" est classé à risque élevé : confirmation explicite requise (allowHighRisk).`);
  }
  if (tweak.module.toUpperCase() !== session.ecuName.toUpperCase()) {
    throw new CodingGuardError(`"${tweak.id}" cible le module ${tweak.module}, session ouverte sur ${session.ecuName}`);
  }

  for (const change of choice.changes) await session.stage(change.location, change.value);
  return { choice, staged: session.plan() };
}

/** Lit la valeur actuelle d'un réglage et dit à quel choix elle correspond. */
export async function readTweak(session: CodingSession, tweak: Tweak): Promise<{ choice: TweakChoice | null; raw: number[] }> {
  const raw: number[] = [];
  for (const change of tweak.choices[0]?.changes ?? []) {
    raw.push(await session.readParameter(change.location));
  }
  const match = tweak.choices.find((choice) =>
    choice.changes.length === raw.length && choice.changes.every((change, i) => change.value === raw[i]));
  return { choice: match ?? null, raw };
}

/** Charge un catalogue JSON externe (c'est ainsi qu'on fournit de vrais offsets). */
export async function loadCatalogFile(path: string, catalog = new TweakCatalog()): Promise<{ catalog: TweakCatalog; issues: ReturnType<typeof validateTweak> }> {
  const parsed = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
  const tweaks = (Array.isArray(parsed) ? parsed : (parsed as { tweaks?: Tweak[] }).tweaks) ?? [];
  const issues = catalog.add(tweaks as Tweak[]);
  return { catalog, issues };
}
