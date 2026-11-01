import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useCoder } from "../state/CoderProvider.tsx";
import { Button, Card, Row } from "../components.tsx";
import { theme } from "../theme.ts";

export function VehicleScreen(): React.JSX.Element {
  const { identity, disconnect, tweaks } = useCoder();
  const vin = identity?.vin;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Véhicule</Text>
      <Card>
        <Row label="VIN" value={vin?.vin ?? "inconnu"} />
        <Row label="Plateforme" value={vin?.chassis ?? "non reconnue"} />
        <Row label="Famille" value={identity?.family ?? "?"} />
        <Row label="Année modèle" value={vin?.modelYear ? String(vin.modelYear) : "?"} />
        <Row label="Réglages compatibles" value={String(tweaks.length)} />
      </Card>

      {!vin?.chassis && (
        <Card style={{ borderColor: theme.warn }}>
          <Text style={{ color: theme.warn, fontSize: 13, lineHeight: 19 }}>
            Plateforme non reconnue : la compatibilité des réglages ne peut pas être filtrée.
            Vérifiez chaque diff avant d'écrire.
          </Text>
        </Card>
      )}

      <Text style={styles.sectionTitle}>Calculateurs détectés</Text>
      {(identity?.modules ?? []).map((module) => (
        <Card key={`${module.name}-${module.address}`}>
          <View style={styles.moduleHeader}>
            <Text style={styles.moduleName}>{module.name}</Text>
            <Text style={styles.moduleAddress}>0x{module.address.toString(16).padStart(2, "0")}</Text>
          </View>
          <Text style={styles.moduleRole}>{module.role}</Text>
          {module.softwareNumber ? <Row label="Logiciel" value={module.softwareNumber} /> : null}
          {module.serial ? <Row label="Numéro de série" value={module.serial} /> : null}
        </Card>
      ))}

      <Button label="Se déconnecter" tone="neutre" onPress={() => void disconnect()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: theme.gap, paddingBottom: 40 },
  title: { color: theme.text, fontSize: 22, fontWeight: "700", marginBottom: theme.gap },
  sectionTitle: { color: theme.text, fontSize: 16, fontWeight: "600", marginVertical: 8 },
  moduleHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  moduleName: { color: theme.text, fontWeight: "700", fontSize: 15 },
  moduleAddress: { color: theme.muted, fontFamily: "monospace", fontSize: 12 },
  moduleRole: { color: theme.muted, fontSize: 13, marginBottom: 6 },
});
