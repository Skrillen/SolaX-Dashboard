"use strict";

const fs    = require("fs");
const axios = require("axios");
const suncalc = require("suncalc");
const { CACHE_FILE, CLIENT_ID, CLIENT_SECRET, METER_SN, wifiSns, WEATHER_LAT, WEATHER_LON } = require("./config");
const { atomicWriteSync, safeReadJson } = require("./storage");
const historyMod = require("./history");

/* --------------------------------------------------------------------------
   Cache onduleurs en RAM
   -------------------------------------------------------------------------- */
const cache = {};
let cacheSaveTimer = null;
let lastResetDay = new Date().getDate();

/** Reset de la production du jour (yieldtoday) et capture des compteurs Import/Export à minuit pile. */
function checkMidnightReset() {
  const now = new Date();
  const currentDay = now.getDate();

  if (currentDay !== lastResetDay) {
    const timeStr = now.toLocaleTimeString();
    console.log(`[${timeStr}] 🕛 Minuit détecté : Préparation du bilan et reset.`);
    
    const dayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(now.getTime() - 10000)); // Clé de la veille au soir

    // 1. Calculer les totaux pour le bilan
    let totalYieldToday = 0;
    for (const sn of wifiSns) {
      totalYieldToday += (cache[sn]?.data?.yieldtoday || 0);
    }
    
    let dailyImport = 0, dailyExport = 0;
    if (cache["meter"]?.data) {
      dailyImport = cache["meter"].data.dailyImport || 0;
      dailyExport = cache["meter"].data.dailyExport || 0;
    }

    // 2. Enregistrer le bilan définitif
    historyMod.recordDailySummary(dayKey, {
      yield:  totalYieldToday,
      import: dailyImport,
      export: dailyExport
    });

    // 3. Reset onduleurs
    for (const sn of wifiSns) {
      if (cache[sn]?.data) {
        cache[sn].data.yieldtoday = 0;
      }
    }
    
    // 4. Capture du nouveau baseline pour le Meter
    if (cache["meter"]?.data) {
      cache["meter"].data.importEnergyDayBase = cache["meter"].data.importEnergy || 0;
      cache["meter"].data.exportEnergyDayBase = cache["meter"].data.exportEnergy || 0;
      // On reset les daily le temps du prochain fetch
      cache["meter"].data.dailyImport = 0;
      cache["meter"].data.dailyExport = 0;
      console.log(`[${timeStr}] 📉 Baseline Meter capturé pour la nouvelle journée.`);
    }

    lastResetDay = currentDay;
    scheduleSaveCache();
  }
}

/* --------------------------------------------------------------------------
   Persistance du cache
   -------------------------------------------------------------------------- */
