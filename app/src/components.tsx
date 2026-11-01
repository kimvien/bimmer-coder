import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "./theme.ts";

export function Card({ children, style }: { children: React.ReactNode; style?: object }): React.JSX.Element {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({ label, onPress, tone = "accent", busy, disabled }: {
  label: string; onPress: () => void; tone?: "accent" | "danger" | "neutre"; busy?: boolean; disabled?: boolean;
}): React.JSX.Element {
  const background = tone === "danger" ? theme.danger : tone === "neutre" ? theme.border : theme.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [styles.button, { backgroundColor: background, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonLabel}>{label}</Text>}
    </Pressable>
  );
}

export function Badge({ label, color }: { label: string; color: string }): React.JSX.Element {
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeLabel, { color }]}>{label}</Text>
    </View>
  );
}

export function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.card, borderColor: theme.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius, padding: theme.gap, marginBottom: theme.gap,
  },
  button: { borderRadius: theme.radius, paddingVertical: 14, alignItems: "center", marginTop: 8 },
  buttonLabel: { color: "#fff", fontWeight: "600", fontSize: 15 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  badgeLabel: { fontSize: 11, fontWeight: "600" },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  rowLabel: { color: theme.muted, fontSize: 13 },
  rowValue: { color: theme.text, fontSize: 13, fontWeight: "500" },
});
