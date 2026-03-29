require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require("axios");
const compression = require("compression");

const CACHE_FILE = path.join(__dirname, "data", "solax-cache.json");

/* --------------------------------------------------------------------------
   Configuration : token Solax
   -------------------------------------------------------------------------- */
const TOKEN = process.env.SOLAX_TOKEN;
if (!TOKEN) {
  console.error("SOLAX_TOKEN manquant : définissez-le dans .env ou l’environnement.");
  process.exit(1);
}

const isProd = process.env.NODE_ENV === "production";

/* -------------------------------------------------------------------------- */
const app = express();
app.use(compression());

const staticMaxAge = isProd ? 86_400_000 : 0;
app.use(express.static("public", { maxAge: staticMaxAge }));

const SOLAX_SNS_ENV = process.env.SOLAX_SNS;
if (!SOLAX_SNS_ENV) {
  console.error("SOLAX_SNS manquant : définissez-le dans .env ou l’environnement avec une liste d'onduleurs.");
  process.exit(1);
}
const wifiSns = SOLAX_SNS_ENV.split(",").map((s) => s.trim());

const cache = {};
const TTL = 60 * 1000;

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
    }
  } catch (error) {
    console.error(`Erreur fetch API Solax (${sn}):`, error.message);
  }
}

// Daemon de fond qui interroge Solax en mode protégé
async function startBackgroundPolling() {
  console.log("Démarrage du Polling en tâche de fond...");
  // Boucle infinie non-bloquante
  while (true) {
    for (const sn of wifiSns) {
      await fetchFromSolax(sn);
      // Petite pause pour sécuriser et ne pas se faire blacklister de l'API Solax
      await sleep(300); 
    }
    // Une fois qu'on a scanné tous les onduleurs, on attend 60 secondes.
    await sleep(60000);
  }
}

// Endpoint frontend immédiat basé sur la RAM (temps de réponse ~1ms)
app.get("/api/pv", (req, res) => {
  const results = wifiSns.map((sn) => {
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
      _errorMessage: "Lancement du serveur (en attente du 1er background fetch...)" 
    };
  });
  res.json(results);
});

loadCacheFromDisk();
// Démarrer le daemon background
startBackgroundPolling();

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Serveur prêt sur http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  saveCacheToDiskSync();
  process.exit(0);
});