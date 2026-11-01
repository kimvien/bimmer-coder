import type { Tweak } from "./schema.ts";

/**
 * Catalogue de démonstration.
 *
 * Les paramètres ci-dessous reprennent les réglages classiques (vidéo en
 * roulant, vitesse numérique, rabattement des rétroviseurs...) mais leurs
 * offsets sont ceux du **simulateur** fourni dans src/sim/, pas ceux d'une
 * voiture réelle : d'où `verified: false` partout. Sur un véhicule, il faut
 * fournir un catalogue dont les offsets ont été établis à partir des fichiers
 * de description de vos ECU, via `loadCatalogFile()`.
 */
const DEMO_BLOCK = { kind: "memory", address: 0x3000, size: 16 } as const;

export const DEMO_TWEAKS: Tweak[] = [
  {
    id: "video-en-roulant",
    label: "Vidéo en roulant",
    description: "Autorise la lecture vidéo sur l'écran central au-delà de l'arrêt.",
    category: "multimedia",
    module: "HU",
    appliesTo: { families: ["F", "G"] },
    risk: "moyen",
    requiresReset: true,
    verified: false,
    source: "simulateur",
    choices: [
      { id: "desactive", label: "Désactivé (d'origine)", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 0, bitOffset: 0, bitLength: 1 }, value: 0 }] },
      { id: "active", label: "Activé", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 0, bitOffset: 0, bitLength: 1 }, value: 1 }] },
    ],
  },
  {
    id: "avertissement-legal",
    label: "Message d'avertissement au démarrage",
    description: "Supprime l'écran de décharge de responsabilité du système multimédia.",
    category: "multimedia",
    module: "HU",
    appliesTo: { families: ["F", "G"] },
    risk: "faible",
    requiresReset: true,
    verified: false,
    source: "simulateur",
    choices: [
      { id: "affiche", label: "Affiché (d'origine)", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 0, bitOffset: 1, bitLength: 1 }, value: 1 }] },
      { id: "masque", label: "Masqué", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 0, bitOffset: 1, bitLength: 1 }, value: 0 }] },
    ],
  },
  {
    id: "vitesse-numerique",
    label: "Vitesse numérique au combiné",
    description: "Affiche la vitesse en chiffres dans le combiné d'instruments.",
    category: "affichage",
    module: "KOMBI",
    appliesTo: { families: ["F", "G"] },
    risk: "faible",
    requiresReset: true,
    verified: false,
    source: "simulateur",
    choices: [
      { id: "desactive", label: "Désactivé", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 1, bitOffset: 0, bitLength: 2 }, value: 0 }] },
      { id: "km", label: "Activé (km/h)", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 1, bitOffset: 0, bitLength: 2 }, value: 1 }] },
      { id: "mph", label: "Activé (mph)", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 1, bitOffset: 0, bitLength: 2 }, value: 2 }] },
    ],
  },
  {
    id: "retroviseurs-rabattement",
    label: "Rabattement des rétroviseurs au verrouillage",
    category: "confort",
    module: "FEM_BODY",
    appliesTo: { families: ["F"] },
    risk: "faible",
    requiresReset: true,
    verified: false,
    source: "simulateur",
    choices: [
      { id: "non", label: "Non", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 2, bitOffset: 0, bitLength: 1 }, value: 0 }] },
      { id: "oui", label: "Oui", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 2, bitOffset: 0, bitLength: 1 }, value: 1 }] },
    ],
  },
  {
    id: "clignotants-confort",
    label: "Nombre de clignotements du clignotant de confort",
    category: "eclairage",
    module: "FEM_BODY",
    appliesTo: { families: ["F"] },
    risk: "faible",
    requiresReset: true,
    verified: false,
    source: "simulateur",
    choices: [
      { id: "3", label: "3 clignotements (d'origine)", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 3, bitLength: 8 }, value: 3 }] },
      { id: "5", label: "5 clignotements", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 3, bitLength: 8 }, value: 5 }] },
      { id: "7", label: "7 clignotements", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 3, bitLength: 8 }, value: 7 }] },
    ],
  },
  {
    id: "rappel-ceinture",
    label: "Rappel sonore de ceinture",
    description: "Réglage sensible : dans beaucoup de pays, le désactiver rend le véhicule non conforme.",
    category: "securite",
    module: "KOMBI",
    appliesTo: { families: ["F", "G"] },
    risk: "eleve",
    requiresReset: true,
    verified: false,
    source: "simulateur",
    choices: [
      { id: "actif", label: "Actif (d'origine)", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 4, bitOffset: 0, bitLength: 1 }, value: 1 }] },
      { id: "inactif", label: "Inactif", changes: [{ location: { container: DEMO_BLOCK, byteOffset: 4, bitOffset: 0, bitLength: 1 }, value: 0 }] },
    ],
  },
];
