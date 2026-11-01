import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CodingGuardError } from "../src/util/errors.ts";
import { diffBytes, readBits, writeBits, type ContainerRef, type ParameterLocation } from "../src/coding/model.ts";
import { CodingSession } from "../src/coding/engine.ts";
import { MemoryBackupStore, backupData, makeBackup } from "../src/coding/backup.ts";
import { createVirtualVehicle } from "../src/sim/vehicle.ts";
import { demoKeyProvider } from "../src/sim/virtual-ecu.ts";
import { TweakCatalog } from "../src/catalog/schema.ts";
import { DEMO_TWEAKS } from "../src/catalog/tweaks.ts";
import { readTweak, stageTweak } from "../src/catalog/apply.ts";

const BLOC: ContainerRef = { kind: "memory", address: 0x3000, size: 16 };

test("champs de bits : aller-retour exact, y compris à cheval sur deux octets", () => {
  const base = new Uint8Array(4);
  for (const [byteOffset, bitOffset, bitLength, value] of [
    [0, 0, 1, 1], [0, 7, 1, 1], [1, 0, 8, 0xff], [1, 3, 5, 0x1f], [2, 6, 4, 0b1011], [0, 2, 16, 0xbeef],
  ] as const) {
    const location: ParameterLocation = { container: BLOC, byteOffset, bitOffset, bitLength };
    const patched = writeBits(base, location, value);
    assert.equal(readBits(patched, location), value, `${bitLength} bits à l'offset ${byteOffset}.${bitOffset}`);
    assert.notEqual(patched, base, "l'original n'est jamais modifié sur place");
  }
});

test("écrire un bit n'altère pas ses voisins", () => {
  const base = Uint8Array.from([0b10101010, 0xff]);
  const patched = writeBits(base, { container: BLOC, byteOffset: 0, bitOffset: 2, bitLength: 1 }, 1);
  assert.equal(patched[0], 0b10101110);
  assert.equal(patched[1], 0xff);
  assert.deepEqual(diffBytes(base, patched), [{ offset: 0, before: 0b10101010, after: 0b10101110 }]);
});

test("une valeur hors plage ou hors conteneur est refusée", () => {
  assert.throws(() => writeBits(new Uint8Array(2), { container: BLOC, byteOffset: 0, bitLength: 2 }, 4), /hors plage/);
  assert.throws(() => writeBits(new Uint8Array(2), { container: BLOC, byteOffset: 5, bitLength: 8 }, 1), /hors conteneur/);
  assert.throws(() => readBits(new Uint8Array(2), { container: BLOC, byteOffset: 9, bitLength: 8 }), /hors conteneur/);
});

test("une sauvegarde corrompue est détectée par son CRC", () => {
  const backup = makeBackup({ vin: "VIN", ecuName: "KOMBI", address: 0x60, container: BLOC, data: Uint8Array.from([1, 2, 3]) });
  assert.deepEqual([...backupData(backup)], [1, 2, 3]);
  assert.throws(() => backupData({ ...backup, dataHex: "010204" }), /corrompue/);
});

async function openSession(options: { secure?: boolean; broken?: boolean } = {}) {
  const car = createVirtualVehicle({
    secureFem: options.secure ?? false,
    ...(options.broken ? { brokenWritesOn: ["FEM_BODY"] } : {}),
  });
  const client = car.connect("FEM_BODY");
  const backups = new MemoryBackupStore();
  const session = new CodingSession(client, {
    ecuName: "FEM_BODY", address: 0x40, backups,
    keyProvider: demoKeyProvider,
    ...(options.secure ? { securityLevel: 0x01 } : {}),
  });
  await session.open();
  return { car, client, session, backups };
}

test("simulation : le diff est calculé mais rien n'est écrit", async () => {
  const { car, client, session, backups } = await openSession();
  const ecu = car.ecus.get("FEM_BODY")!;
  await session.stage({ container: BLOC, byteOffset: 2, bitOffset: 0, bitLength: 1 }, 1);
  const result = await session.commit({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0]!.changedBytes, [{ offset: 2, before: 0x00, after: 0x01 }]);
  assert.equal(ecu.stats.writes, 0, "aucune écriture sur l'ECU");
  assert.equal((await backups.list()).length, 0, "pas de sauvegarde pour une simulation");
  await session.close(); await client.close(); await car.close();
});

test("écriture réelle : sauvegarde d'abord, puis vérification par relecture", async () => {
  const { car, client, session, backups } = await openSession();
  const ecu = car.ecus.get("FEM_BODY")!;
  await session.stage({ container: BLOC, byteOffset: 3, bitLength: 8 }, 5);
  const result = await session.commit({ verify: true, reset: true });

  assert.equal(result.verified, true);
  assert.equal(result.resetPerformed, true);
  assert.equal(ecu.memory.get(0x3000)![3], 5, "la valeur est bien dans l'ECU");
  const [backup] = await backups.list();
  assert.ok(backup, "une sauvegarde a été enregistrée");
  assert.equal(backup!.ecuName, "FEM_BODY");
  assert.equal(backupData(backup!)[3], 3, "la sauvegarde contient la valeur d'origine");
  assert.ok(ecu.stats.resets >= 1);
  await session.close(); await client.close(); await car.close();
});

