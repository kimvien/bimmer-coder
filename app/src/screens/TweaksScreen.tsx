import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import type { Tweak } from "@core/catalog/schema.ts";
import type { PlannedChange } from "@core/coding/engine.ts";
import { useCoder } from "../state/CoderProvider.tsx";
import { Badge, Button, Card } from "../components.tsx";
import { riskColor, theme } from "../theme.ts";

export function TweaksScreen(): React.JSX.Element {
  const { tweaks } = useCoder();
  const [selected, setSelected] = useState<Tweak | null>(null);

  const categories = [...new Set(tweaks.map((t) => t.category))];

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Réglages</Text>
        {tweaks.length === 0 && <Text style={styles.help}>Aucun réglage compatible avec ce véhicule.</Text>}
        {categories.map((category) => (
          <View key={category}>
            <Text style={styles.sectionTitle}>{category}</Text>
            {tweaks.filter((t) => t.category === category).map((tweak) => (
              <Pressable key={tweak.id} onPress={() => setSelected(tweak)}>
                <Card>
                  <View style={styles.header}>
                    <Text style={styles.name}>{tweak.label}</Text>
                    <Badge label={`risque ${tweak.risk}`} color={riskColor(tweak.risk)} />
                  </View>
                  <Text style={styles.meta}>{tweak.module}{tweak.description ? ` · ${tweak.description}` : ""}</Text>
                  {!tweak.verified && <Text style={styles.unverified}>offsets non confirmés sur véhicule réel</Text>}
                </Card>
              </Pressable>
            ))}
          </View>
        ))}
      </ScrollView>
      <TweakSheet tweak={selected} onClose={() => setSelected(null)} />
    </>
  );
}

