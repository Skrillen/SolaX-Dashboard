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
const FORECAST_FILE = path.join(__dirname, "data", "forecast-cache.json");
const HISTORY_RETENTION_DAYS = 7;

/* --------------------------------------------------------------------------
   Configuration : token Solax + liste onduleurs
   -------------------------------------------------------------------------- */
const CLIENT_ID = process.env.SOLAX_CLIENT_ID;
const CLIENT_SECRET = process.env.SOLAX_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("SOLAX_CLIENT_ID ou SOLAX_CLIENT_SECRET manquant : définissez-les dans .env ou l'environnement.");
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Configuration Plage Horaire API (Heure de Paris)
   05:00 à 22:00 pour éviter d'atteindre la limite journalière (10000 calls).
   -------------------------------------------------------------------------- */
const API_START_HOUR = 5;
const API_START_MINUTE = 0;
const API_END_HOUR = 22;
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
const METER_SN = process.env.SOLAX_METER_SN || null;

const isProd = process.env.NODE_ENV === "production";
const startTime = Date.now();

/* --------------------------------------------------------------------------
   Configuration Météo (Open-Meteo API gratuite)
   -------------------------------------------------------------------------- */
const WEATHER_LAT = parseFloat(process.env.WEATHER_LAT) || 48.8566;
const WEATHER_LON = parseFloat(process.env.WEATHER_LON) || 2.3522;

let forecastCache = {
  lastUpdate: null,
  hourly: [],
  daily: { predictedYield24h: 0, updatedAt: null }
};

function loadForecastFromDisk() {
  try {
    if (!fs.existsSync(FORECAST_FILE)) return;
    const raw = fs.readFileSync(FORECAST_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      forecastCache = parsed;
    }
  } catch { }
}

function saveForecastToDiskSync() {
  try {
    fs.mkdirSync(path.dirname(FORECAST_FILE), { recursive: true });
    fs.writeFileSync(FORECAST_FILE, JSON.stringify(forecastCache), "utf8");
  } catch { }
}

async function fetchWeatherForecast() {
  const PEAK_W       = parseFloat(process.env.SOLAR_PEAK_W) || 9000;
  const PERF_RATIO   = 0.85; // Pertes typiques (chaleur, onduleur, câbles)
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&hourly=cloud_cover,shortwave_radiation,direct_radiation,diffuse_radiation&daily=sunrise,sunset&timezone=Europe%2FParis&forecast_days=2`;

  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    if (!data?.hourly) return false;

    const h = data.hourly;
    const now = Date.now();
    const hourlyForecast = h.time.map((t, i) => ({
      time:              new Date(t).getTime(),
      cloudCover:        h.cloud_cover[i]          ?? 0,
      shortwaveRadiation:h.shortwave_radiation[i]  ?? 0,
      predictedPower:    Math.max(0, Math.round(((h.shortwave_radiation[i] ?? 0) / 1000) * PEAK_W * PERF_RATIO))
    }));

    const next24h = hourlyForecast.filter(p => p.time >= now && p.time <= now + 86_400_000);
    const predictedYield24h = Math.round(next24h.reduce((s, p) => s + p.predictedPower / 1000, 0) * 100) / 100;

    forecastCache = { lastUpdate: now, hourly: hourlyForecast, daily: { predictedYield24h, updatedAt: now } };
    saveForecastToDiskSync();
    console.log(`[Weather] ✅ Forecast mis à jour — ${next24h.length}h prévues, ~${predictedYield24h} kWh/24h`);
    broadcastSSE("forecast", forecastCache);
    return true;
  } catch (err) {
    console.error(`[Weather] Erreur fetch:`, err.message);
    return false;
  }
}

function startWeatherPolling() {
  console.log(`[Weather] Polling météo démarré (${WEATHER_LAT}, ${WEATHER_LON})`);
  fetchWeatherForecast();
  setInterval(fetchWeatherForecast, 60 * 60 * 1000);
}

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
    for (const sn of [...wifiSns, 'meter']) {
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
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
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
  const now = Date.now();
  let totalPower = 0;

  if (forcedValue !== null) {
    totalPower = forcedValue;
  } else {
    for (const sn of wifiSns) {
      const entry = cache[sn];
      if (entry?.data?.acpower && now - entry.timestamp < 5 * 60_000) {
        totalPower += Math.max(0, parseFloat(entry.data.acpower) || 0);
      }
    }
  }

  let gridPower = 0;
  const meterEntry = cache['meter'];
  if (meterEntry?.data && now - meterEntry.timestamp < 5 * 60_000) {
    gridPower = meterEntry.data.totalActivePower || 0;
  }
  const housePower = Math.max(0, totalPower - gridPower);

  const todayKey = getLocalDayKey();
  if (!history.days[todayKey]) history.days[todayKey] = [];
  history.days[todayKey].push([
    now,
    Math.round(totalPower * 100) / 100,
    Math.round(housePower * 100) / 100,
    Math.round(gridPower  * 100) / 100
  ]);
  pruneHistoryDays();
  scheduleHistorySave();
}

/* --------------------------------------------------------------------------
   Fetch API Solax - OAuth2
   -------------------------------------------------------------------------- */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let currentAccessToken = null;
let tokenExpiresAt = 0;

async function getValidAccessToken() {
  const now = Date.now();
  // Renouveler le token s'il expire dans moins de 5 minutes (300000ms) ou s'il n'existe pas
  if (currentAccessToken && tokenExpiresAt > now + 300000) {
    return currentAccessToken;
  }

  try {
    const authRes = await axios.post(
      'https://openapi-eu.solaxcloud.com/openapi/auth/oauth/token',
      'grant_type=client_credentials&client_id=' + CLIENT_ID + '&client_secret=' + CLIENT_SECRET,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000
      }
    );

    if (authRes.data && authRes.data.result && authRes.data.result.access_token) {
      currentAccessToken = authRes.data.result.access_token;
      const expiresIn = authRes.data.result.expires_in || 3600;
      tokenExpiresAt = now + (expiresIn * 1000);
      console.log(`[OAuth2] Nouveau token obtenu (expire dans ${expiresIn}s)`);
      return currentAccessToken;
    }
    throw new Error('Format de réponse Auth invalide');
  } catch (error) {
    console.error(`[OAuth2] Erreur d'authentification:`, error.message);
    return null;
  }
}

