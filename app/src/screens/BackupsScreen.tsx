import React, { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text } from "react-native";
import type { CodingBackup } from "@core/coding/backup.ts";
import { useCoder } from "../state/CoderProvider.tsx";
import { Button, Card, Row } from "../components.tsx";
import { theme } from "../theme.ts";

export function BackupsScreen(): React.JSX.Element {
  const { backups, restore } = useCoder();
  const [items, setItems] = useState<CodingBackup[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => { backups().then(setItems).catch(() => setItems([])); }, [backups]);
  useEffect(refresh, [refresh]);

  const onRestore = useCallback((backup: CodingBackup) => {
    Alert.alert(
      "Restaurer ce codage ?",
      `Les octets d'origine de ${backup.ecuName} seront réécrits tels qu'ils étaient le ${new Date(backup.createdAt).toLocaleString("fr-FR")}.`,
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Restaurer", style: "destructive",
          onPress: () => {
            setBusy(backup.id); setError(null);
            restore(backup)
              .then(refresh)
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(null));
          },
        },
      ],
    );
  }, [restore, refresh]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Sauvegardes</Text>
      <Text style={styles.help}>
        Chaque écriture enregistre d'abord les octets d'origine du calculateur. C'est ce qui permet
        de revenir en arrière même si un réglage s'avère mauvais.
      </Text>
      {items.length === 0 && <Text style={styles.help}>Aucune sauvegarde pour ce véhicule.</Text>}
      {items.map((backup) => (
        <Card key={backup.id}>
          <Row label="Calculateur" value={backup.ecuName} />
          <Row label="Date" value={new Date(backup.createdAt).toLocaleString("fr-FR")} />
          <Row label="VIN" value={backup.vin || "inconnu"} />
          <Row label="Octets" value={`${backup.dataHex.length / 2} o · CRC ${backup.crc32}`} />
          <Button label="Restaurer" tone="danger" onPress={() => onRestore(backup)} busy={busy === backup.id} />
        </Card>
      ))}
      {error && <Card style={{ borderColor: theme.danger }}><Text style={{ color: theme.danger }}>{error}</Text></Card>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: theme.gap, paddingBottom: 40 },
  title: { color: theme.text, fontSize: 22, fontWeight: "700", marginBottom: 4 },
  help: { color: theme.muted, fontSize: 13, lineHeight: 19, marginBottom: 8 },
});
