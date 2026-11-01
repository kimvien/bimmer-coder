import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { BleManager } from "react-native-ble-plx";
import { openConnection, type VehicleConnection } from "@core/connection.ts";
import { createLogger } from "@core/util/log.ts";
import { identifyVehicle, type VehicleIdentity } from "@core/vehicle/scan.ts";
import { moduleByName } from "@core/vehicle/modules.ts";
import { CodingSession, type PlannedChange } from "@core/coding/engine.ts";
import { TweakCatalog, type Tweak } from "@core/catalog/schema.ts";
import { DEMO_TWEAKS } from "@core/catalog/tweaks.ts";
import { readTweak, stageTweak } from "@core/catalog/apply.ts";
import type { CodingBackup } from "@core/coding/backup.ts";
import { BleTransport } from "../transport/BleTransport.ts";
import { AsyncBackupStore } from "../storage/AsyncBackupStore.ts";

export type Phase = "deconnecte" | "connexion" | "identification" | "pret" | "erreur";

interface CoderState {
  phase: Phase;
  message: string | null;
  identity: VehicleIdentity | null;
  tweaks: Tweak[];
  manager: BleManager;
  connect(deviceId: string, label?: string): Promise<void>;
  connectSimulator(): Promise<void>;
  disconnect(): Promise<void>;
  /** Lit la valeur courante d'un réglage sur le véhicule. */
  currentChoice(tweak: Tweak): Promise<string | null>;
  /** Calcule le diff sans rien écrire. */
  preview(tweak: Tweak, choiceId: string): Promise<PlannedChange[]>;
  /** Écrit, vérifie par relecture, et sauvegarde l'état d'origine. */
  apply(tweak: Tweak, choiceId: string, options: { allowHighRisk?: boolean }): Promise<{ backups: CodingBackup[]; resetPerformed: boolean }>;
  backups(): Promise<CodingBackup[]>;
  restore(backup: CodingBackup): Promise<void>;
}

const Context = createContext<CoderState | null>(null);

export const useCoder = (): CoderState => {
  const value = useContext(Context);
  if (!value) throw new Error("useCoder doit être utilisé dans <CoderProvider>");
  return value;
};

export function CoderProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const manager = useMemo(() => new BleManager(), []);
  const logger = useMemo(() => createLogger("info"), []);
  const backupStore = useMemo(() => new AsyncBackupStore(), []);
  const catalog = useMemo(() => { const c = new TweakCatalog(); c.add(DEMO_TWEAKS); return c; }, []);

  const connectionRef = useRef<VehicleConnection | null>(null);
  const [phase, setPhase] = useState<Phase>("deconnecte");
  const [message, setMessage] = useState<string | null>(null);
  const [identity, setIdentity] = useState<VehicleIdentity | null>(null);

  const identify = useCallback(async (connection: VehicleConnection) => {
    setPhase("identification");
    setMessage("lecture du VIN et recherche des calculateurs…");
    const found = await identifyVehicle((address, name) => connection.clientFor(address, name), { logger });
    setIdentity(found);
    setPhase("pret");
    setMessage(null);
  }, [logger]);

  const connect = useCallback(async (deviceId: string, label?: string) => {
    try {
      setPhase("connexion");
      setMessage("connexion à l'adaptateur…");
      const transport = new BleTransport(manager, deviceId, label);
      const connection = await openConnection({ kind: "elm327", transport, isoTpMode: "app" }, logger);
      connectionRef.current = connection;
      await identify(connection);
    } catch (err) {
      setPhase("erreur");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [identify, logger, manager]);

  /** Mode découverte : véhicule virtuel, sans voiture ni adaptateur. */
  const connectSimulator = useCallback(async () => {
    try {
      setPhase("connexion");
      const connection = await openConnection({ kind: "sim" }, logger);
      connectionRef.current = connection;
      await identify(connection);
    } catch (err) {
      setPhase("erreur");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [identify, logger]);

  const disconnect = useCallback(async () => {
    await connectionRef.current?.close().catch(() => undefined);
    connectionRef.current = null;
    setIdentity(null);
    setPhase("deconnecte");
    setMessage(null);
  }, []);

  /** Ouvre une session de codage sur le module visé par un réglage. */
  const withSession = useCallback(async <T,>(tweak: Tweak, fn: (session: CodingSession) => Promise<T>): Promise<T> => {
    const connection = connectionRef.current;
    if (!connection) throw new Error("aucun véhicule connecté");
    const def = moduleByName(tweak.module);
    if (!def) throw new Error(`module ${tweak.module} inconnu`);
    const client = connection.clientFor(def.address, def.name);
    const session = new CodingSession(client, {
      ecuName: def.name, address: def.address, backups: backupStore, logger,
      ...(identity?.vin?.vin ? { vin: identity.vin.vin } : {}),
      ...(tweak.requiresSecurity !== undefined ? { securityLevel: tweak.requiresSecurity } : {}),
    });
    await session.open();
    try { return await fn(session); }
    finally { await session.close(); await client.close().catch(() => undefined); }
  }, [backupStore, identity, logger]);

  const currentChoice = useCallback((tweak: Tweak) =>
    withSession(tweak, async (session) => (await readTweak(session, tweak)).choice?.id ?? null), [withSession]);

  const preview = useCallback((tweak: Tweak, choiceId: string) =>
    withSession(tweak, async (session) => {
      // Simulation : les garde-fous "non vérifié"/"risque élevé" ne s'appliquent
      // qu'à l'écriture, puisqu'ici rien ne part vers l'ECU.
      await stageTweak(session, tweak, choiceId, { allowUnverified: true, allowHighRisk: true });
      return (await session.commit({ dryRun: true })).changes;
    }), [withSession]);

  const apply = useCallback((tweak: Tweak, choiceId: string, options: { allowHighRisk?: boolean }) =>
    withSession(tweak, async (session) => {
      await stageTweak(session, tweak, choiceId, {
        allowUnverified: tweak.verified ? false : true,
        allowHighRisk: options.allowHighRisk ?? false,
      });
      const result = await session.commit({ verify: true, reset: tweak.requiresReset ?? false });
      return { backups: result.backups, resetPerformed: result.resetPerformed };
    }), [withSession]);

  const backups = useCallback(() => backupStore.list(
    identity?.vin?.vin ? { vin: identity.vin.vin } : undefined,
  ), [backupStore, identity]);

  const restore = useCallback(async (backup: CodingBackup) => {
    const connection = connectionRef.current;
    if (!connection) throw new Error("aucun véhicule connecté");
    const client = connection.clientFor(backup.address, backup.ecuName);
    const session = new CodingSession(client, {
      ecuName: backup.ecuName, address: backup.address, backups: backupStore, logger,
      ...(identity?.vin?.vin ? { vin: identity.vin.vin } : {}),
    });
    await session.open();
    try { await session.restore(backup); }
    finally { await session.close(); await client.close().catch(() => undefined); }
  }, [backupStore, identity, logger]);

  const tweaks = useMemo(() => catalog.forVehicle({
    ...(identity?.family ? { family: identity.family } : {}),
    ...(identity?.vin?.chassis ? { chassis: identity.vin.chassis } : {}),
    ...(identity?.modules ? { availableModules: identity.modules.map((m) => m.name) } : {}),
  }), [catalog, identity]);

  const value: CoderState = {
    phase, message, identity, tweaks, manager,
    connect, connectSimulator, disconnect, currentChoice, preview, apply, backups, restore,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