async function fetchFromSolaxBatch() {
  const token = await getValidAccessToken();
  if (!token) return false;

  try {
    const snsList = wifiSns.join(',');
    const url = `https://openapi-eu.solaxcloud.com/openapi/v2/device/realtime_data?snList=${snsList}&deviceType=1&businessType=1`;
    
    const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 10000
    });

    if (response.data && response.data.code === 10000 && Array.isArray(response.data.result)) {
      const now = Date.now();
      for (const item of response.data.result) {
        const sn = item.deviceSn;
        // Mapping API V2 (openapi) vers l'ancienne structure Legacy
        // Basé sur la documentation officielle :
        const mappedData = {
          acpower: item.acPower1 !== null ? item.acPower1 : 0, // AC power 1 (Puissance onduleur)
          yieldtoday: item.dailyYield || 0,                    // Daily PV yield
          yieldtotal: item.totalYield || 0,                    // Total PV yield
          inverterStatus: item.deviceStatus,                   // Device status
          uploadTime: item.dataTime,                           // Data reporting time
          feedinpower: item.gridPower !== null ? item.gridPower : 0 // Meter 1 grid port power
        };

        if (wifiSns.includes(sn)) {
          cache[sn] = {
            data: mappedData,
            timestamp: now
          };
        }
      }
      scheduleSaveCache();
      return true;
    } else if (response.data && response.data.code === 10014) {
      // 10014: invalid token, force refresh
      tokenExpiresAt = 0;
    } else {
      console.error(`[API] Réponse inattendue:`, response.data);
    }
  } catch (error) {
    console.error(`[API] Erreur fetch Batch API Solax:`, error.message);
    if (error.response && error.response.status === 401) {
       tokenExpiresAt = 0; // force refresh si 401
    }
  }
  return false;
}

async function fetchMeterBatch() {
  if (!METER_SN) return false;
  const token = await getValidAccessToken();
  if (!token) return false;

  try {
    const url = `https://openapi-eu.solaxcloud.com/openapi/v2/device/realtime_data?snList=${METER_SN}&deviceType=3&businessType=1`;
    const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 10000
    });

    if (response.data && response.data.code === 10000 && Array.isArray(response.data.result)) {
      const now = Date.now();
      for (const item of response.data.result) {
        if (item.deviceSn === METER_SN) {
          cache['meter'] = {
            data: {
              importEnergy: item.importEnergy || 0,
              exportEnergy: item.exportEnergy || 0,
              totalActivePower: item.totalActivePower || 0
            },
            timestamp: now
          };
        }
      }
      scheduleSaveCache();
      return true;
    }
  } catch (error) {
    console.error(`[API] Erreur fetch Batch API Meter:`, error.message);
  }
  return false;
}

/** Exécute un scan complet de tous les onduleurs en parallèle (si dans la plage horaire) */
async function fetchAllInverters() {
  const inWindow = isWithinTimeWindow();

  if (inWindow) {
    // Appels pour Inverters et Meter
    await Promise.all([fetchFromSolaxBatch(), fetchMeterBatch()]);
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
  const isPaused = !isWithinTimeWindow();
  const list = wifiSns.map((sn) => {
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

  return {
    inverters: list,
    meter: cache['meter'] ? cache['meter'].data : null,
    _isPaused: isPaused
  };
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

let lastForceRefresh = 0;
const REFRESH_COOLDOWN = 60000;

app.post("/api/mgmt/force-refresh", async (req, res) => {
  const now = Date.now();
  if (now - lastForceRefresh < REFRESH_COOLDOWN) {
    const remains = Math.ceil((REFRESH_COOLDOWN - (now - lastForceRefresh)) / 1000);
    return res.status(429).json({ error: `Cooldown actif. Réessayez dans ${remains}s.` });
  }

  console.log("🛠️ Force Refresh demandé via secret gesture...");
  lastForceRefresh = now;

  // Exécuter le fetch immédiatement
  fetchAllInverters().catch(() => { });

  res.json({ ok: true, message: "Rafraîchissement forcé lancé." });
});

app.get("/api/forecast", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.json(forecastCache);
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
loadForecastFromDisk();
startBackgroundPolling();
startWeatherPolling();

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
