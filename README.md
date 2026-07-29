# ⚡ SolaX Dashboard 

Dashboard temps réel et outil d'analyse physique avancée pour le monitoring de votre parc solaire SolaX. Interface premium **Pure Black / Néon Rouge** avec historique haute fréquence (15s), simulateur de batterie 100 % physique, support des compteurs intelligents SolaX (Smart Meter) et flux de données asynchrone ultra-rapide.

---

## Architecture Modulaire

```
SolaX Dashboard/
├── server.js              ← Point d'entrée : Express, polling dynamique, routes API, démarrage
│
├── lib/
│   ├── config.js          ← Configuration centralisée (Env, Chemins, Coordonnées)
│   ├── database.js        ← Moteur SQLite (WAL) : Intégration trapézoïdale, bilans, simulation batterie, auto-réparation
│   ├── storage.js         ← Moteur de persistance atomique (caches JSON)
│   ├── history.js         ← Gestionnaire d'historique (RAM 7 jours + synchro SQLite)
│   ├── solax.js           ← Moteur SolaX : OAuth2, Inverters, Meter, SunCalc, Reset minuit
│   ├── weather.js         ← Prévisions solaires Open-Meteo + polling horaire
│   └── sse.js             ← Communication temps réel (Push Server-Sent Events)
│
└── public/
    ├── index.html         ← Interface PWA Temps Réel (Mobile/Desktop)
    ├── stats.html         ← Interface de Statistiques & Simulateur de Batterie Physique
    ├── app.js             ← Moteur Frontend Temps Réel (SSE, Tweening, Graphiques)
    ├── stats.js           ← Moteur Frontend Statistiques & Simulation Batterie (Chart.js, localStorage)
    ├── style.css          ← Thème "Pure Black & Néon Rouge" adaptatif (Mobile/Desktop)
    ├── sw.js              ← Service Worker (Stratégie Offline PWA)
    └── manifest.json      ← Manifest de l'application
```

---

## Fonctionnalités Avancées

- 🚀 **OAuth2 SolaX V2** — Authentification automatique par Client Credentials, renouvellement transparent, gestion des expirations.
- 📡 **Temps Réel Absolu (SSE)** — Flux push serveur via Server-Sent Events pour une réactivité instantanée.
- ☀️ **Intelligence Solaire (SunCalc)** — Calcul dynamique des heures de lever/coucher du soleil locales pour :
    - **Polling Dynamique** : Pulse toutes les **15s** le jour et **60s** la nuit.
    - **Veille Inverters** : Arrêt automatique des requêtes API onduleurs la nuit pour économiser les quotas.
- 🌙 **Mode Nuit Intelligent** : Masquage automatique des indicateurs solaires inutiles la nuit et icône lunaire **🌙**.
- 🕛 **Reset à Minuit & Bilans (Daily Summaries)** : Remise à zéro automatique et bilan quotidien scellé en base.
- 🔋 **Simulateur de Batterie Physique** : Analyse de dimensionnement basée sur les flux d'énergie réels (sans biais financier).
- 🛡️ **Auto-Réparation des Données ("OVNI")** : Détection au démarrage (`repairCorruptSummaries()`) et correction des sauts de compteurs corrompus (`export > yield`).
- 💾 **Base de Données SQLite (WAL)** : Historisation **sans limite de temps** et très performante pour les données brutes et les bilans.

---

## 🔋 Simulateur de Batterie Physique

Le simulateur répond à la question physique essentielle : *"Quelle capacité de batterie faut-il pour stocker le surplus solaire réellement utile de cette installation ?"*

### ⚙️ Principe de Simulation :
- **Intégration Trapézoïdale Continuée** : Calcul seconde par seconde en Node.js de la charge et décharge batterie sur l'ensemble de la période sélectionnée (7j, 30j, 90j, 1 an+).
- **Stabilisation Warm-Up (2 Passes)** : La simulation effectue une première passe complète à vide pour déterminer l'état de charge d'équilibre (SOC) initial du Jour 1, avant d'effectuer la mesure réelle.
- **🔋 Batterie Recommandée (Vert)** : Plus petite capacité $C$ capturant au moins **82 % du surplus solaire utile** absorbable.
- **⚠️ Limite Utile (Ambre)** : Point de saturation physique où l'ajout d'un 1 kWh de batterie apporte un gain marginal quotidien inférieur à **0,15 kWh/jour/kWh** (rendement marginal quasi-nul).

### 📊 Métriques Mesurées :
- **Auto-consommation (%) & Indépendance (%)**
- **Surplus Capturé (%)** : Part du surplus solaire injecté qui est absorbée par la batterie.
- **Remplissage Moyen (%)** : Niveau de charge maximal moyen atteint chaque jour.
- **Énergie Cyclée (kWh) & Cycles par jour**
- **Économie Estimée (€)** : Calcul basé sur les tarifs d'électricité personnalisables ($(\text{Prix Achat} - \text{Prix Revente}) \times \text{kWh déchargés}$) avec **sauvegarde automatique dans `localStorage`**.

---

## Outils d'Administration (CLI)

Des scripts utilitaires sont inclus pour la maintenance de la base SQLite :

- **Importer de vieilles archives JSON :**
  ```bash
  npm run import-history -- data/old-history.json
  # Ou pour un dossier complet : node tools/import-history.js data/backups/
  ```

- **Réparer / Recalculer les bilans journaliers :**
  ```bash
  node tools/fix-summaries.js
  ```
  Scanne la base SQLite, intègre les courbes de puissance et recalcule les bilans journaliers.

---

## Installation & Configuration

### 1. Installer les dépendances
```bash
npm install
```

### 2. Configurer l'environnement (`.env`)
```env
# Authentification SolaX OpenAPI V2 (OAuth2)
SOLAX_CLIENT_ID=votre_id_client
SOLAX_CLIENT_SECRET=votre_secret_client

# Numéros de série
SOLAX_SNS=SN_onduleur1,SN_onduleur2
SOLAX_METER_SN=SN_compteur_intelligent

# Localisation (SunCalc & Météo)
WEATHER_LAT=48.0996
WEATHER_LON=7.3040

# Puissance crête (Watts)
SOLAR_PEAK_W=9000
```

### 3. Lancer le serveur
```bash
npm start
```
Accédez au Dashboard sur `http://localhost:3000` et à la page de statistiques / simulateur sur `http://localhost:3000/stats`.

---

## Endpoints API & Routes

| Route | Rôle |
|-------|------|
| `GET  /api/events` | ⚡ **SSE** — Flux push temps réel (PV, historique, météo, soleil) |
| `GET  /api/db/stats` | 📊 Statistiques consolidées sur une plage de dates |
| `GET  /api/db/battery-sim` | 🔋 Simulation physique batterie côté serveur (`from`, `to`, `voltage`, `dod`, `efficiency`, `priceImport`, `priceSurplus`) |
| `GET  /api/logs` | 📜 Interface de logs serveur en direct |
| `GET  /api/status` | Health check — Statut, uptime, clients SSE, état onduleurs |
| `POST /api/mgmt/force-refresh` | Déclenche un rafraîchissement immédiat de l'API SolaX |

---

## Données & Sécurité

Les écritures passent par un **buffer atomique** garantissant l'intégrité des données SQLite et JSON même en cas de coupure brutale.