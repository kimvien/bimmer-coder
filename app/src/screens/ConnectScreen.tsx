import React, { useCallback, useState } from "react";
import { PermissionsAndroid, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { scanForAdapters, type BleScanResult } from "../transport/BleTransport.ts";
import { useCoder } from "../state/CoderProvider.tsx";
import { Button, Card } from "../components.tsx";
import { theme } from "../theme.ts";

/** Android 12+ exige BLUETOOTH_SCAN/CONNECT ; avant, la localisation fine. */
async function askPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const api = Number(Platform.Version);
  const wanted = api >= 31
    ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(wanted);
  return Object.values(result).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
}

export function ConnectScreen(): React.JSX.Element {
  const { manager, connect, connectSimulator, phase, message } = useCoder();
  const [devices, setDevices] = useState<BleScanResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setError(null);
    if (!(await askPermissions())) { setError("permissions Bluetooth refusées"); return; }
    setDevices([]);
    setScanning(true);
    try {
      await scanForAdapters(manager, (device) => {
        setDevices((previous) => (previous.some((d) => d.id === device.id) ? previous : [...previous, device]));
      });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setScanning(false); }
  }, [manager]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Adaptateur OBD</Text>
      <Text style={styles.help}>
        Contact mis, moteur à l'arrêt. Branchez l'adaptateur sur la prise OBD, puis lancez la recherche.
      </Text>

      <Card>
        <Button label={scanning ? "recherche…" : "Rechercher un adaptateur"} onPress={scan} busy={scanning} />
        {devices.map((device) => (
          <View key={device.id} style={styles.device}>
            <View style={{ flex: 1 }}>
              <Text style={styles.deviceName}>{device.name || "sans nom"}</Text>
              <Text style={styles.deviceMeta}>{device.id}{device.rssi ? ` · ${device.rssi} dBm` : ""}</Text>
            </View>
            <View style={{ width: 110 }}>
              <Button label="Connecter" onPress={() => void connect(device.id, device.name)} />
            </View>
          </View>
        ))}
        {!scanning && devices.length === 0 && (
          <Text style={styles.help}>Aucun adaptateur trouvé pour l'instant.</Text>
        )}
      </Card>

      <Card>
        <Text style={styles.sectionTitle}>Sans voiture</Text>
        <Text style={styles.help}>
          Le véhicule virtuel permet de parcourir l'application, de lire des réglages et de voir
          les diffs d'écriture sans aucun matériel.
        </Text>
        <Button label="Ouvrir le véhicule virtuel" tone="neutre" onPress={() => void connectSimulator()} />
      </Card>

      {(error || (phase === "erreur" && message)) && (
        <Card style={{ borderColor: theme.danger }}>
          <Text style={{ color: theme.danger }}>{error ?? message}</Text>
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: theme.gap, paddingBottom: 40 },
  title: { color: theme.text, fontSize: 22, fontWeight: "700", marginBottom: 4 },
  sectionTitle: { color: theme.text, fontSize: 16, fontWeight: "600", marginBottom: 4 },
  help: { color: theme.muted, fontSize: 13, lineHeight: 19, marginBottom: 8 },
  device: {
    flexDirection: "row", alignItems: "center", gap: theme.gap,
    borderTopColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: theme.gap, marginTop: theme.gap,
  },
  deviceName: { color: theme.text, fontWeight: "600" },
  deviceMeta: { color: theme.muted, fontSize: 11 },
});
