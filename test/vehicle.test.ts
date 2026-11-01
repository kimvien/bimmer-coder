import { strict as assert } from "node:assert";
import { test } from "node:test";
import { brandFromVin, decodeVin } from "../src/vehicle/chassis.ts";
import { bmwIsoTpConfig, obdIsoTpConfig, TESTER_ADDRESS } from "../src/vehicle/addressing.ts";
import { moduleByName, modulesForFamily } from "../src/vehicle/modules.ts";
import { openConnection } from "../src/connection.ts";
import { identifyVehicle, scanModules } from "../src/vehicle/scan.ts";

test("décodage de VIN : plateforme, famille, marque", () => {
  const f30 = decodeVin("WBA3A91050F123456");
  assert.equal(f30.valid, true);
  assert.equal(f30.chassis, "F30");
  assert.equal(f30.family, "F");
  assert.equal(brandFromVin("WBA3A91050F123456"), "BMW");
  assert.equal(brandFromVin("WMWXR3C50K2A12345"), "Mini");

  const inconnu = decodeVin("WBAZZZZ50F123456X");
  assert.equal(inconnu.chassis, null, "plateforme inconnue plutôt que devinée");
  assert.equal(inconnu.family, "unknown");

  assert.equal(decodeVin("TROP-COURT").valid, false);
});

test("adressage BMW : identifiants et octet d'adresse étendue", () => {
  const fem = bmwIsoTpConfig(0x40);
  assert.equal(fem.txId, 0x6f1);
  assert.equal(fem.rxId, 0x640);
  assert.equal(fem.extendedAddress, 0x40);
  assert.equal(fem.extendedAddressRx, TESTER_ADDRESS);
  assert.equal(bmwIsoTpConfig(0x63).rxId, 0x663);

  const obd = obdIsoTpConfig();
  assert.equal(obd.txId, 0x7e0);
  assert.equal(obd.rxId, 0x7e8);
  assert.equal(obd.extendedAddress, null);
});

test("la table des modules reste cohérente", () => {
  assert.equal(moduleByName("fem_body")?.address, 0x40, "recherche insensible à la casse");
  assert.equal(moduleByName("inexistant"), undefined);
  assert.ok(modulesForFamily("F").length >= 8);
  assert.ok(modulesForFamily("G").every((m) => m.families.includes("G")));
});

test("le scan ne garde que les calculateurs qui répondent vraiment", async () => {
  const connection = await openConnection({ kind: "sim" });
  const modules = await scanModules((a, n) => connection.clientFor(a, n));
  const noms = modules.map((m) => m.name).sort();
  assert.deepEqual(noms, ["FEM_BODY", "HU", "KOMBI", "ZGW"], "les adresses muettes sont écartées");
  assert.ok(modules.every((m) => m.responded && m.softwareNumber));
  await connection.close();
});

test("l'identification croise VIN et modules présents", async () => {
  const connection = await openConnection({ kind: "sim" });
  const identity = await identifyVehicle((a, n) => connection.clientFor(a, n));
  assert.equal(identity.vin?.chassis, "F30");
  assert.equal(identity.family, "F");
  assert.equal(identity.modules.length, 4);
  await connection.close();
});