test("une ECU qui acquitte sans enregistrer déclenche un retour arrière", async () => {
  const { car, client, session } = await openSession({ broken: true });
  await session.stage({ container: BLOC, byteOffset: 3, bitLength: 8 }, 7);
  await assert.rejects(() => session.commit({ verify: true }), (err: unknown) => {
    assert.ok(err instanceof CodingGuardError);
    assert.match(err.message, /retour arrière/);
    return true;
  });
  assert.equal(car.ecus.get("FEM_BODY")!.memory.get(0x3000)![3], 3, "le codage d'origine est intact");
  await session.close(); await client.close(); await car.close();
});

test("un diff anormalement large est refusé avant toute écriture", async () => {
  const car = createVirtualVehicle();
  const client = car.connect("FEM_BODY");
  const session = new CodingSession(client, {
    ecuName: "FEM_BODY", address: 0x40, backups: new MemoryBackupStore(), maxChangedBytes: 2,
  });
  await session.open();
  for (const byteOffset of [5, 6, 7]) await session.stage({ container: BLOC, byteOffset, bitLength: 8 }, 0xaa);
  await assert.rejects(() => session.commit({}), /refus d'écrire 3 octets/);
  assert.equal(car.ecus.get("FEM_BODY")!.stats.writes, 0);
  await session.close(); await client.close(); await car.close();
});

test("sans fournisseur de clé, une ECU verrouillée arrête la session proprement", async () => {
  const car = createVirtualVehicle({ secureFem: true });
  const client = car.connect("FEM_BODY");
  const session = new CodingSession(client, {
    ecuName: "FEM_BODY", address: 0x40, backups: new MemoryBackupStore(), securityLevel: 0x01,
  });
  await assert.rejects(() => session.open(), /aucun fournisseur de clé/);
  await client.close(); await car.close();
});

test("restauration : refusée si le VIN ne correspond pas, acceptée sinon", async () => {
  const { car, client, session, backups } = await openSession();
  const ecu = car.ecus.get("FEM_BODY")!;
  await session.stage({ container: BLOC, byteOffset: 3, bitLength: 8 }, 7);
  await session.commit({});
  assert.equal(ecu.memory.get(0x3000)![3], 7);

  const [backup] = await backups.list();
  await assert.rejects(() => session.restore({ ...backup!, vin: "WBAAUTREVIN123456" }), /restauration refusée/);
  await session.restore(backup!);
  assert.equal(ecu.memory.get(0x3000)![3], 3, "codage d'origine remis");
  await session.close(); await client.close(); await car.close();
});

test("un réglage du catalogue est lu, préparé et écrit de bout en bout", async () => {
  const catalog = new TweakCatalog();
  assert.deepEqual(catalog.add(DEMO_TWEAKS), []);
  const tweak = catalog.byId("clignotants-confort")!;

  const { car, client, session } = await openSession();
  const avant = await readTweak(session, tweak);
  assert.equal(avant.choice?.id, "3", "l'état d'origine correspond au choix '3 clignotements'");

  await assert.rejects(() => stageTweak(session, tweak, "5"), (err: unknown) => {
    assert.ok(err instanceof CodingGuardError);
    assert.match(err.message, /offsets .* ne sont pas confirmés/);
    return true;
  });
  await stageTweak(session, tweak, "5", { allowUnverified: true });
  await session.commit({ verify: true });

  const apres = await readTweak(session, tweak);
  assert.equal(apres.choice?.id, "5");
  assert.equal(car.ecus.get("FEM_BODY")!.memory.get(0x3000)![3], 5);
  await session.close(); await client.close(); await car.close();
});

test("un réglage à risque élevé exige une confirmation explicite", async () => {
  const catalog = new TweakCatalog();
  catalog.add(DEMO_TWEAKS);
  const tweak = catalog.byId("rappel-ceinture")!;
  const car = createVirtualVehicle();
  const client = car.connect("KOMBI");
  const session = new CodingSession(client, { ecuName: "KOMBI", address: 0x60, backups: new MemoryBackupStore() });
  await session.open();
  await assert.rejects(() => stageTweak(session, tweak, "inactif", { allowUnverified: true }), /risque élevé/);
  await stageTweak(session, tweak, "inactif", { allowUnverified: true, allowHighRisk: true });
  await session.close(); await client.close(); await car.close();
});

test("un réglage destiné à un autre module est refusé", async () => {
  const catalog = new TweakCatalog();
  catalog.add(DEMO_TWEAKS);
  const { car, client, session } = await openSession();   // session sur FEM_BODY
  await assert.rejects(
    () => stageTweak(session, catalog.byId("vitesse-numerique")!, "km", { allowUnverified: true }),
    /cible le module KOMBI/,
  );
  await session.close(); await client.close(); await car.close();
});
