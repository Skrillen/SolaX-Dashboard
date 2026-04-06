"use strict";

const fs    = require("fs");
const axios = require("axios");
const { CACHE_FILE, CLIENT_ID, CLIENT_SECRET, METER_SN, wifiSns } = require("./config");
const { atomicWriteSync } = require("./storage");
const { recordHistoryPoint } = require("./history");

/* --------------------------------------------------------------------------
   Cache onduleurs en RAM
   -------------------------------------------------------------------------- */
const cache = {};
let cacheSaveTimer = null;

/* --------------------------------------------------------------------------
   Persistance du cache
   -------------------------------------------------------------------------- */
function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw    = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const sn of [...wifiSns, "meter"]) {
      const entry = parsed[sn];
      if (entry && entry.data && entry.timestamp) cache[sn] = entry;
    }
  } catch { }
}

function saveCacheToDiskSync() {
  try {
    atomicWriteSync(CACHE_FILE, JSON.stringify(cache));
  } catch { }
}

function scheduleSaveCache() {
  if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(saveCacheToDiskSync, 500);
}

/* --------------------------------------------------------------------------
   OAuth2 — gestion du token d'accès
   -------------------------------------------------------------------------- */
let currentAccessToken = null;
let tokenExpiresAt     = 0;

async function getValidAccessToken() {
  const now = Date.now();
  // Réutiliser le token s'il est valide pour encore plus de 5 minutes
  if (currentAccessToken && tokenExpiresAt > now + 300_000) {
    return currentAccessToken;
  }

  try {
    const authRes = await axios.post(
      "https://openapi-eu.solaxcloud.com/openapi/auth/oauth/token",
      `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 8000 }
    );

    if (authRes.data?.result?.access_token) {
      currentAccessToken = authRes.data.result.access_token;
      const expiresIn    = authRes.data.result.expires_in || 3600;
      tokenExpiresAt     = now + expiresIn * 1000;
      console.log(`[OAuth2] Nouveau token obtenu (expire dans ${expiresIn}s)`);
      return currentAccessToken;
    }
    throw new Error("Format de réponse Auth invalide");
  } catch (error) {
    console.error("[OAuth2] Erreur d'authentification:", error.message);
    return null;
  }
}

/* --------------------------------------------------------------------------
   Fetch onduleurs (batch)
   -------------------------------------------------------------------------- */
async function fetchFromSolaxBatch() {
  const token = await getValidAccessToken();
  if (!token) return false;

  try {
    const snsList = wifiSns.join(",");
    const url     = `https://openapi-eu.solaxcloud.com/openapi/v2/device/realtime_data?snList=${snsList}&deviceType=1&businessType=1`;

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });

    if (response.data?.code === 10000 && Array.isArray(response.data.result)) {
      const now = Date.now();
      for (const item of response.data.result) {
        const sn = item.deviceSn;
        const mappedData = {
          acpower:       item.acPower1 !== null ? item.acPower1 : 0,  // Puissance AC onduleur
          yieldtoday:    item.dailyYield  || 0,                        // Production du jour
          yieldtotal:    item.totalYield  || 0,                        // Production totale
          inverterStatus:item.deviceStatus,                            // Statut onduleur
          uploadTime:    item.dataTime,                                // Date de la mesure
          feedinpower:   item.gridPower !== null ? item.gridPower : 0, // Puissance injectée réseau
        };
        if (wifiSns.includes(sn)) {
          cache[sn] = { data: mappedData, timestamp: now };
        }
      }
      scheduleSaveCache();
      return true;
    }

    if (response.data?.code === 10014) {
      tokenExpiresAt = 0; // Token invalide → forcer renouvellement
    } else {
      console.error("[API] Réponse inattendue:", response.data);
    }
  } catch (error) {
    console.error("[API] Erreur fetch Batch API Solax:", error.message);
    if (error.response?.status === 401) tokenExpiresAt = 0;
  }
  return false;
}

/* --------------------------------------------------------------------------
   Fetch compteur (meter)
   -------------------------------------------------------------------------- */
async function fetchMeterBatch() {
  if (!METER_SN) return false;
  const token = await getValidAccessToken();
  if (!token) return false;

  try {
    const url = `https://openapi-eu.solaxcloud.com/openapi/v2/device/realtime_data?snList=${METER_SN}&deviceType=3&businessType=1`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });

    if (response.data?.code === 10000 && Array.isArray(response.data.result)) {
      const now = Date.now();
      for (const item of response.data.result) {
        if (item.deviceSn === METER_SN) {
          cache["meter"] = {
            data: {
              importEnergy:     item.importEnergy     || 0,
              exportEnergy:     item.exportEnergy     || 0,
              totalActivePower: item.totalActivePower || 0,
            },
            timestamp: now,
          };
        }
      }
      scheduleSaveCache();
      return true;
    }
  } catch (error) {
    console.error("[API] Erreur fetch Batch API Meter:", error.message);
  }
  return false;
}

/* --------------------------------------------------------------------------
   Scan complet (onduleurs + compteur + historique)
   pushDataToClients est injecté depuis server.js pour éviter les cycles.
   -------------------------------------------------------------------------- */
async function fetchAllInverters(pushDataToClients) {
  await Promise.all([fetchFromSolaxBatch(), fetchMeterBatch()]);
  recordHistoryPoint(cache);
  pushDataToClients();
}

module.exports = {
  cache,
  loadCacheFromDisk,
  saveCacheToDiskSync,
  fetchAllInverters,
};
