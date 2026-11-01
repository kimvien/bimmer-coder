# bimmer-coder

Reproduction fonctionnelle d'une application de codage BMW/Mini type **BimmerCode** :
même chaîne technique (adaptateur OBD → ISO-TP → UDS → codage de calculateur),
avec un cœur en TypeScript testé, un CLI utilisable immédiatement, un **véhicule
virtuel** pour travailler sans voiture, et une app mobile React Native.

Projet indépendant, sans aucun lien avec BimmerCode, BMW AG ou Mini. Aucun code,
aucune donnée et aucune ressource graphique de ces produits n'y figure.

---

## Ce qui marche aujourd'hui

| Brique | État | Vérifié par |
|---|---|---|
| ISO-TP (ISO 15765-2) : SF/FF/CF, Flow Control, BlockSize, STmin, adressage étendu BMW | complet | 7 tests, messages de 1 à 4095 octets |
| UDS (ISO 14229) : sessions, DID, sécurité 0x27, routines, DTC, transferts 0x34/0x35/0x36/0x37, NRC 0x78 | complet | 10 tests contre une ECU simulée |
| Pilote ELM327 / OBDLink : init AT, en-têtes, filtres, détection des dongles incapables | complet | 6 tests, dont un dongle bridé émulé |
| ENET / DoIP (câble Ethernet F/G) : activation de routage, framing, alive check | complet (non testé sur voiture) | 3 tests de framing |
| Moteur de codage : lecture de conteneur, patch de bits, sauvegarde, écriture, vérification, retour arrière | complet | 13 tests dont le scénario « ECU qui acquitte sans écrire » |
| Catalogue de réglages + chargement de catalogues externes | complet | 5 tests |
| Scan des calculateurs, décodage VIN | complet | 5 tests |
| CLI (`scan`, `info`, `tweaks`, `read`, `apply`, `dtc`, `did`, `backups`, `restore`) | utilisable | exécuté sur le véhicule virtuel |
| App mobile (BLE + 4 écrans) | code écrit, **jamais exécutée** faute d'appareil ici | — |

```
$ npm test
# tests 49
# pass 49
# fail 0
```

## Ce qui ne peut pas être copié — à lire avant tout

Un BimmerCode, ce n'est pas d'abord du protocole : c'est **une base de données
d'offsets**. Savoir que « vidéo en roulant » correspond à tel bit de tel octet de
tel bloc de codage de telle version de head-unit se déduit des fichiers de
description des calculateurs BMW (CAFD, dans les PSdZData), que ce dépôt
n'embarque pas et ne peut pas embarquer.

Conséquences assumées dans le code :

- le catalogue livré (`src/catalog/tweaks.ts`) contient les offsets **du
  simulateur**, et tous ses réglages sont marqués `verified: false` ;
- un réglage non vérifié **ne peut pas être écrit** sans `--allow-unverified` ;
- pour de vrais réglages, on fournit son propre catalogue JSON
  (`--catalog mon-catalogue.json`, voir `exemples/catalogue-f30.json`) ;
- les algorithmes seed/key du service 0x27 appartiennent à l'outillage
  constructeur : le code expose une interface `KeyProvider` à brancher, et un
  algorithme de démonstration côté simulateur. Rien d'autre.

## Démarrage

Node ≥ 22.6 suffit : le TypeScript est exécuté nativement, il n'y a aucune étape de build.

```bash
npm install                       # juste typescript + @types/node (dev)
npm test                          # 49 tests, sans matériel

# véhicule virtuel
node src/cli.ts scan
node src/cli.ts info
node src/cli.ts tweaks
node src/cli.ts apply vitesse-numerique km --dry-run        # montre les octets
node src/cli.ts apply vitesse-numerique km --allow-unverified --reset

# même chose à travers un ELM327 émulé (teste aussi le pilote d'adaptateur)
node src/cli.ts scan --transport sim-elm

# vrai matériel
node src/cli.ts info --transport wifi --host 192.168.0.10 --port 35000
node src/cli.ts info --transport enet --host 169.254.1.1    # câble ENET F-series
node src/cli.ts info --transport doip --host 169.254.1.1    # G-series
```

## Architecture

```
Transport        octets bruts          BLE (app) · TCP/Wi-Fi · ENET · mock
   ↓
Adaptateur       trames / messages     Elm327Adapter (AT, en-têtes, filtres) · EnetAdapter (DoIP)
   ↓
ISO-TP           segmentation          IsoTpChannel (+ adressage étendu BMW 0x6F1/0x6xx)
   ↓
UDS              diagnostic            UdsClient (sessions, DID, 0x27, transferts, NRC)
   ↓
Codage           bits → ECU            CodingSession (sauvegarde → écriture → relecture → rollback)
   ↓
Catalogue        réglages lisibles     TweakCatalog + stageTweak (garde-fous)
```

Chaque niveau ne connaît que l'interface du niveau inférieur, d'où deux propriétés
utiles : l'app mobile et le CLI partagent **exactement** le même cœur, et le
simulateur se substitue à n'importe quel niveau.

