require("dotenv").config();

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const express = require("express");
const axios = require("axios");
const compression = require("compression");

/* --------------------------------------------------------------------------
   Chemins fichiers de persistance
   -------------------------------------------------------------------------- */
const CACHE_FILE = path.join(__dirname, "data", "solax-cache.json");
const HISTORY_FILE = path.join(__dirname, "data", "solax-history.json");
const HISTORY_RETENTION_DAYS = 7;

/* --------------------------------------------------------------------------
   Configuration : token Solax + liste onduleurs
   -------------------------------------------------------------------------- */
const TOKEN = process.env.SOLAX_TOKEN;
if (!TOKEN) {
  console.error("SOLAX_TOKEN manquant : définissez-le dans .env ou l'environnement.");
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Configuration Plage Horaire API (Heure de Paris)
   03:00 à 23:00 pour éviter d'atteindre la limite journalière (10000 calls).
   -------------------------------------------------------------------------- */
const API_START_HOUR = 3;
const API_START_MINUTE = 0;
const API_END_HOUR = 23;
const API_END_MINUTE = 0;

function isWithinTimeWindow() {
  const now = new Date();
  // Formatter pour obtenir l'heure précise à Paris, peu importe l'heure du serveur
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
  
  const currentMinutes = hour * 60 + minute;
  const startMinutes = API_START_HOUR * 60 + API_START_MINUTE;
  const endMinutes = API_END_HOUR * 60 + API_END_MINUTE;
  
  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

const SOLAX_SNS_ENV = process.env.SOLAX_SNS;
if (!SOLAX_SNS_ENV) {
  console.error("SOLAX_SNS manquant : définissez-le dans .env ou l'environnement avec une liste d'onduleurs.");
  process.exit(1);
}
const wifiSns = SOLAX_SNS_ENV.split(",").map((s) => s.trim());

const isProd = process.env.NODE_ENV === "production";
const startTime = Date.now();

/* --------------------------------------------------------------------------
   Express
   -------------------------------------------------------------------------- */
const app = express();
app.use(compression());

const staticMaxAge = isProd ? 86_400_000 : 0;
app.use(express.static("public", { maxAge: staticMaxAge }));

/* --------------------------------------------------------------------------
   Cache en RAM  (données instantanées par onduleur)
   -------------------------------------------------------------------------- */
const cache = {};
let cacheSaveTimer = null;

function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const sn of wifiSns) {
      const entry = parsed[sn];
      if (entry && entry.data && entry.timestamp) {
        cache[sn] = entry;
      }
    }
  } catch { }
}

function saveCacheToDiskSync() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf8");
  } catch { }
}

function scheduleSaveCache() {
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(saveCacheToDiskSync, 500);
}

/* --------------------------------------------------------------------------
   Historique en RAM  (courbe de puissance par jour)
   -------------------------------------------------------------------------- */
let history = { version: 2, days: {} };
let historySaveTimer = null;

function loadHistoryFromDisk() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      history = parsed;
      if (!history.days) history.days = {};
    }
  } catch { }
}

/** Sauvegarde asynchrone (non-bloquante) avec debounce */
function scheduleHistorySave() {
  if (historySaveTimer) clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(async () => {
    try {
      await fsp.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
      await fsp.writeFile(HISTORY_FILE, JSON.stringify(history), "utf8");
    } catch { }
  }, 500);
}

function getLocalDayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function pruneHistoryDays() {
  const keys = Object.keys(history.days).sort();
  if (keys.length > HISTORY_RETENTION_DAYS) {
    const keysToRemove = keys.slice(0, keys.length - HISTORY_RETENTION_DAYS);
    for (const k of keysToRemove) {
      delete history.days[k];
    }
  }
}

function recordHistoryPoint(forcedValue = null) {
  let totalPower = 0;
  const now = Date.now();

  if (forcedValue !== null) {
    totalPower = forcedValue;
  } else {
    for (const sn of wifiSns) {
      const entry = cache[sn];
      if (entry && entry.data && entry.data.acpower) {
        if (now - entry.timestamp < 5 * 60 * 1000) {
          totalPower += Math.max(0, parseFloat(entry.data.acpower) || 0);
        }
      }
    }
  }

  const todayKey = getLocalDayKey();
  if (!history.days[todayKey]) history.days[todayKey] = [];
  history.days[todayKey].push([now, Math.round(totalPower * 100) / 100]);
  pruneHistoryDays();
  scheduleHistorySave();
}

