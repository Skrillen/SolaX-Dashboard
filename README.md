# ⚡ SolaX Dashboard

Dashboard temps réel pour le monitoring de votre parc solaire SolaX. Interface premium **Black & Red** avec graphique d'historique avancé, support des compteurs intelligents SolaX (Smart Meter) et flux de données asynchrone ultra-rapide.

---

## Architecture

```
SolaX Dashboard/
├── server.js              ← Point d'entrée : Express, routes API, démarrage
│
├── lib/
│   ├── config.js          ← Variables d'environnement & chemins de fichiers
│   ├── storage.js         ← Écritures atomiques (protection contre les crashs)
│   ├── history.js         ← Historique RAM 7 jours + persistance disque
│   ├── solax.js           ← OAuth2, fetch API SolaX V2, cache onduleurs
│   ├── weather.js         ← Prévisions Open-Meteo + polling horaire
│   └── sse.js             ← Clients SSE, broadcast, construction payload PV
│
└── public/
    ├── index.html         ← Page web PWA (Design adaptatif mobile/PC)
    ├── app.js             ← Moteur Frontend (SSE + Rafraîchissement DOM + Chart.js)
    ├── style.css          ← Thème "Pure Black" & Flexbox fluide
    ├── sw.js              ← Service Worker (Stratégie Offline PWA)
    └── manifest.json      ← Manifest de l'application
```

---

## Fonctionnalités

- 🚀 **OpenAPI V2 + OAuth2** — Authentification automatique par Client Credentials, renouvellement transparent du token.
- 📡 **Temps réel absolu (SSE)** — Push serveur via Server-Sent Events, sans polling côté client.
- 🏠 **Moniteur maison intégré** — Consommation exacte calculée en temps réel (Production − Injection/Achat réseau).
- 📊 **Graphique d'historique** — Visualisation simultanée Production solaire / Consommation maison / Réseau sur 7 jours glissants.
- 🌤️ **Prévision solaire** — Estimation de production J+1 via Open-Meteo (rayonnement × puissance crête × ratio de performance).
- 💾 **Persistance fiable** — Toutes les écritures disque sont **atomiques** (fichier `.tmp` + `rename`), aucun JSON corrompu en cas de crash.
- 🔁 **Polling continu 24h/24** — Appel API toutes les 60 secondes sans fenêtre de restriction horaire.
- 📱 **PWA** — Installable comme application native sur mobile et desktop, support offline.

---

## Installation & Configuration

### 1. Installer les dépendances
```bash
npm install
```

### 2. Créer le fichier `.env`
```env
# Authentification SolaX OpenAPI V2 (OAuth2)
SOLAX_CLIENT_ID=votre_id_client
SOLAX_CLIENT_SECRET=votre_secret_client

# Numéros de série des équipements
SOLAX_SNS=SN_onduleur1,SN_onduleur2
SOLAX_METER_SN=SN_compteur_intelligent   # Optionnel

# Serveur
PORT=3000
NODE_ENV=production

# Localisation (pour les prévisions météo)
WEATHER_LAT=48.8566
WEATHER_LON=2.3522

# Puissance crête de l'installation en watts (pour estimer la production)
SOLAR_PEAK_W=9000
```

> **Migration depuis l'ancienne API** : Si vous utilisiez `SOLAX_TOKEN`, remplacez-le par une paire `CLIENT_ID` / `CLIENT_SECRET` générée dans les réglages développeurs du portail SolaX Cloud.

### 3. Démarrer
```bash
npm start
# Dashboard disponible sur http://localhost:3000
```

---

## Endpoints API

| Route | Rôle |
|-------|------|
| `GET  /api/events` | ⚡ **SSE** — Flux push temps réel (PV, historique, météo) |
| `GET  /api/pv` | REST fallback — Snapshot live complet |
| `GET  /api/history` | REST fallback — Historique des 7 derniers jours |
| `GET  /api/forecast` | REST fallback — Prévisions de production solaire |
| `GET  /api/status` | Health check — Statut des onduleurs, uptime, clients SSE |
| `POST /api/mgmt/force-refresh` | Déclenche un rafraîchissement immédiat (cooldown 60s) |

---

## Données & Persistance

Les données sont stockées localement dans `/data/` sous forme JSON :

| Fichier | Contenu | Rétention |
|---------|---------|-----------|
| `solax-cache.json` | Dernière mesure connue par onduleur | Permanent (écrasé à chaque fetch) |
| `solax-history.json` | Courbes de puissance par jour | 7 jours glissants |
| `forecast-cache.json` | Dernière prévision météo | Mis à jour toutes les heures |

Toutes les écritures passent par un **rename atomique** (`fichier.tmp` → `fichier.json`) pour garantir l'intégrité des données même en cas de coupure brutale.

> Pour une rétention longue durée, ces modules sont conçus pour être encapsulés autour d'une base de données légère (SQLite, InfluxDB, etc.).