/** Détail d'un réglage : lecture de l'état, aperçu du diff, puis écriture. */
function TweakSheet({ tweak, onClose }: { tweak: Tweak | null; onClose: () => void }): React.JSX.Element {
  const { currentChoice, preview, apply } = useCoder();
  const [current, setCurrent] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [changes, setChanges] = useState<PlannedChange[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acceptRisk, setAcceptRisk] = useState(false);

  useEffect(() => {
    setCurrent(null); setChoice(null); setChanges(null); setDone(null); setError(null); setAcceptRisk(false);
    if (!tweak) return;
    setBusy(true);
    currentChoice(tweak)
      .then((value) => { setCurrent(value); setChoice(value); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }, [tweak, currentChoice]);

  const onPreview = useCallback(async () => {
    if (!tweak || !choice) return;
    setBusy(true); setError(null);
    try { setChanges(await preview(tweak, choice)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }, [tweak, choice, preview]);

  const onApply = useCallback(async () => {
    if (!tweak || !choice) return;
    setBusy(true); setError(null);
    try {
      const result = await apply(tweak, choice, { allowHighRisk: acceptRisk });
      setCurrent(choice);
      setChanges(null);
      setDone(result.resetPerformed
        ? "Écrit, vérifié par relecture, calculateur redémarré."
        : "Écrit et vérifié. Coupez le contact pour que le réglage prenne effet.");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }, [tweak, choice, acceptRisk, apply]);

  if (!tweak) return <Modal visible={false}><View /></Modal>;
  const needsRiskConfirmation = tweak.risk === "eleve";

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <ScrollView style={{ backgroundColor: theme.bg }} contentContainerStyle={styles.container}>
        <Text style={styles.title}>{tweak.label}</Text>
        <Text style={styles.meta}>{tweak.module} · risque {tweak.risk}</Text>
        {tweak.description ? <Text style={styles.help}>{tweak.description}</Text> : null}

        <Card>
          <Text style={styles.sectionTitle}>État sur le véhicule</Text>
          {busy && !current ? <ActivityIndicator color={theme.accent} /> : (
            <Text style={styles.value}>
              {current ? tweak.choices.find((c) => c.id === current)?.label ?? current : "valeur non reconnue"}
            </Text>
          )}
        </Card>

        <Card>
          <Text style={styles.sectionTitle}>Choix</Text>
          {tweak.choices.map((option) => (
            <Pressable key={option.id} onPress={() => { setChoice(option.id); setChanges(null); setDone(null); }}>
              <View style={[styles.option, choice === option.id && styles.optionActive]}>
                <Text style={styles.optionLabel}>{option.label}</Text>
                {current === option.id && <Badge label="actuel" color={theme.muted} />}
              </View>
            </Pressable>
          ))}
        </Card>

        {!tweak.verified && (
          <Card style={{ borderColor: theme.warn }}>
            <Text style={{ color: theme.warn, fontSize: 13, lineHeight: 19 }}>
              Les offsets de ce réglage ne sont pas confirmés sur un véhicule réel.
              Regardez l'aperçu : seuls les octets attendus doivent changer.
            </Text>
          </Card>
        )}

        {needsRiskConfirmation && (
          <Card style={{ borderColor: theme.danger }}>
            <View style={styles.header}>
              <Text style={{ color: theme.danger, flex: 1, fontSize: 13, lineHeight: 19 }}>
                Réglage à risque élevé : il peut affecter la sécurité du véhicule ou sa conformité réglementaire.
              </Text>
              <Switch value={acceptRisk} onValueChange={setAcceptRisk} />
            </View>
          </Card>
        )}

        {changes?.length ? (
          <Card>
            <Text style={styles.sectionTitle}>Ce qui sera écrit</Text>
            {changes.map((change) => (
              <View key={change.label} style={{ marginBottom: 8 }}>
                <Text style={styles.meta}>{change.label}</Text>
                <Text style={styles.hexBefore}>{change.before}</Text>
                <Text style={styles.hexAfter}>{change.after}</Text>
                {change.changedBytes.map((byte) => (
                  <Text key={byte.offset} style={styles.meta}>
                    octet {byte.offset} : 0x{byte.before.toString(16).padStart(2, "0")} → 0x{byte.after.toString(16).padStart(2, "0")}
                  </Text>
                ))}
              </View>
            ))}
          </Card>
        ) : null}
        {changes?.length === 0 && <Text style={styles.help}>Cette valeur est déjà en place, rien à écrire.</Text>}

        {done && <Card style={{ borderColor: theme.ok }}><Text style={{ color: theme.ok }}>{done}</Text></Card>}
        {error && <Card style={{ borderColor: theme.danger }}><Text style={{ color: theme.danger }}>{error}</Text></Card>}

        <Button label="Aperçu (rien n'est écrit)" tone="neutre" onPress={() => void onPreview()} busy={busy} disabled={!choice} />
        <Button
          label="Écrire dans le calculateur"
          onPress={() => void onApply()}
          busy={busy}
          disabled={!choice || choice === current || (needsRiskConfirmation && !acceptRisk)}
        />
        <Button label="Fermer" tone="neutre" onPress={onClose} />
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { padding: theme.gap, paddingBottom: 48 },
  title: { color: theme.text, fontSize: 22, fontWeight: "700", marginBottom: 4 },
  sectionTitle: { color: theme.text, fontSize: 15, fontWeight: "600", marginBottom: 6 },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { color: theme.text, fontWeight: "600", fontSize: 15, flex: 1 },
  meta: { color: theme.muted, fontSize: 12, marginBottom: 2 },
  help: { color: theme.muted, fontSize: 13, lineHeight: 19, marginBottom: 8 },
  value: { color: theme.text, fontSize: 15, fontWeight: "600" },
  unverified: { color: theme.warn, fontSize: 11, marginTop: 4 },
  option: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    borderWidth: 1, borderColor: theme.border, borderRadius: theme.radius, padding: 10, marginBottom: 6,
  },
  optionActive: { borderColor: theme.accent, backgroundColor: "#132b57" },
  optionLabel: { color: theme.text, fontSize: 14 },
  hexBefore: { color: theme.muted, fontFamily: "monospace", fontSize: 11 },
  hexAfter: { color: theme.ok, fontFamily: "monospace", fontSize: 11, marginBottom: 4 },
});
