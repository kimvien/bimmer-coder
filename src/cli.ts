#!/usr/bin/env -S node --experimental-strip-types
import path from "node:path";
import { createLogger, type LogLevel } from "./util/log.ts";
import { bytesToHex, hexToBytes } from "./util/hex.ts";
import { openConnection, type ConnectionSpec } from "./connection.ts";
import { identifyVehicle, scanModules } from "./vehicle/scan.ts";
import { moduleByName, MODULES } from "./vehicle/modules.ts";
import { CodingSession } from "./coding/engine.ts";
import { FileBackupStore } from "./coding/backup.ts";
import { TweakCatalog } from "./catalog/schema.ts";
import { DEMO_TWEAKS } from "./catalog/tweaks.ts";
import { loadCatalogFile, readTweak, stageTweak } from "./catalog/apply.ts";
import { demoKeyProvider } from "./sim/virtual-ecu.ts";
import { UdsNegativeResponse } from "./util/errors.ts";

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[36m",
};
const say = (s = "") => process.stdout.write(s + "\n");
const warn = (s: string) => say(`${C.yellow}⚠ ${s}${C.reset}`);
const fail = (s: string) => say(`${C.red}✖ ${s}${C.reset}`);
const ok = (s: string) => say(`${C.green}✔ ${s}${C.reset}`);

interface Args { command: string; positional: string[]; flags: Record<string, string | boolean>; }

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split("=", 2);
      const next = argv[i + 1];
      if (inline !== undefined) flags[name!] = inline;
      else if (next && !next.startsWith("--")) { flags[name!] = next; i++; }
      else flags[name!] = true;
    } else positional.push(token);
  }
  return { command: positional.shift() ?? "aide", positional, flags };
}

function connectionSpec(flags: Record<string, string | boolean>): ConnectionSpec {
  const transport = String(flags.transport ?? "sim");
  const host = flags.host ? String(flags.host) : undefined;
  const port = flags.port ? Number(flags.port) : undefined;
  switch (transport) {
    case "sim": return { kind: "sim", secureFem: flags.secure === true };
    case "sim-elm": return { kind: "sim-elm" };
    case "wifi": return { kind: "elm327-wifi", ...(host ? { host } : {}), ...(port ? { port } : {}), isoTpMode: flags["isotp-adapter"] ? "adapter" : "app" };
    case "enet": return { kind: "enet", host: host ?? "169.254.1.1", ...(port ? { port } : {}), dialect: "bmw-enet" };
    case "doip": return { kind: "enet", host: host ?? "169.254.1.1", ...(port ? { port } : {}), dialect: "doip" };
    default: throw new Error(`transport inconnu "${transport}" (sim, sim-elm, wifi, enet, doip)`);
  }
}

async function buildCatalog(flags: Record<string, string | boolean>): Promise<TweakCatalog> {
  const catalog = new TweakCatalog();
  if (flags.catalog) {
    const { issues } = await loadCatalogFile(String(flags.catalog), catalog);
    for (const issue of issues) warn(`catalogue: ${issue.tweakId}/${issue.field}: ${issue.message}`);
    say(`${C.dim}catalogue chargé depuis ${flags.catalog} (${catalog.size} réglages)${C.reset}`);
  } else {
    catalog.add(DEMO_TWEAKS);
    say(`${C.dim}catalogue de démonstration (${catalog.size} réglages, offsets du simulateur)${C.reset}`);
  }
  return catalog;
}

const backupStore = (flags: Record<string, string | boolean>) =>
  new FileBackupStore(String(flags.backups ?? path.join(process.cwd(), "sauvegardes")));

function addressOf(moduleName: string): number {
  const def = moduleByName(moduleName);
  if (!def) throw new Error(`module "${moduleName}" inconnu (${MODULES.map((m) => m.name).join(", ")})`);
  return def.address;
}

