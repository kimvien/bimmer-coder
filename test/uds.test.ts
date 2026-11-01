import { strict as assert } from "node:assert";
import { test } from "node:test";
import { UdsNegativeResponse } from "../src/util/errors.ts";
import { createVirtualVehicle } from "../src/sim/vehicle.ts";
import { demoKeyProvider } from "../src/sim/virtual-ecu.ts";
import { SESSION, SID } from "../src/uds/nrc.ts";

test("session étendue, lecture de VIN et de DID", async () => {
  const car = createVirtualVehicle();
  const client = car.connect("KOMBI");
  const response = await client.startSession(SESSION.EXTENDED);
  assert.equal(response[0], SESSION.EXTENDED, "l'ECU confirme le niveau de session");
  assert.equal(await client.readVin(), "WBA3A91050F123456");
  await client.close();
  await car.close();
});

test("un DID inexistant remonte une réponse négative explicite", async () => {
  const car = createVirtualVehicle();
  const client = car.connect("KOMBI");
  await client.startSession();
  await assert.rejects(() => client.readDataByIdentifier(0x1234), (err: unknown) => {
    assert.ok(err instanceof UdsNegativeResponse);
    assert.equal(err.nrc, 0x31);
    assert.match(err.message, /hors plage/);
    return true;
  });
  await client.close();
  await car.close();
});

test("écrire hors session étendue est refusé (NRC 0x7F)", async () => {
  const car = createVirtualVehicle();
  const client = car.connect("KOMBI");
  await assert.rejects(() => client.writeDataByIdentifier(0x3100, Uint8Array.of(1, 2)), (err: unknown) => {
    assert.ok(err instanceof UdsNegativeResponse);
    assert.equal(err.nrc, 0x7f);
    return true;
  });
  await client.startSession(SESSION.EXTENDED);
  await client.writeDataByIdentifier(0x3100, Uint8Array.of(1, 2));
  assert.deepEqual([...(await client.readDataByIdentifier(0x3100))], [1, 2], "après session étendue, l'écriture passe");
  await client.close();
  await car.close();
});

test("accès sécurité : refus avant déverrouillage, puis écriture acceptée", async () => {
  const car = createVirtualVehicle({ secureFem: true });
  const client = car.connect("FEM_BODY");
  await client.startSession(SESSION.EXTENDED);

  await assert.rejects(() => client.downloadBlock(0x3000, new Uint8Array(16)), (err: unknown) => {
    assert.ok(err instanceof UdsNegativeResponse);
    assert.equal(err.nrc, 0x33, "accès sécurité refusé");
    return true;
  });

  await client.securityAccess(0x01, demoKeyProvider, "FEM_BODY");
  const block = await client.uploadBlock(0x3000, 16);
  block[5] = 0x42;
  await client.downloadBlock(0x3000, block);
  assert.equal((await client.uploadBlock(0x3000, 16))[5], 0x42);
  await client.close();
  await car.close();
});

test("une clé erronée est rejetée (NRC 0x35)", async () => {
  const car = createVirtualVehicle({ secureFem: true });
  const client = car.connect("FEM_BODY");
  await client.startSession(SESSION.EXTENDED);
  const mauvaiseClef = { name: "test", async computeKey() { return Uint8Array.of(0, 0, 0, 0); } };
  await assert.rejects(() => client.securityAccess(0x01, mauvaiseClef), (err: unknown) => {
    assert.ok(err instanceof UdsNegativeResponse);
    assert.equal(err.nrc, 0x35);
    return true;
  });
  await client.close();
  await car.close();
});

test("un NRC 0x78 'réponse en préparation' prolonge l'attente sans échouer", async () => {
  const car = createVirtualVehicle({ simulatePendingWrites: true });
  const client = car.connect("KOMBI");
  await client.startSession(SESSION.EXTENDED);
  const block = await client.uploadBlock(0x3000, 16);
  block[0] = 0x7f;
  await client.downloadBlock(0x3000, block);          // passe par un 0x78
  assert.equal((await client.uploadBlock(0x3000, 16))[0], 0x7f);
  await client.close();
  await car.close();
});

test("transfert mémoire : les blocs sont découpés et recollés sans perte", async () => {
  const car = createVirtualVehicle();
  const ecu = car.ecus.get("HU")!;
  const grand = Uint8Array.from({ length: 300 }, (_, i) => (i * 3) & 0xff);
  ecu.memory.set(0x4000, grand);
  const client = car.connect("HU");
  await client.startSession(SESSION.EXTENDED);
  const relu = await client.uploadBlock(0x4000, 300);
  assert.deepEqual([...relu], [...grand], "lecture en plusieurs blocs de 62 octets");

  const modifie = Uint8Array.from(grand);
  modifie[299] = 0x99;
  await client.downloadBlock(0x4000, modifie);
  assert.equal(ecu.memory.get(0x4000)![299], 0x99, "écriture multi-blocs enregistrée");
  await client.close();
  await car.close();
});

test("lecture et effacement des défauts", async () => {
  const car = createVirtualVehicle();
  const client = car.connect("KOMBI");
  await client.startSession();
  const dtcs = await client.readDtcs();
  assert.equal(dtcs.length, 2);
  assert.equal(dtcs[0]!.codeHex, "D35A01");
  assert.equal(dtcs[0]!.confirmed, true);
  await client.clearDtcs();
  await client.close();
  await car.close();
});

test("un service non supporté est signalé comme tel", async () => {
  const car = createVirtualVehicle();
  const client = car.connect("ZGW");
  await assert.rejects(() => client.request(0x2f, Uint8Array.of(0x00)), (err: unknown) => {
    assert.ok(err instanceof UdsNegativeResponse);
    assert.equal(err.nrc, 0x11);
    return true;
  });
  await client.close();
  await car.close();
});

test("le keep-alive envoie des TesterPresent sans attendre de réponse", async () => {
  const car = createVirtualVehicle();
  const ecu = car.ecus.get("KOMBI")!;
  const client = car.connect("KOMBI");
  await client.startSession();
  const avant = ecu.stats.requests;
  client.startKeepAlive(10);
  await new Promise((r) => setTimeout(r, 60));
  client.stopKeepAlive();
  assert.ok(ecu.stats.requests > avant, "des TesterPresent ont bien circulé");
  await client.request(SID.TESTER_PRESENT, Uint8Array.of(0x00));  // la session reste utilisable
  await client.close();
  await car.close();
});
