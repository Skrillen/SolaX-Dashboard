# ⚡ SolaX Dashboard

Dashboard temps réel pour monitoring de parc solaire SolaX. Interface premium "Black & Red" avec graphique historique et données en streaming SSE.

## Architecture

```
server.js          ← Backend Node.js (Express)
                     - Polling parallèle (toutes les 60s)
                     - Fetch multiple SN simultané (Promise.all)
                     - Low-latency SSE (res.flush)
                     - Cache RAM + persistance disque
                     - Historique 7 jours (JSON)

public/
  index.html       ← Page unique (PWA)
  app.js           ← Frontend (SSE + Chart.js date-fns)
  style.css        ← Thème Black & Red + Animations
  sw.js            ← Service Worker (Network First + SSE Bypass)
  manifest.json    ← PWA manifest
  icon.svg         ← Icône

data/
  solax-cache.json   ← Cache instantané (auto-généré)
  solax-history.json ← Historique courbe (auto-généré)
```

## Installation

```bash
npm install
```

## Configuration

Créer un fichier `.env` à la racine :

```env
SOLAX_TOKEN=votre_token_api
SOLAX_SNS=SN1,SN2,SN3,...
PORT=3000                    # optionnel (défaut: 3000)
NODE_ENV=production          # optionnel (active le cache statique)
```

- **`SOLAX_TOKEN`** : Token d'authentification API SolaX Cloud (obtenu sur le portail SolaX)
- **`SOLAX_SNS`** : Liste des numéros de série WiFi des onduleurs, séparés par des virgules

## Démarrage

```bash
node server.js
# ou
npm start
```

Le dashboard sera accessible sur `http://localhost:3000`.

## Endpoints API

| Route | Description |
|-------|-------------|
| `GET /api/events` | **SSE** — Flux temps réel (émet `pv` et `history` instantanément après chaque scan) |
| `GET /api/pv` | REST — Données instantanées de tous les onduleurs (Fallback polling) |
| `GET /api/history` | REST — Historique de puissance (7 derniers jours) |
| `GET /api/status` | Health check — Uptime, état des onduleurs, clients SSE connectés |

## Fonctionnalités Clés

- 🚀 **Performance Parallèle** — Scan de tous les onduleurs en simultané (`Promise.all`), réduisant le temps de cycle à ~1s.
- 📡 **SSE Low-Latency** — Streaming des données poussé instantanément au navigateur via `res.flush()`.
- 📊 **Graphique 24h/7j** — Visualisation historique sur 24h glissantes avec format 24h (HH:mm).
- 🔄 **Auto-Synchronisation** — Système de polling 60s robuste avec fallback REST automatique toutes les 10s.
- 🎨 **Interface Premium** — Design "Pure Black & Red", indicateur de synchronisation avec point battant (pulse), animations fluides.
- 💾 **Persistance** — Sauvegarde automatique du cache et de l'historique sur disque.
- 📱 **PWA Ready** — Installable sur mobile, stratégie "Network First" pour garantir la fraîcheur des données.

## Stack technique

- **Backend** : Node.js, Express, Axios , Compression
- **Frontend** : Vanilla JS, Chart.js (Time Adapter), CSS Grid/Flexbox
- **Communication** : Server-Sent Events (SSE) avec bypass Service Worker