function loadCacheFromDisk() {
  const parsed = safeReadJson(CACHE_FILE);
  if (!parsed) return;
  for (const sn of [...wifiSns, "meter"]) {
    const entry = parsed[sn];
    if (
      entry &&
      typeof entry === "object" &&
      entry.data && typeof entry.data === "object" &&
      typeof entry.timestamp === "number"
    ) {
      cache[sn] = entry;
    }
  }
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
   Calcul Solaire (Lever/Coucher)
   Margin de 30 minutes (1800000 ms)
   -------------------------------------------------------------------------- */
function isSunActive() {
  const now = new Date();
  const times = suncalc.getTimes(now, WEATHER_LAT, WEATHER_LON);
  const margin = 30 * 60 * 1000; // 30 minutes

  // Stocker les heures brutes pour l'affichage (éphéméride)
  cache._solar = {
    sunrise: times.sunrise.getTime(),
    sunset:  times.sunset.getTime()
  };

  const activeStart = times.sunrise.getTime() - margin;
  const activeEnd   = times.sunset.getTime() + margin;
  const currentTime = now.getTime();

  return currentTime >= activeStart && currentTime <= activeEnd;
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

    const errCode = response.data?.code;
    const errMsg  = response.data?.message || "Inconnu";

    if (errCode === 10000 && Array.isArray(response.data.result)) {
      const now = Date.now();
      for (const item of response.data.result) {
        const sn = item.deviceSn;
        const previousData = cache[sn]?.data;
        const mappedData = {
          acpower:       item.acPower1 !== null ? item.acPower1 : 0,  // Puissance AC onduleur
          yieldtoday:    item.dailyYield > 0 ? item.dailyYield : Math.max(previousData?.yieldtoday || 0, item.dailyYield || 0),
          yieldtotal:    item.totalYield > 0 ? item.totalYield : Math.max(previousData?.yieldtotal || 0, item.totalYield || 0),
          inverterStatus:item.deviceStatus,                            // Statut onduleur
          uploadTime:    item.dataTime,                                // Date de la mesure
          feedinpower:   item.gridPower !== null ? item.gridPower : 0, // Puissance injectée réseau
          powerdc1:      item.dcPower1 !== undefined ? item.dcPower1 : (item.pvPower1 || 0),
          powerdc2:      item.dcPower2 !== undefined ? item.dcPower2 : (item.pvPower2 || 0),
        };
        if (wifiSns.includes(sn)) {
          cache[sn] = { data: mappedData, timestamp: now };
        }
      }
      console.log(`[${new Date().toLocaleTimeString()}] 🛰️ Cache Inverters mis à jour (${response.data.result.length} actifs)`);
      scheduleSaveCache();
      return true;
    }

    // Gestion des erreurs spécifiques
    if (errCode === 10400 || errCode === 10402 || errCode === 10014) {
      console.warn(`[API] Token invalide (${errCode}). Forçage renouvellement...`);
      tokenExpiresAt = 0;
    } else if (errCode === 10405) {
      console.error(`[API] QUOTA ÉPUISÉ (10405) : Plus d'appels possibles aujourd'hui.`);
    } else if (errCode === 10406 || errCode === 11500) {
      console.warn(`[API] SolaX Surchargé (${errCode}) : Pause recommandée.`);
    } else {
      console.error(`[API] Erreur SolaX (${errCode}): ${errMsg}`);
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

    const errCode = response.data?.code;
    const errMsg  = response.data?.message || "Inconnu";

    if (errCode === 10000 && Array.isArray(response.data.result)) {
      const now = new Date();
      for (const item of response.data.result) {
        if (item.deviceSn === METER_SN) {
          const oldData = cache["meter"]?.data || {};
          let currentImport = item.importEnergy || 0;
          let currentExport = item.exportEnergy || 0;
          
          if (currentImport === 0 && oldData.importEnergy > 0) currentImport = oldData.importEnergy;
          if (currentExport === 0 && oldData.exportEnergy > 0) currentExport = oldData.exportEnergy;

          // Initialisation si installation ou reset (évite les pics à plusieurs MWh)
          const baseImport = oldData.importEnergyDayBase || currentImport;
          const baseExport = oldData.exportEnergyDayBase || currentExport;

          cache["meter"] = {
            data: {
              importEnergy:     currentImport,
              exportEnergy:     currentExport,
              importEnergyDayBase: baseImport,
              exportEnergyDayBase: baseExport,
              dailyImport:      Math.max(0, currentImport - baseImport),
              dailyExport:      Math.max(0, currentExport - baseExport),
              totalActivePower: item.totalActivePower || 0,
            },
            timestamp: now.getTime(),
          };
        }
      }
      console.log(`[${new Date().toLocaleTimeString()}] ⚡ Cache Meter mis à jour`);
      scheduleSaveCache();
      return true;
    }

    if (errCode === 10400 || errCode === 10402 || errCode === 10014) {
      tokenExpiresAt = 0;
    } else if (errCode !== 10000) {
      console.error(`[API Meter] Erreur SolaX (${errCode}): ${errMsg}`);
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
async function fetchAllInverters(pushDataToClients, force = false) {
  checkMidnightReset();
  const sunActive = isSunActive();
  const tasks = [fetchMeterBatch()];

  if (sunActive || force) {
    if (force) console.log(`[${new Date().toLocaleTimeString()}] 🛠️ Refresh forcé détecté.`);
    tasks.push(fetchFromSolaxBatch());
  } else {
    const timeStr = new Date().toLocaleTimeString();
    console.log(`[${timeStr}] 🌙 Mode nuit (SunCalc) : Skip fetch Inverters.`);
    // Reset AC power à 0 pour tous les onduleurs dans le cache pour l'historique
    for (const sn of wifiSns) {
      if (cache[sn]?.data) {
        cache[sn].data.acpower = 0;
      }
    }
  }

  await Promise.all(tasks);
  historyMod.recordHistoryPoint(cache);
  pushDataToClients();
}

module.exports = {
  cache,
  loadCacheFromDisk,
  saveCacheToDiskSync,
  fetchAllInverters,
  isSunActive,
};
