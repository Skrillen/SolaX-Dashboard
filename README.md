# ⚡ SolaX Dashboard

Dashboard temps réel pour le monitoring de votre parc solaire SolaX. Interface premium "Black & Red" avec graphique d'historique avancé, support des compteurs intelligents SolaX (Smart Meter) et flux de données asynchrone ultra-rapide.

![Vue d'ensemble du Dashboard](public/icon.svg)

## Architecture

```
server.js          ← Backend Node.js (Express)
                     - Polling intelligent (toutes les 60s en journée)
                     - Requêtes API SolaX V2 couplées (Onduleurs + Réseau/Meter)
                     - Authentification automatique OAuth2 (Client Credentials)
                     - Connexion Low-latency via Server-Sent Events (SSE)
                     - Cache RAM + Sauvegarde asynchrone sur disque
                     - Historique 7 jours (Puissance Solaire, Conso Maison, Réseau)

public/
  index.html       ← Page web PWA (Design adaptatif mobile/PC)
  app.js           ← Moteur Frontend (SSE + Rafraîchissement DOM ciblé + Chart.js)
  style.css        ← Thème "Pure Black" & Flexbox fluide
  sw.js            ← Service Worker (Stratégie Offline PWA)
  manifest.json    ← Manifest de l'application
```

## Fonctionnalités Clés

- 🚀 **Performance OpenAPI V2** — Synchronisation par lots exclusifs avec l'API OAuth2 de SolaX garantissant une empreinte réseau minimale.
- 📡 **Temps Réel Absolu (SSE)** — Les données voyagent instantanément du backend vers votre écran sans saccades (évite la surcharge typique des requêtes classiques).
- 🏠 **Moniteur Domicile Intégré** — Affiche fièrement la consommation exacte de la maison en déduisant intelligemment Injection/Achat et Production.
- 📊 **Graphique de Comparaison** — Visualisez simultanément votre génération solaire (Rouge) face à l'absorption de votre domicile (Bleu).
- 🤖 **Predictive Solar** — Interroge une API météorologique et estime votre production des prochaines heures.
- 🎨 **Smart UI** — Design premium, responsive, avec badges temps-réel animés.

---

## Installation & Configuration

### 1. Cloner et Installer
```bash
npm install
```

### 2. Paramétrer l'accès
Créez un simple fichier `.env` à la racine pour vous relier à SolaX Cloud :

```env
# Authentification SolaX OpenAPI V2
SOLAX_CLIENT_ID=votre_id_client
SOLAX_CLIENT_SECRET=votre_secret_client

# Numéros de série (SN)
SOLAX_SNS=SN_onduleur1,SN_onduleur2
SOLAX_METER_SN=SN_compteur_intelligent

# Paramètres optionnels (Port, météo, etc)
PORT=3000
NODE_ENV=production
WEATHER_LAT=48.8566
WEATHER_LON=2.3522
SOLAR_PEAK_W=9000
```

> **Attention** : L'authentification a migré vers l'API V2 SolaX (OAuth2). Si vous utilisiez `SOLAX_TOKEN`, vous devez dorénavant générer une paire `CLIENT_ID` / `CLIENT_SECRET` dans les réglages développeurs SolaX.

### 3. Allumage !
```bash
npm start
# Le dashboard s'ouvrira sur http://localhost:3000
```

---

## Endpoints API Utilisables

| Route | Rôle |
|-------|-------------|
| `GET /api/events` | ⚡ **SSE** — Le cœur battant du push de données serveur. |
| `GET /api/pv` | Secours (REST) — Statut live complet manuel. |
| `GET /api/history` | Secours (REST) — Graphique global récent. |
| `GET /api/forecast` | Secours (REST) — Projections météorologiques solaires. |
| `POST /api/mgmt/force-refresh` | Déclenche une demande manuelle de mise à jour forcée sur tous les équipements SolaX. |

## Maintenance & Évolutivité

Ce projet stocke ses données localement dans `/data` sous format `JSON` afin d'être ultra-léger et ne pas dépendre de bases de données (BDD). La taille des fichiers est auto-limitée à une rétention précise.
Si vous souhaitez conserver les métriques sur plusieurs années, ces modules devront être encapsulés autour d'une technologie telle que SQLite ou InfluxDB.