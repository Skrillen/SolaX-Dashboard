# ⚡ SolaX Dashboard 

Dashboard temps réel pour le monitoring de votre parc solaire SolaX. Interface premium **Pure Black** avec graphique d'historique avancé, support des compteurs intelligents SolaX (Smart Meter) et flux de données asynchrone ultra-rapide.

---

## Architecture Modulaire

```
SolaX Dashboard/
├── server.js              ← Point d'entrée : Express, polling dynamique, démarrage
│
├── lib/
│   ├── config.js          ← Configuration centralisée (Env, Chemins, Coordonnées)
│   ├── storage.js         ← Moteur de persistance atomique (protection .tmp + rename)
│   ├── history.js         ← Gestionnaire d'historique (RAM 7 jours + snapshots)
│   ├── solax.js           ← Moteur SolaX : OAuth2, Inverters, Meter, SunCalc, Reset minuit
│   ├── weather.js         ← Prévisions solaires Open-Meteo + polling horaire
│   └── sse.js             ← Communication temps réel (Push Server-Sent Events)
│
└── public/
    ├── index.html         ← Interface PWA adaptative (Mobile/Desktop)
    ├── app.js             ← Moteur Frontend (SSE, Animations Tweening, Graphiques)
    ├── style.css          ← Thème "Pure Black" & Design adaptatif
    ├── sw.js              ← Service Worker (Stratégie Offline PWA)
    └── manifest.json      ← Manifest de l'application
```

---

## Fonctionnalités Avancées

- 🚀 **OAuth2 SolaX V2** — Authentification automatique par Client Credentials, renouvellement transparent, gestion des expirations imprévisibles.
- 📡 **Temps réel absolu (SSE)** — Flux push serveur via Server-Sent Events pour une réactivité instantanée.
- ☀️ **Intelligence Solaire (SunCalc)** — Le serveur calcule les heures de lever/coucher du soleil locales pour :
    - **Polling Dynamique** : Pulse toutes les **15s** le jour et **60s** la nuit.
    - **Veille Inverters** : Arrêt automatique des requêtes API onduleurs la nuit pour économiser les quotas.
- 🌙 **Mode Nuit Intelligent** : 
    - Suppression du "dimming" CSS pour un noir pur et lisible.
    - Masquage automatique des indicateurs solaires inutiles la nuit.
    - Icône lunaire **🌙** dans l'horloge.
- 🕛 **Reset à Minuit** : Remise à zéro automatique de la production du jour (`yieldtoday`) pour attaquer la journée proprement.
- 🏠 **Moniteur maison intégré** : Consommation exacte calculée en temps réel (Production − Injection/Achat réseau).
- 💾 **Persistance Robuste** : Toutes les écritures disque sont **atomiques** (fichier `.tmp` + `rename`), protégeant vos données contre toute corruption en cas de crash.
- 🛡️ **Gestion des Quotas & Erreurs** : Détection des limites API (1M/jour), des codes d'erreurs SolaX (10405, 10402, etc.) et protection anti-spam.

---

## Installation & Configuration

### 1. Installer les dépendances
```bash
npm install
npm install suncalc
```

### 2. Configurer l'environnement (`.env`)
```env
# Authentification SolaX OpenAPI V2 (OAuth2)
SOLAX_CLIENT_ID=votre_id_client
SOLAX_CLIENT_SECRET=votre_secret_client

# Numéros de série
SOLAX_SNS=SN_onduleur1,SN_onduleur2
SOLAX_METER_SN=SN_compteur_intelligent

# Localisation (Indispensable pour SunCalc & Météo)
WEATHER_LAT=48.8566
WEATHER_LON=2.3522

# Puissance crête (Watts) pour estimations
SOLAR_PEAK_W=9000
```

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
| `GET  /api/status` | Health check — Statut, uptime, clients SSE, état onduleurs |
| `POST /api/mgmt/force-refresh` | Déclenche un rafraîchissement immédiat (cooldown 60s) |

---

## Données & Sécurité

Les écritures passent par un **buffer atomique** (`fichier.tmp` → `fichier.json`) garantissant l'intégrité des fichiers JSON même en cas de coupure brutale du serveur.

| Fichier | Contenu | Comportement |
|---------|---------|-----------|
| `solax-cache.json` | Snapshot onduleurs | Mis à jour toutes les 15s le jour / 60s la nuit |
| `solax-history.json` | Courbes de puissance | Enregistrement chaque minute (Meter 24h/24) |
| `forecast-cache.json` | Météo | Mis à jour toutes les heures |