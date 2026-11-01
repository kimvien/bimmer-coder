import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AdapterError } from "../src/util/errors.ts";
import { MockTransport } from "../src/transport/mock.ts";
import { Elm327Adapter } from "../src/adapter/elm327.ts";
import { EnetFramer, encodeEnetPacket, DOIP_TYPE } from "../src/adapter/enet.ts";
import { VirtualElm327 } from "../src/sim/virtual-elm327.ts";
import { VirtualCanBus } from "../src/sim/virtual-bus.ts";
import { openConnection } from "../src/connection.ts";
import { bytesToHex } from "../src/util/hex.ts";

function pairWithEmulator(options: { supportsExtendedAddressing?: boolean } = {}) {
  const bus = new VirtualCanBus();
  const [appSide, dongleSide] = MockTransport.pair();
  const emulator = new VirtualElm327(dongleSide, bus.attach("elm327"), options);
  const adapter = new Elm327Adapter(appSide, { autoFormat: false, commandTimeoutMs: 500 });
  return { bus, adapter, emulator };
}

test("la séquence d'initialisation coupe l'écho et affiche les en-têtes", async () => {
  const { adapter, emulator } = pairWithEmulator();
  await adapter.open();
  assert.match(adapter.version, /ELM327/);
  for (const expected of ["ATE0", "ATL0", "ATS0", "ATH1", "ATAL", "ATCAF0"]) {
    assert.ok(emulator.commands.includes(expected), `${expected} envoyée à l'adaptateur`);
  }
  await adapter.close();
});

test("probe() valide les capacités nécessaires au codage", async () => {
  const { adapter } = pairWithEmulator();
  await adapter.open();
  const probe = await adapter.probe();
  assert.equal(probe.ok, true, `capacités manquantes: ${probe.missing.join(", ")}`);
  await adapter.close();
});

test("une commande incomprise par l'adaptateur devient une erreur explicite", async () => {
  const { adapter } = pairWithEmulator();
  await adapter.open();
  const lines = await adapter.command("ATXYZ");
  assert.deepEqual(lines, ["?"], "l'ELM327 répond '?' aux commandes inconnues");
  await adapter.close();
});

test("un dongle sans adressage étendu est détecté au lieu de parler dans le vide", async () => {
  // Beaucoup de clones ELM327 ignorent ATCEA : c'est exactement pour cela
  // qu'ils ne peuvent pas coder une BMW, et l'app doit le dire clairement.
  const { adapter, emulator } = pairWithEmulator({ supportsExtendedAddressing: false });
  await adapter.open();
  await assert.rejects(
    () => adapter.openMessageLink(0x6f1, 0x640, 0x40).send(Uint8Array.of(0x22, 0xf1, 0x90)),
    (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.match(err.message, /ATCEA/);
      assert.match(err.message, /isoTpMode/, "le message indique la solution de repli");
      return true;
    },
  );
  assert.ok(emulator.commands.some((c) => c.startsWith("ATCEA")), "l'app a bien tenté ATCEA");
  await adapter.close();
});

test("les lignes de réponse sont découpées en trames CAN", async () => {
  const { adapter } = pairWithEmulator();
  await adapter.open();
  const frame = adapter.parseFrameLine("640 F1 03 62 F1 90");
  assert.equal(frame?.id, 0x640);
  assert.equal(bytesToHex(frame!.data, " "), "F1 03 62 F1 90");
  assert.equal(adapter.parseFrameLine("NO DATA"), null);
  assert.equal(adapter.parseFrameLine("640"), null, "une ligne sans données n'est pas une trame");
  await adapter.close();
});

test("un message long traverse réellement le pilote ELM327 émulé", async () => {
  const connection = await openConnection({ kind: "sim-elm" });
  const client = connection.clientFor(0x40, "FEM_BODY");
  await client.startSession(0x03);
  assert.equal(await client.readVin(), "WBA3A91050F123456", "17 octets => ISO-TP multi-trames via le dongle");
  await client.close();
  await connection.close();
});

test("le framer DoIP reconstruit les paquets quelle que soit la fragmentation TCP", () => {
  const framer = new EnetFramer("doip");
  const packet = encodeEnetPacket("doip", DOIP_TYPE.DIAG_MESSAGE, Uint8Array.from([0x0e, 0x00, 0x00, 0x40, 0x62, 0xf1, 0x90]));
  assert.equal(packet.length, 8 + 7);
  assert.deepEqual(framer.push(packet.slice(0, 3)), [], "en-tête incomplet : rien n'est remonté");
  assert.deepEqual(framer.push(packet.slice(3, 10)), [], "charge incomplète : on attend");
  const done = framer.push(packet.slice(10));
  assert.equal(done.length, 1);
  assert.equal(done[0]!.type, DOIP_TYPE.DIAG_MESSAGE);
  assert.equal(bytesToHex(done[0]!.payload.slice(4), " "), "62 F1 90");
});

test("le framer DoIP rejette un en-tête dont le complément de version est faux", () => {
  const framer = new EnetFramer("doip");
  assert.throws(() => framer.push(Uint8Array.from([0x02, 0x00, 0x80, 0x01, 0, 0, 0, 0])), /complément/);
});

test("deux paquets ENET BMW collés dans le même segment sont séparés", () => {
  const framer = new EnetFramer("bmw-enet");
  const a = encodeEnetPacket("bmw-enet", 0x0001, Uint8Array.from([0xf4, 0x40, 0x50, 0x03]));
  const b = encodeEnetPacket("bmw-enet", 0x0001, Uint8Array.from([0xf4, 0x40, 0x62, 0xf1, 0x90]));
  const packets = framer.push(new Uint8Array([...a, ...b]));
  assert.equal(packets.length, 2);
  assert.equal(packets[0]!.payload.length, 4);
  assert.equal(packets[1]!.payload.length, 5);
});