/* --------------------------------------------------------------------------
   Fetch API Solax
   -------------------------------------------------------------------------- */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchFromSolax(sn) {
  try {
    const response = await axios.post(
      "https://global.solaxcloud.com/api/v2/dataAccess/realtimeInfo/get",
      { wifiSn: sn },
      {
        headers: {
          tokenId: TOKEN,
          "Content-Type": "application/json"
        },
        timeout: 8000
      }
    );

    if (response.data && response.data.success) {
      const data = response.data.result;
      cache[sn] = {
        data,
        timestamp: Date.now()
      };
      scheduleSaveCache();
      return true;
    }
  } catch (error) {
    console.error(`Erreur fetch API Solax (${sn}):`, error.message);
  }
  return false;
}

/** Exécute un scan complet de tous les onduleurs en parallèle (si dans la plage horaire) */
async function fetchAllInverters() {
  const inWindow = isWithinTimeWindow();

  if (inWindow) {
    // Lancer tous les fetch en même temps
    await Promise.all(wifiSns.map(sn => fetchFromSolax(sn)));
    // Enregistrer le point d'historique réel
    recordHistoryPoint();
  } else {
    // Mode nuit / sleep pour économiser les calls
    const parisTime = new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });
    console.log(`[${parisTime}] 🌙 Hors plage API (${API_START_HOUR}h-${API_END_HOUR}h) : Skip fetch & enregistrement point 0W.`);
    recordHistoryPoint(0);
  }
  
  // Push global vers tous les clients
  pushDataToClients();
}

/* --------------------------------------------------------------------------
   Server-Sent Events (SSE) — Push temps réel vers les navigateurs
   -------------------------------------------------------------------------- */
const sseClients = new Set();

function broadcastSSE(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(message);
    if (res.flush) res.flush(); // Indispensable pour passer à travers le middleware 'compression'
  }
}

/** Construit le payload PV à partir du cache */
function buildPvPayload() {
  return wifiSns.map((sn) => {
    if (cache[sn]) {
      return {
        ...cache[sn].data,
        _sn: sn,
        _fromCache: true,
        _cacheTimestamp: cache[sn].timestamp
      };
    }
    return {
      _sn: sn,
      _error: true,
      _errorMessage: "En attente du 1er background fetch..."
    };
  });
}

/** Pousse toutes les données aux clients SSE */
function pushDataToClients() {
  broadcastSSE("pv", buildPvPayload());
  broadcastSSE("history", history);
}

/* --------------------------------------------------------------------------
   Daemon de fond — Synchro minute pile + SSE push
   -------------------------------------------------------------------------- */
async function startBackgroundPolling() {
  console.log("⚡ Fetch initial immédiat...");
  await fetchAllInverters();
  console.log(`✅ Fetch initial terminé — ${wifiSns.length} onduleurs`);

  console.log("🔁 Démarrage du Polling (toutes les 60s)...");
  while (true) {
    await sleep(60000); // Attendre précisément 60 secondes
    const t0 = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] Scan ${wifiSns.length} onduleurs...`);
    await fetchAllInverters();
    console.log(`[${new Date().toLocaleTimeString()}] ✅ Scan terminé en ${Date.now() - t0}ms — ${sseClients.size} client(s) SSE`);
  }
}

/* --------------------------------------------------------------------------
   Endpoints API
   -------------------------------------------------------------------------- */

// SSE : le client ouvre une seule connexion, le serveur pousse tout
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"     // Nginx proxy support
  });
  res.flushHeaders();

  // Envoyer les données actuelles immédiatement
  res.write(`event: pv\ndata: ${JSON.stringify(buildPvPayload())}\n\n`);
  res.write(`event: history\ndata: ${JSON.stringify(history)}\n\n`);
  if (res.flush) res.flush();

  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
});

// Fallback REST classique (pour debug / outils tiers)
app.get("/api/pv", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.json(buildPvPayload());
});

app.get("/api/history", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.json(history);
});

// Health check
app.get("/api/status", (req, res) => {
  const now = Date.now();
  const inverters = wifiSns.map((sn) => {
    const entry = cache[sn];
    return {
      sn,
      hasData: !!entry,
      lastFetchAgeMs: entry ? now - entry.timestamp : null,
      status: entry?.data?.inverterStatus ?? null
    };
  });
  res.json({
    ok: true,
    uptime: Math.floor((now - startTime) / 1000),
    inverterCount: wifiSns.length,
    sseClients: sseClients.size,
    historyDays: Object.keys(history.days).length,
    inverters
  });
});

/* --------------------------------------------------------------------------
   Démarrage
   -------------------------------------------------------------------------- */
loadCacheFromDisk();
loadHistoryFromDisk();
startBackgroundPolling();

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Serveur prêt sur http://localhost:${PORT}`);
});

function shutdown() {
  console.log("🛑 Arrêt propre...");
  saveCacheToDiskSync();
  // Sauvegarde synchrone finale de l'historique (garantie d'écriture)
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), "utf8");
  } catch { }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);