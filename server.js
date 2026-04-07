"use strict";

require("dotenv").config();

const express     = require("express");
const compression = require("compression");

const { isProd, startTime, wifiSns } = require("./lib/config");
const { loadCacheFromDisk, saveCacheToDiskSync, cache, fetchAllInverters, isSunActive } = require("./lib/solax");
const { loadHistoryFromDisk, history }  = require("./lib/history");
const { loadForecastFromDisk, forecastCache, startWeatherPolling } = require("./lib/weather");
const { atomicWriteSync } = require("./lib/storage");
const { HISTORY_FILE }    = require("./lib/config");
const {
  sseClients,
  broadcastSSE,
  buildPvPayload,
  pushDataToClients,
} = require("./lib/sse");

/* --------------------------------------------------------------------------
   Capture des Logs en mémoire
   -------------------------------------------------------------------------- */
const logBuffer = [];
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function addToBuffer(type, args) {
  const msg = `[${new Date().toLocaleTimeString()}] [${type}] ${args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(" ")}`;
  logBuffer.push(msg);
  if (logBuffer.length > 100) logBuffer.shift();
}

console.log = (...args) => { originalLog(...args); addToBuffer("INFO", args); };
console.warn = (...args) => { originalWarn(...args); addToBuffer("WARN", args); };
console.error = (...args) => { originalError(...args); addToBuffer("ERROR", args); };

/* --------------------------------------------------------------------------
   Express
   -------------------------------------------------------------------------- */
const app = express();
app.use(compression());
app.use(express.static("public", { maxAge: isProd ? 86_400_000 : 0 }));

/* --------------------------------------------------------------------------
   Endpoints API
   -------------------------------------------------------------------------- */

// SSE — connexion persistante, le serveur pousse les mises à jour
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type":     "text/event-stream",
    "Cache-Control":    "no-cache",
    "Connection":       "keep-alive",
    "X-Accel-Buffering":"no", // Support proxy Nginx
  });
  res.flushHeaders();

  // Envoyer l'état courant immédiatement à la connexion
  res.write(`event: pv\ndata: ${JSON.stringify(buildPvPayload())}\n\n`);
  res.write(`event: history\ndata: ${JSON.stringify(history)}\n\n`);
  if (res.flush) res.flush();

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// REST fallback (debug / outils tiers)
app.get("/api/pv", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.json(buildPvPayload());
});

app.get("/api/history", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.json(history);
});

app.get("/api/forecast", (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.json(forecastCache);
});

// Logs serveur
app.get("/api/logs", (req, res) => {
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.send(logBuffer.join("\n"));
});

app.post("/api/mgmt/force-refresh", async (req, res) => {
  console.log("🛠️ Force Refresh demandé...");
  fetchAllInverters(pushDataToClients, true).catch(() => {});
  res.json({ ok: true, message: "Rafraîchissement forcé lancé." });
});

// Health check
app.get("/api/status", (req, res) => {
  const now = Date.now();
  const inverters = wifiSns.map((sn) => {
    const entry = cache[sn];
    return {
      sn,
      hasData:        !!entry,
      lastFetchAgeMs: entry ? now - entry.timestamp : null,
      status:         entry?.data?.inverterStatus ?? null,
    };
  });
  res.json({
    ok:           true,
    uptime:       Math.floor((now - startTime) / 1000),
    inverterCount:wifiSns.length,
    sseClients:   sseClients.size,
    historyDays:  Object.keys(history.days).length,
    inverters,
  });
});

/* --------------------------------------------------------------------------
   Daemon de polling — toutes les 60 secondes, 24h/24
   -------------------------------------------------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startBackgroundPolling() {
  console.log("⚡ Fetch initial immédiat...");
  await fetchAllInverters(pushDataToClients);
  console.log(`✅ Fetch initial terminé — ${wifiSns.length} onduleurs`);

  while (true) {
    const sunUp = isSunActive();
    const delay = sunUp ? 15_000 : 60_000;
    
    await sleep(delay);

    const t0 = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] Scan ${wifiSns.length} onduleurs (Intervalle: ${delay/1000}s)...`);
    await fetchAllInverters(pushDataToClients);
    console.log(`[${new Date().toLocaleTimeString()}] ✅ Scan terminé en ${Date.now() - t0}ms — ${sseClients.size} client(s) SSE`);
  }
}

/* --------------------------------------------------------------------------
   Démarrage
   -------------------------------------------------------------------------- */
loadCacheFromDisk();
loadHistoryFromDisk();
loadForecastFromDisk();
startBackgroundPolling();
startWeatherPolling(broadcastSSE);

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur prêt sur http://localhost:${PORT}`));

/* --------------------------------------------------------------------------
   Arrêt propre (SIGINT / SIGTERM)
   -------------------------------------------------------------------------- */
function shutdown() {
  console.log("🛑 Arrêt propre...");
  saveCacheToDiskSync();
  try { atomicWriteSync(HISTORY_FILE, JSON.stringify(history)); } catch { }
  process.exit(0);
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
