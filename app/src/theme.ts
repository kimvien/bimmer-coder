export const theme = {
  bg: "#0d1117",
  card: "#161b22",
  border: "#30363d",
  text: "#e6edf3",
  muted: "#8b949e",
  accent: "#1f6feb",
  ok: "#3fb950",
  warn: "#d29922",
  danger: "#f85149",
  radius: 12,
  gap: 12,
};

export const riskColor = (risk: string): string =>
  risk === "eleve" ? theme.danger : risk === "moyen" ? theme.warn : theme.ok;