function usage(): void {
  say(`${C.bold}bimmer-coder${C.reset} — codage de calculateurs BMW/Mini

${C.bold}Usage${C.reset}
  bimmer-coder <commande> [options]

${C.bold}Commandes${C.reset}
  scan                               liste les calculateurs qui répondent
  info                               VIN, plateforme, modules
  tweaks [--module HU]               réglages disponibles
  read <reglage>                     valeur actuelle d'un réglage
  apply <reglage> <choix>            applique un réglage
  dtc --module KOMBI [--clear]       lit (ou efface) les défauts
  did --module KOMBI --did 0xF190    lecture/écriture brute d'un DID (--write HEX)
  backups [--vin VIN]                liste les sauvegardes
  restore <id> --module FEM_BODY     restaure une sauvegarde

${C.bold}Options${C.reset}
  --transport sim|sim-elm|wifi|enet|doip   défaut: sim (véhicule virtuel)
  --host, --port                           adresse de l'adaptateur Wi-Fi / ENET
  --catalog fichier.json                   catalogue de réglages externe
  --backups dossier                        dossier des sauvegardes
  --dry-run                                montre les octets sans rien écrire
  --allow-unverified                       autorise des offsets non confirmés
  --allow-high-risk                        autorise un réglage à risque élevé
  --reset                                  reset de l'ECU après écriture
  --log silent|error|info|debug|trace

${C.bold}Exemples${C.reset}
  bimmer-coder scan
  bimmer-coder apply vitesse-numerique km --dry-run
  bimmer-coder apply vitesse-numerique km --allow-unverified --reset
  bimmer-coder info --transport wifi --host 192.168.0.10 --port 35000
`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "aide" || args.flags.help) { usage(); return 0; }

  const logger = createLogger((String(args.flags.log ?? "info") as LogLevel));
  const spec = connectionSpec(args.flags);
  const connection = await openConnection(spec, logger);
  say(`${C.blue}connexion: ${connection.name}${C.reset}`);

  try {
    switch (args.command) {
      case "scan": {
        const modules = await scanModules((a, n) => connection.clientFor(a, n), { logger });
        if (!modules.length) { fail("aucun calculateur n'a répondu"); return 1; }
        say(`\n${C.bold}${modules.length} calculateur(s)${C.reset}`);
        for (const m of modules) {
          say(`  ${C.bold}${m.name.padEnd(10)}${C.reset} 0x${m.address.toString(16).padStart(2, "0")}  ${m.role}` +
              `${m.softwareNumber ? `  ${C.dim}sw ${m.softwareNumber}${C.reset}` : ""}`);
        }
        return 0;
      }

      case "info": {
        const identity = await identifyVehicle((a, n) => connection.clientFor(a, n), { logger });
        say(`\n${C.bold}Véhicule${C.reset}`);
        say(`  VIN         ${identity.vin?.vin ?? "inconnu"}`);
        say(`  plateforme  ${identity.vin?.chassis ?? "non reconnue"} (famille ${identity.family})`);
        say(`  année       ${identity.vin?.modelYear ?? "?"}`);
        say(`  modules     ${identity.modules.map((m) => m.name).join(", ") || "aucun"}`);
        if (!identity.vin?.chassis) warn("plateforme non reconnue : les filtres de compatibilité des réglages seront inopérants");
        return 0;
      }

      case "tweaks": {
        const catalog = await buildCatalog(args.flags);
        const wanted = args.flags.module ? String(args.flags.module).toUpperCase() : null;
        const tweaks = catalog.all().filter((t) => !wanted || t.module.toUpperCase() === wanted);
        for (const [category, list] of catalog.byCategory()) {
          const filtered = list.filter((t) => tweaks.includes(t));
          if (!filtered.length) continue;
          say(`\n${C.bold}${category}${C.reset}`);
          for (const tweak of filtered) {
            const badge = tweak.verified ? `${C.green}vérifié${C.reset}` : `${C.yellow}non vérifié${C.reset}`;
            say(`  ${C.bold}${tweak.id}${C.reset} — ${tweak.label} ${C.dim}[${tweak.module}, risque ${tweak.risk}]${C.reset} ${badge}`);
            say(`      choix: ${tweak.choices.map((c) => c.id).join(" | ")}`);
          }
        }
        return 0;
      }

      case "read": {
        const catalog = await buildCatalog(args.flags);
        const tweak = catalog.byId(args.positional[0] ?? "");
        if (!tweak) { fail(`réglage inconnu "${args.positional[0]}"`); return 1; }
        const client = connection.clientFor(addressOf(tweak.module), tweak.module);
        const session = new CodingSession(client, { ecuName: tweak.module, address: addressOf(tweak.module), backups: backupStore(args.flags), logger, keyProvider: demoKeyProvider });
        await session.open();
        const { choice, raw } = await readTweak(session, tweak);
        say(`\n${C.bold}${tweak.label}${C.reset} (${tweak.module})`);
        say(`  valeur actuelle : ${choice ? `${C.green}${choice.label}${C.reset} (${choice.id})` : `${C.yellow}non reconnue${C.reset}`}  ${C.dim}brut: ${raw.join(", ")}${C.reset}`);
        await session.close();
        await client.close();
        return 0;
      }

      case "apply": {
        const catalog = await buildCatalog(args.flags);
        const [tweakId, choiceId] = args.positional;
        const tweak = catalog.byId(tweakId ?? "");
        if (!tweak) { fail(`réglage inconnu "${tweakId}"`); return 1; }
        if (!choiceId) { fail(`choix manquant (disponibles: ${tweak.choices.map((c) => c.id).join(", ")})`); return 1; }

        const address = addressOf(tweak.module);
        const client = connection.clientFor(address, tweak.module);
        const session = new CodingSession(client, {
          ecuName: tweak.module, address, backups: backupStore(args.flags), logger,
          keyProvider: demoKeyProvider,
          ...(tweak.requiresSecurity !== undefined ? { securityLevel: tweak.requiresSecurity } : {}),
        });
        await session.open();
        // En simulation, rien n'est écrit : on laisse voir le diff même pour un
        // réglage non confirmé — c'est précisément ainsi qu'on le vérifie.
        const dryRun = args.flags["dry-run"] === true;
        await stageTweak(session, tweak, choiceId, {
          allowUnverified: args.flags["allow-unverified"] === true || dryRun,
          allowHighRisk: args.flags["allow-high-risk"] === true || dryRun,
        });
        if (dryRun && !tweak.verified) warn(`offsets non confirmés pour "${tweak.id}" : vérifiez le diff ci-dessous avant d'écrire`);
        if (tweak.risk === "eleve") warn(`réglage classé à risque élevé : ${tweak.description ?? "peut affecter la sécurité ou la conformité du véhicule"}`);

        const result = await session.commit({
          dryRun,
          verify: true,
          reset: args.flags.reset === true || (tweak.requiresReset ?? false),
        });

        if (!result.changes.length) { say("rien à changer : la valeur demandée est déjà en place"); }
        for (const change of result.changes) {
          say(`\n${C.bold}${change.label}${C.reset}`);
          say(`  avant ${C.dim}${change.before}${C.reset}`);
          say(`  après ${C.bold}${change.after}${C.reset}`);
          say(`  ${change.changedBytes.map((d) => `octet ${d.offset}: 0x${d.before.toString(16).padStart(2, "0")} -> 0x${d.after.toString(16).padStart(2, "0")}`).join(", ")}`);
        }
        if (result.dryRun) warn("simulation : rien n'a été écrit (retirez --dry-run pour appliquer)");
        else {
          ok(`écrit et vérifié par relecture${result.resetPerformed ? ", ECU redémarrée" : ""}`);
          for (const backup of result.backups) say(`  ${C.dim}sauvegarde: ${backup.id}${C.reset}`);
          if (!result.resetPerformed && tweak.requiresReset) warn("coupez le contact puis rouvrez le véhicule pour que le réglage prenne effet");
        }
        await session.close();
        await client.close();
        return 0;
      }

      case "dtc": {
        const moduleName = String(args.flags.module ?? "KOMBI");
        const client = connection.clientFor(addressOf(moduleName), moduleName);
        await client.startSession();
        if (args.flags.clear) { await client.clearDtcs(); ok(`défauts effacés sur ${moduleName}`); }
        else {
          const dtcs = await client.readDtcs();
          if (!dtcs.length) ok(`aucun défaut mémorisé sur ${moduleName}`);
          for (const dtc of dtcs) {
            say(`  ${C.bold}${dtc.codeHex}${C.reset} statut 0x${dtc.status.toString(16).padStart(2, "0")}` +
                `${dtc.confirmed ? " confirmé" : ""}${dtc.pending ? " en attente" : ""}${dtc.testFailed ? " test échoué" : ""}`);
          }
        }
        await client.close();
        return 0;
      }

      case "did": {
        const moduleName = String(args.flags.module ?? "KOMBI");
        const did = Number(args.flags.did);
        if (!Number.isInteger(did)) { fail("--did manquant (ex. --did 0xF190)"); return 1; }
        const client = connection.clientFor(addressOf(moduleName), moduleName);
        await client.startSession();
        if (args.flags.write) {
          const data = hexToBytes(String(args.flags.write));
          warn(`écriture brute sans sauvegarde ni vérification sur ${moduleName} DID 0x${did.toString(16)}`);
          await client.writeDataByIdentifier(did, data);
          ok("écrit");
        }
        const value = await client.readDataByIdentifier(did);
        say(`  DID 0x${did.toString(16).toUpperCase()} = ${bytesToHex(value, " ")}  ${C.dim}"${new TextDecoder().decode(value).replace(/[^\x20-\x7e]/g, ".")}"${C.reset}`);
        await client.close();
        return 0;
      }

      case "backups": {
        const store = backupStore(args.flags);
        const list = await store.list(args.flags.vin ? { vin: String(args.flags.vin) } : undefined);
        if (!list.length) { say("aucune sauvegarde"); return 0; }
        for (const backup of list) say(`  ${backup.createdAt}  ${C.bold}${backup.ecuName}${C.reset}  ${backup.vin}  ${C.dim}${backup.id}${C.reset}`);
        return 0;
      }

      case "restore": {
        const id = args.positional[0];
        if (!id) { fail("identifiant de sauvegarde manquant"); return 1; }
        const store = backupStore(args.flags);
        const backup = await store.get(id);
        if (!backup) { fail(`sauvegarde "${id}" introuvable`); return 1; }
        const client = connection.clientFor(backup.address, backup.ecuName);
        const session = new CodingSession(client, { ecuName: backup.ecuName, address: backup.address, backups: store, logger, keyProvider: demoKeyProvider });
        await session.open();
        await session.restore(backup, { force: args.flags.force === true });
        ok(`codage d'origine restauré sur ${backup.ecuName}`);
        await session.close();
        await client.close();
        return 0;
      }

      default:
        fail(`commande inconnue "${args.command}"`);
        usage();
        return 1;
    }
  } finally {
    await connection.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof UdsNegativeResponse) fail(`l'ECU a refusé: ${err.message}`);
    else fail(String(err instanceof Error ? err.message : err));
    if (process.env.BIMMER_DEBUG) console.error(err);
    process.exit(1);
  });
