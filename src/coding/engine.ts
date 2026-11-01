import { CodingGuardError } from "../util/errors.ts";
import { bytesToHex, equalBytes } from "../util/hex.ts";
import { silentLogger, type Logger } from "../util/log.ts";
import { SESSION, type KeyProvider, type UdsClient } from "../uds/uds.ts";
import { backupData, makeBackup, type BackupStore, type CodingBackup } from "./backup.ts";
import {
  containerKey, containerLabel, diffBytes, maxValueFor, normalizeLocation, readBits, writeBits,
  type ContainerRef, type ParameterLocation,
} from "./model.ts";

export interface CodingSessionOptions {
  ecuName: string;
  address: number;
  backups: BackupStore;
  vin?: string;
  /** Accès sécurité requis par l'ECU avant écriture (service 0x27). */
  securityLevel?: number;
  keyProvider?: KeyProvider;
  logger?: Logger;
  /** Interdit toute écriture sans sauvegarde enregistrée. Par défaut: true. */
  requireBackup?: boolean;
  /**
   * Garde-fou : nombre maximal d'octets modifiables dans un conteneur.
   * Un offset erroné dans un catalogue se traduit presque toujours par un
   * diff anormalement gros — on préfère refuser que d'écrire n'importe quoi.
   */
  maxChangedBytes?: number;
}

export interface ContainerState { ref: ContainerRef; original: Uint8Array; staged: Uint8Array; }

export interface PlannedChange {
  container: ContainerRef;
  label: string;
  before: string;
  after: string;
  changedBytes: Array<{ offset: number; before: number; after: number }>;
}

export interface CommitResult {
  dryRun: boolean;
  changes: PlannedChange[];
  backups: CodingBackup[];
  verified: boolean;
  resetPerformed: boolean;
}

/**
 * Une session de codage sur une ECU : lecture des conteneurs, préparation des
 * modifications, puis écriture atomique par conteneur avec vérification.
 *
 * Rien n'est écrit avant `commit()`, et `commit({ dryRun: true })` montre
 * exactement les octets qui changeraient.
 */
export class CodingSession {
  private readonly client: UdsClient;
  private readonly opts: CodingSessionOptions;
  private readonly log: Logger;
  private readonly containers = new Map<string, ContainerState>();
  private vin: string;
  private opened = false;

  constructor(client: UdsClient, options: CodingSessionOptions) {
    this.client = client;
    this.opts = options;
    this.log = options.logger ?? silentLogger;
    this.vin = options.vin ?? "";
  }

  get ecuName(): string { return this.opts.ecuName; }

  /** Session étendue + maintien en vie + déverrouillage éventuel. */
  async open(): Promise<void> {
    if (this.opened) return;
    await this.client.startSession(SESSION.EXTENDED);
    this.client.startKeepAlive(2000);
    if (!this.vin) {
      try { this.vin = await this.client.readVin(); } catch { this.log.debug("VIN illisible sur cette ECU"); }
    }
    if (this.opts.securityLevel !== undefined) {
      if (!this.opts.keyProvider) {
        throw new CodingGuardError(
          `l'ECU ${this.opts.ecuName} demande un accès sécurité (niveau 0x${this.opts.securityLevel.toString(16)}) ` +
          `mais aucun fournisseur de clé n'est configuré`,
        );
      }
      await this.client.securityAccess(this.opts.securityLevel, this.opts.keyProvider, this.opts.ecuName);
    }
    this.opened = true;
    this.log.info(`session de codage ouverte sur ${this.opts.ecuName} (VIN ${this.vin || "inconnu"})`);
  }

  /** Lit un conteneur (DID ou bloc mémoire) et le met en cache. */
  async readContainer(ref: ContainerRef, refresh = false): Promise<Uint8Array> {
    const key = containerKey(ref);
    const cached = this.containers.get(key);
    if (cached && !refresh) return cached.staged;

    const data = ref.kind === "did"
      ? await this.client.readDataByIdentifier(ref.did)
      : await this.client.uploadBlock(ref.address, ref.size);

    this.log.debug(`lu ${containerLabel(ref)} = ${bytesToHex(data, " ")}`);
    this.containers.set(key, { ref, original: data, staged: new Uint8Array(data) });
    return data;
  }

  async readParameter(location: ParameterLocation): Promise<number> {
    const data = await this.readContainer(location.container);
    return readBits(data, location);
  }

  /** Prépare une modification sans l'écrire. */
  async stage(location: ParameterLocation, value: number): Promise<void> {
    const norm = normalizeLocation(location);
    const limit = maxValueFor(norm.bitLength);
    if (value < 0 || value > limit) throw new RangeError(`valeur ${value} hors plage 0-${limit}`);
    await this.readContainer(location.container);
    const key = containerKey(location.container);
    const state = this.containers.get(key)!;
    state.staged = writeBits(state.staged, location, value);
  }

  /** Annule toutes les modifications préparées. */
  resetStaged(): void {
    for (const state of this.containers.values()) state.staged = new Uint8Array(state.original);
  }

