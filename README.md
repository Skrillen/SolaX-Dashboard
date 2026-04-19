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
│   ├── database.js        ← Moteur de base de données SQLite (Mode WAL)
│   ├── storage.js         ← Moteur de persistance atomique (pour les caches JSON)
│   ├── history.js         ← Gestionnaire d'historique (RAM 7 jours + synchro SQLite)
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
- 🕛 **Reset à Minuit & Bilans (Daily Summaries)** : 
    - Remise à zéro automatique de la production du jour (`yieldtoday`).
    - Enregistrement d'un **bilan définitif** à minuit dans l'historique pour garantir une cohérence parfaite des jours passés.
- 🏠 **Moniteur maison intégré** : Consommation exacte calculée en temps réel (Production − Injection/Achat réseau).
- 📊 **KPIs Énergétiques Précis** : 
    - Calcul de l'**Indépendance** et de l'**Auto-consommation** basé sur les cumuls réels (kWh) de la journée.
    - Info-bulles interactives au survol pour voir le détail des calculs (Solaire utilisé / Conso totale).
- 🌅 **Éphéméride Solaire** : Affichage dynamique des heures de lever et coucher du soleil (sans marge) à côté de l'horloge.
- 💾 **Base de Données SQLite** : Historisation **sans limite de temps** et très performante pour les données brutes et les bilans, avec un cache mémoire sur 7 jours pour un affichage instantané.
- 🛡️ **Gestion des Quotas & Erreurs** : Détection des limites API (1M/jour), des codes d'erreurs SolaX (10405, 10402, etc.) et protection anti-spam.

---

## Outils d'Administration (CLI)

Des scripts utilitaires sont inclus pour faciliter la maintenance de la base de données :

- **Importer de vieilles archives JSON :**
  ```bash
  npm run import-history -- data/old-history.json
  # Ou pour un dossier complet : node tools/import-history.js data/backups/
  ```

- **Réparer / Recalculer les bilans journaliers :**
  ```bash
  node tools/fix-summaries.js
  ```
  Ce script scanne la base SQLite, intègre les courbes de puissance minute par minute, et recalcule les bilans (utile en cas de panne ou de données corrompues le soir).

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

# Localisation (Indispensable pour SunCalc & Météo)
WEATHER_LAT=48.0996
WEATHER_LON=7.3040

# Puissance crête (Watts) pour estimations
SOLAR_PEAK_W=9000
```

---

## Endpoints API & Logs

| Route | Rôle |
|-------|------|
| `GET  /api/events` | ⚡ **SSE** — Flux push temps réel (PV, historique, météo, soleil) |
| `GET  /api/logs` | 📜 Interface de logs serveur en direct |
| `GET  /api/status` | Health check — Statut, uptime, clients SSE, état onduleurs |
| `POST /api/mgmt/force-refresh` | Déclenche un rafraîchissement immédiat (sans cooldown) |

---

## Données & Sécurité

Les écritures passent par un **buffer atomique** garantissant l'intégrité des fichiers JSON même en cas de coupure brutale.

| Fichier | Contenu | Comportement |
|---------|---------|-----------|
| `solax.db` | Base de données SQLite | Stockage illimité de l'historique (points + bilans) |
| `solax-cache.json` | Snapshot onduleurs | Mis à jour toutes les 15s le jour / 60s la nuit |
| `forecast-cache.json` | Météo | Prévisions recalées sur le fuseau local |