"use strict";

require("dotenv").config();

const express     = require("express");
const compression = require("compression");

const { isProd, startTime, wifiSns } = require("./lib/config");
const { loadCacheFromDisk, saveCacheToDiskSync, cache, fetchAllInverters } = require("./lib/solax");
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

// Force-refresh avec cooldown anti-spam
let lastForceRefresh  = 0;
const REFRESH_COOLDOWN = 60_000;

app.post("/api/mgmt/force-refresh", async (req, res) => {
  const now = Date.now();
  if (now - lastForceRefresh < REFRESH_COOLDOWN) {
    const remains = Math.ceil((REFRESH_COOLDOWN - (now - lastForceRefresh)) / 1000);
    return res.status(429).json({ error: `Cooldown actif. Réessayez dans ${remains}s.` });
  }
  console.log("🛠️ Force Refresh demandé via secret gesture...");
  lastForceRefresh = now;
  fetchAllInverters(pushDataToClients).catch(() => {});
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

  console.log("🔁 Démarrage du Polling (toutes les 60s)...");
  while (true) {
    await sleep(60_000);
    const t0 = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] Scan ${wifiSns.length} onduleurs...`);
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
