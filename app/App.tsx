import React, { useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from "react-native";
import { CoderProvider, useCoder } from "./src/state/CoderProvider.tsx";
import { ConnectScreen } from "./src/screens/ConnectScreen.tsx";
import { VehicleScreen } from "./src/screens/VehicleScreen.tsx";
import { TweaksScreen } from "./src/screens/TweaksScreen.tsx";
import { BackupsScreen } from "./src/screens/BackupsScreen.tsx";
import { theme } from "./src/theme.ts";

type Tab = "vehicule" | "reglages" | "sauvegardes";

function Shell(): React.JSX.Element {
  const { phase, message } = useCoder();
  const [tab, setTab] = useState<Tab>("vehicule");

  if (phase === "connexion" || phase === "identification") {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.accent} />
        <Text style={styles.centerText}>{message ?? "connexion…"}</Text>
      </View>
    );
  }

  if (phase !== "pret") return <ConnectScreen />;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        {tab === "vehicule" && <VehicleScreen />}
        {tab === "reglages" && <TweaksScreen />}
        {tab === "sauvegardes" && <BackupsScreen />}
      </View>
      <View style={styles.tabBar}>
        {([["vehicule", "Véhicule"], ["reglages", "Réglages"], ["sauvegardes", "Sauvegardes"]] as const).map(([key, label]) => (
          <Pressable key={key} style={styles.tab} onPress={() => setTab(key)}>
            <Text style={[styles.tabLabel, tab === key && styles.tabLabelActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function App(): React.JSX.Element {
  return (
    <CoderProvider>
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" />
        <Shell />
      </SafeAreaView>
    </CoderProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  centerText: { color: theme.muted, fontSize: 13 },
  tabBar: {
    flexDirection: "row", borderTopColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: theme.card,
  },
  tab: { flex: 1, paddingVertical: 14, alignItems: "center" },
  tabLabel: { color: theme.muted, fontSize: 13, fontWeight: "500" },
  tabLabelActive: { color: theme.text, fontWeight: "700" },
});