  /** Ce que `commit()` écrirait, conteneur par conteneur. */
  plan(): PlannedChange[] {
    const out: PlannedChange[] = [];
    for (const state of this.containers.values()) {
      const changedBytes = diffBytes(state.original, state.staged);
      if (changedBytes.length === 0) continue;
      out.push({
        container: state.ref,
        label: containerLabel(state.ref),
        before: bytesToHex(state.original, " "),
        after: bytesToHex(state.staged, " "),
        changedBytes,
      });
    }
    return out;
  }

  /**
   * Écrit les modifications préparées.
   * Ordre par conteneur : sauvegarde -> écriture -> relecture -> (rollback si écart).
   */
  async commit(options: { dryRun?: boolean; verify?: boolean; reset?: boolean } = {}): Promise<CommitResult> {
    const dryRun = options.dryRun ?? false;
    const verify = options.verify ?? true;
    const changes = this.plan();
    const backups: CodingBackup[] = [];

    if (changes.length === 0) {
      return { dryRun, changes, backups, verified: true, resetPerformed: false };
    }

    const maxChanged = this.opts.maxChangedBytes ?? 32;
    for (const change of changes) {
      if (change.changedBytes.length > maxChanged) {
        throw new CodingGuardError(
          `refus d'écrire ${change.changedBytes.length} octets dans ${change.label} ` +
          `(limite ${maxChanged}). Offsets du catalogue probablement faux.`,
        );
      }
    }

    if (dryRun) {
      this.log.info(`simulation: ${changes.length} conteneur(s) seraient modifiés, rien n'a été écrit`);
      return { dryRun, changes, backups, verified: true, resetPerformed: false };
    }

    if (!this.opened) throw new CodingGuardError("session de codage non ouverte");

    // 1. Sauvegardes — avant la moindre écriture.
    if (this.opts.requireBackup !== false) {
      for (const change of changes) {
        const state = this.containers.get(containerKey(change.container))!;
        const backup = makeBackup({
          vin: this.vin, ecuName: this.opts.ecuName, address: this.opts.address,
          container: change.container, data: state.original, note: "avant codage",
        });
        await this.opts.backups.save(backup);
        backups.push(backup);
        this.log.info(`sauvegarde ${backup.id}`);
      }
    }

    // 2. Écriture + vérification, conteneur par conteneur.
    let verified = true;
    for (const change of changes) {
      const state = this.containers.get(containerKey(change.container))!;
      this.log.info(`écriture ${change.label}: ${change.before} -> ${change.after}`);
      await this.writeContainer(change.container, state.staged);

      if (!verify) continue;
      const readBack = await this.readRaw(change.container);
      if (!equalBytes(readBack, state.staged)) {
        verified = false;
        this.log.error(`relecture différente: ${bytesToHex(readBack, " ")} ≠ ${change.after} — retour arrière`);
        await this.writeContainer(change.container, state.original).catch((e) =>
          this.log.error(`ÉCHEC du retour arrière sur ${change.label}: ${String(e)}. Sauvegarde: ${backups.at(-1)?.id ?? "aucune"}`));
        throw new CodingGuardError(`écriture non confirmée sur ${change.label} : retour arrière effectué`);
      }
      state.original = new Uint8Array(state.staged);
    }

    // 3. Reset ECU : la plupart des paramètres ne prennent effet qu'après.
    let resetPerformed = false;
    if (options.reset) {
      try { await this.client.ecuReset(); resetPerformed = true; }
      catch (err) { this.log.error(`reset ECU refusé: ${String(err)} (coupez/remettez le contact)`); }
    }

    return { dryRun, changes, backups, verified, resetPerformed };
  }

  private async writeContainer(ref: ContainerRef, data: Uint8Array): Promise<void> {
    if (ref.kind === "did") await this.client.writeDataByIdentifier(ref.did, data);
    else await this.client.downloadBlock(ref.address, data);
  }

  private async readRaw(ref: ContainerRef): Promise<Uint8Array> {
    return ref.kind === "did"
      ? this.client.readDataByIdentifier(ref.did)
      : this.client.uploadBlock(ref.address, ref.size);
  }

  /** Restaure une sauvegarde. Le VIN doit correspondre : jamais le codage d'une autre voiture. */
  async restore(backup: CodingBackup, options: { force?: boolean } = {}): Promise<void> {
    if (!this.opened) throw new CodingGuardError("session de codage non ouverte");
    if (this.vin && backup.vin && backup.vin !== this.vin && !options.force) {
      throw new CodingGuardError(`sauvegarde issue du VIN ${backup.vin}, véhicule connecté ${this.vin} — restauration refusée`);
    }
    if (backup.ecuName !== this.opts.ecuName && !options.force) {
      throw new CodingGuardError(`sauvegarde de l'ECU ${backup.ecuName}, session ouverte sur ${this.opts.ecuName}`);
    }
    const data = backupData(backup);
    await this.writeContainer(backup.container, data);
    const readBack = await this.readRaw(backup.container);
    if (!equalBytes(readBack, data)) throw new CodingGuardError("restauration non confirmée par relecture");
    this.containers.set(containerKey(backup.container), { ref: backup.container, original: data, staged: new Uint8Array(data) });
    this.log.info(`sauvegarde ${backup.id} restaurée`);
  }

  async close(): Promise<void> {
    this.client.stopKeepAlive();
    this.opened = false;
  }
}