```
src/
  transport/   Transport, CanLink, MessageLink, TCP, mock
  adapter/     elm327.ts (ELM327/STN), enet.ts (ENET BMW + DoIP ISO 13400)
  isotp/       isotp.ts (canal complet + réassembleur seul)
  uds/         uds.ts, nrc.ts (codes de réponse négative en français)
  vehicle/     addressing.ts (0x6F1), modules.ts, chassis.ts (VIN), scan.ts
  coding/      model.ts (champs de bits), engine.ts (session), backup.ts
  catalog/     schema.ts (validation), tweaks.ts (démo), apply.ts
  sim/         virtual-bus, virtual-ecu (serveur UDS), virtual-elm327, vehicle
  connection.ts, cli.ts
app/           React Native : BLE, écrans, stockage des sauvegardes
test/          49 tests (node --test, sans dépendance)
```

### Adressage BMW, le point qui bloque la plupart des dongles

BMW n'utilise pas les identifiants OBD standard pour le diagnostic constructeur :

```
testeur → ECU : identifiant CAN 0x6F1, 1er octet = adresse de l'ECU
ECU → testeur : identifiant CAN 0x600 + adresse ECU, 1er octet = 0xF1
```

C'est de l'ISO-TP en adressage étendu. Un adaptateur qui ne sait pas changer
l'en-tête CAN (`ATSH`) ni poser un filtre (`ATCRA`) ne peut rien coder : il ne
parle qu'OBD générique. `Elm327Adapter.probe()` teste ces capacités et le dit,
plutôt que d'échouer plus tard sans explication.

Deux répartitions de l'ISO-TP sont supportées : `isoTpMode: "app"` (défaut, nous
segmentons sur des trames brutes — mode testé de bout en bout) et
`"adapter"` (l'ELM327 segmente via `ATCAF1`+`ATCEA`, plus rapide mais tous les
dongles n'en sont pas capables — détecté et signalé).

## Sécurité du codage

Le moteur refuse d'écrire plutôt que de risquer un calculateur :

1. **Sauvegarde d'abord.** Les octets d'origine sont enregistrés (CRC-32) avant
   la moindre écriture ; sans sauvegarde, pas d'écriture.
2. **Simulation.** `--dry-run` affiche les octets exacts qui changeraient.
3. **Diff plafonné.** Au-delà de 32 octets modifiés dans un conteneur, refus :
   un offset faux produit presque toujours un diff anormalement large.
4. **Vérification par relecture.** Après écriture, le conteneur est relu ; en cas
   d'écart, retour arrière automatique et erreur explicite.
5. **Restauration protégée.** Une sauvegarde d'un autre VIN ou d'un autre
   calculateur est refusée.
6. **Réglages gradués.** `verified: false` et `risque: eleve` exigent chacun une
   autorisation explicite.

Ce que le code ne peut pas garantir : un calculateur réel peut refuser une
écriture en cours de route, ou se comporter autrement que le simulateur. Codez
contact mis et **batterie sous chargeur**, jamais moteur tournant, jamais en
roulant.

## Obtenir de vrais offsets

Trois voies, de la plus propre à la plus artisanale :

1. **Description du calculateur** (CAFD/FDL de vos PSdZData) : la source de
   vérité, elle donne nom de fonction, octet, masque et valeurs possibles.
2. **Diff avant/après** : lisez le bloc de codage (`node src/cli.ts did` ou
   `uploadBlock`), modifiez le réglage avec un outil de référence, relisez,
   comparez. Les octets qui bougent sont vos offsets.
3. **Sources communautaires** : à recouper systématiquement, les offsets changent
   avec la version logicielle du module.

Dans tous les cas : `--dry-run`, puis écriture, puis `verified: true` dans votre
catalogue une fois le comportement constaté sur le véhicule.

## App mobile

```bash
cd app
npm install
npx expo prebuild          # le BLE exige du code natif : pas d'Expo Go
npx expo run:android       # ou run:ios
```

Le cœur est consommé via l'alias Metro `@core` (voir `app/metro.config.js`), sans
duplication de code. Écrans : recherche et connexion de l'adaptateur, fiche
véhicule et calculateurs, liste de réglages avec aperçu du diff avant écriture,
sauvegardes avec restauration.

**Honnêteté sur cette partie** : ce code n'a jamais été exécuté — ni appareil, ni
émulateur, ni dépendances installées dans l'environnement où il a été écrit. Le
premier `expo run` demandera probablement des ajustements (versions Expo/RN, et
la résolution des imports `.ts` du cœur par Metro). Le cœur, lui, est couvert par
les 49 tests.

## Légal

Coder un véhicule modifie le comportement d'un bien soumis à homologation.
Selon le pays et le réglage : perte de conformité au contrôle technique,
annulation de garantie, trace dans la mémoire du calculateur, et responsabilité
en cas d'accident. Les réglages qui touchent à la sécurité (rappel de ceinture,
airbags, éclairage réglementaire) sont marqués `risque: eleve` pour cette raison.
À n'utiliser que sur un véhicule dont vous êtes propriétaire.

## Pistes suivantes

- lecture des DTC avec libellés BMW (table à constituer)
- fonctions de service (purge de frein, réinitialisation d'entretien) → c'est le
  périmètre d'un BimmerLink, pas d'un BimmerCode
- import automatique d'un catalogue depuis un fichier de description CAFD fourni
  par l'utilisateur
- sauvegarde/restauration du bloc de codage complet d'un calculateur (FA/VO)
