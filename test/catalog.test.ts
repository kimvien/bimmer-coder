import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TweakCatalog, validateTweak, type Tweak } from "../src/catalog/schema.ts";
import { loadCatalogFile } from "../src/catalog/apply.ts";
import { DEMO_TWEAKS } from "../src/catalog/tweaks.ts";

const base: Tweak = {
  id: "essai", label: "Essai", category: "confort", module: "KOMBI",
  appliesTo: { families: ["F"] }, risk: "faible", verified: true,
  choices: [{ id: "on", label: "Activé", changes: [{ location: { container: { kind: "did", did: 0x3100 }, byteOffset: 0, bitLength: 1 }, value: 1 }] }],
};

test("le catalogue de démonstration est valide", () => {
  const catalog = new TweakCatalog();
  assert.deepEqual(catalog.add(DEMO_TWEAKS), [], "aucune anomalie de schéma");
  assert.equal(catalog.size, DEMO_TWEAKS.length);
  assert.ok(DEMO_TWEAKS.every((t) => t.verified === false), "les offsets de démo sont marqués non vérifiés");
});

test("la validation refuse identifiant, choix et valeurs incohérents", () => {
  assert.deepEqual(validateTweak(base), []);
  assert.ok(validateTweak({ ...base, id: "Essai Majuscule" }).some((i) => i.field === "id"));
  assert.ok(validateTweak({ ...base, choices: [] }).some((i) => i.field === "choices"));
  // valeur 4 impossible sur 1 bit
  const horsPlage = { ...base, choices: [{ ...base.choices[0]!, changes: [{ location: { container: { kind: "did" as const, did: 1 }, byteOffset: 0, bitLength: 1 }, value: 4 }] }] };
  assert.ok(validateTweak(horsPlage).some((i) => i.message.includes("hors plage")));
  // bloc mémoire sans taille
  const sansTaille = { ...base, choices: [{ ...base.choices[0]!, changes: [{ location: { container: { kind: "memory" as const, address: 0x3000, size: 0 }, byteOffset: 0 }, value: 1 }] }] };
  assert.ok(validateTweak(sansTaille).some((i) => i.message.includes("taille")));
});

test("un réglage invalide est écarté du catalogue, les autres sont gardés", () => {
  const catalog = new TweakCatalog();
  const issues = catalog.add([base, { ...base, id: "", label: "" }]);
  assert.ok(issues.length >= 2);
  assert.equal(catalog.size, 1);
  assert.ok(catalog.byId("essai"));
});

test("le filtrage par véhicule tient compte de la plateforme et des modules présents", () => {
  const catalog = new TweakCatalog();
  catalog.add(DEMO_TWEAKS);
  const f30 = catalog.forVehicle({ family: "F", chassis: "F30", availableModules: ["KOMBI", "HU"] });
  assert.deepEqual(f30.map((t) => t.module).filter((m) => m === "FEM_BODY"), [], "FEM_BODY absent du véhicule : réglages masqués");
  const g20 = catalog.forVehicle({ family: "G", availableModules: ["FEM_BODY", "KOMBI", "HU"] });
  assert.ok(!g20.some((t) => t.id === "clignotants-confort"), "réglage F-series masqué sur G-series");
});

test("un catalogue externe au format JSON se charge et se valide", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bimmer-cat-"));
  const file = path.join(dir, "catalogue.json");
  await fs.writeFile(file, JSON.stringify({ tweaks: [base, { ...base, id: "casse" , choices: []}] }), "utf8");
  const { catalog, issues } = await loadCatalogFile(file);
  assert.equal(catalog.size, 1, "seul le réglage valide est retenu");
  assert.ok(issues.some((i) => i.tweakId === "casse"));
  await fs.rm(dir, { recursive: true, force: true });
});
