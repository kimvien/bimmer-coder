import { strict as assert } from "node:assert";
import { test } from "node:test";
import { IsoTpChannel, IsoTpReassembler } from "../src/isotp/isotp.ts";
import { VirtualCanBus } from "../src/sim/virtual-bus.ts";
import { bmwIsoTpConfig } from "../src/vehicle/addressing.ts";
import type { CanFrame, CanLink } from "../src/transport/types.ts";

/** Relie deux canaux ISO-TP dos à dos : B renvoie en écho ce qu'il reçoit. */
function echoPair(ecuAddress = 0x40, blockSize = 0) {
  const bus = new VirtualCanBus();
  const testerCfg = { ...bmwIsoTpConfig(ecuAddress), blockSize };
  const tester = new IsoTpChannel(bus.attach("tester"), testerCfg);
  const ecu = new IsoTpChannel(bus.attach("ecu"), {
    txId: 0x600 + ecuAddress, rxId: 0x6f1,
    extendedAddress: 0xf1, extendedAddressRx: ecuAddress,
    blockSize, stMinMs: 0, padding: 0x00,
  });
  ecu.onMessage((payload) => { void ecu.send(payload); });
  return { bus, tester, ecu };
}

const roundTrip = (channel: IsoTpChannel, payload: Uint8Array, timeoutMs = 2000): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`pas d'écho pour ${payload.length} octets`)); }, timeoutMs);
    const off = channel.onMessage((response) => { clearTimeout(timer); off(); resolve(response); });
    channel.send(payload).catch(reject);
  });

test("trame simple, première trame et trames consécutives font un aller-retour exact", async () => {
  const { tester } = echoPair();
  // 6 = capacité max d'une trame simple en adressage étendu ; au-delà, segmentation
  for (const size of [1, 2, 6, 7, 8, 13, 64, 255, 500, 1000, 4095]) {
    const payload = Uint8Array.from({ length: size }, (_, i) => (i * 7 + 3) & 0xff);
    const echo = await roundTrip(tester, payload);
    assert.equal(echo.length, size, `taille conservée pour ${size} octets`);
    assert.deepEqual([...echo], [...payload], `contenu conservé pour ${size} octets`);
  }
});

test("un BlockSize non nul impose des Flow Control intermédiaires", async () => {
  const { tester, bus } = echoPair(0x60, 4);
  const payload = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
  const echo = await roundTrip(tester, payload);
  assert.deepEqual([...echo], [...payload]);
  const flowControls = bus.traffic.filter(({ frame }) => (frame.data[1]! >> 4) === 0x3);
  assert.ok(flowControls.length >= 2, `au moins 2 Flow Control échangées, vu ${flowControls.length}`);
});

test("l'adressage étendu réduit la charge utile et filtre les trames d'un autre testeur", async () => {
  const bus = new VirtualCanBus();
  const channel = new IsoTpChannel(bus.attach("tester"), bmwIsoTpConfig(0x40));
  const received: Uint8Array[] = [];
  channel.onMessage((m) => received.push(m));
  const spy = bus.attach("spy");

  await channel.send(Uint8Array.from([0x22, 0xf1, 0x90]));
  const sent = bus.traffic.at(-1)!.frame;
  assert.equal(sent.id, 0x6f1, "émission sur l'identifiant du testeur");
  assert.equal(sent.data[0], 0x40, "premier octet = adresse de l'ECU visée");
  assert.equal(sent.data[1], 0x03, "PCI après l'octet d'adresse");

  // Trame adressée à un autre testeur (0xF2) : doit être ignorée.
  await spy.send({ id: 0x640, data: Uint8Array.from([0xf2, 0x02, 0x62, 0x01, 0, 0, 0, 0]) });
  await spy.send({ id: 0x640, data: Uint8Array.from([0xf1, 0x02, 0x62, 0x01, 0, 0, 0, 0]) });
  assert.equal(received.length, 1, "seule la trame destinée à 0xF1 est remontée");
});

test("une séquence de trames consécutives rompue est rejetée sans message corrompu", () => {
  const reassembler = new IsoTpReassembler();
  // Message annoncé de 20 octets : FF (6) + CF#1 (7) + CF#2 (7).
  assert.equal(reassembler.push(Uint8Array.from([0x10, 0x14, 1, 2, 3, 4, 5, 6])), null);
  assert.equal(reassembler.push(Uint8Array.from([0x21, 7, 8, 9, 10, 11, 12, 13])), null);
  // On saute CF#2 : le réassembleur doit refuser, pas recoller n'importe quoi.
  assert.throws(() => reassembler.push(Uint8Array.from([0x23, 14, 15, 16, 17, 18, 19, 20])), /séquence/);
  // Après l'erreur, une trame consécutive orpheline est simplement ignorée.
  assert.equal(reassembler.push(Uint8Array.from([0x22, 14, 15, 16, 17, 18, 19, 20])), null);
});

test("un message complet est remonté dès que la longueur annoncée est atteinte", () => {
  const reassembler = new IsoTpReassembler();
  assert.equal(reassembler.push(Uint8Array.from([0x10, 0x0a, 1, 2, 3, 4, 5, 6])), null);
  const message = reassembler.push(Uint8Array.from([0x21, 7, 8, 9, 10, 0xaa, 0xaa, 0xaa]));
  assert.deepEqual([...(message ?? [])], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "le bourrage est écarté");
});

test("le décodage de STmin suit la norme (ms, puis microsecondes)", () => {
  assert.equal(IsoTpChannel.decodeStMin(0x00), 0);
  assert.equal(IsoTpChannel.decodeStMin(0x7f), 127);
  assert.equal(IsoTpChannel.decodeStMin(0xf1), 1);
  assert.equal(IsoTpChannel.decodeStMin(0xfa), 0);
});

test("l'absence de Flow Control fait échouer l'envoi au lieu de bloquer", async () => {
  const silent: CanLink = { name: "muet", async send(_f: CanFrame) {}, onFrame() { return () => {}; }, async close() {} };
  const channel = new IsoTpChannel(silent, { ...bmwIsoTpConfig(0x40), timeoutFcMs: 50 });
  await assert.rejects(() => channel.send(new Uint8Array(100)), /Flow Control/);
});
