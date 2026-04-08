"use strict";

const axios = require("axios");
const { FORECAST_FILE, WEATHER_LAT, WEATHER_LON } = require("./config");
const { atomicWriteSync, safeReadJson } = require("./storage");

/* --------------------------------------------------------------------------
   Cache météo en RAM
   -------------------------------------------------------------------------- */
let forecastCache = {
  lastUpdate: null,
  hourly: [],
  daily: { predictedYield24h: 0, updatedAt: null },
};

/* --------------------------------------------------------------------------
   Persistance disque
   -------------------------------------------------------------------------- */
const fs = require("fs");

function loadForecastFromDisk() {
  const parsed = safeReadJson(FORECAST_FILE);
  if (!parsed) return;
  if (!Array.isArray(parsed.hourly) || typeof parsed.daily !== "object") {
    console.warn("[weather] Fichier forecast invalide — ignoré.");
    return;
  }
  
  // Mutation de l'objet existant pour garder la référence exportée intacte
  forecastCache.lastUpdate = parsed.lastUpdate;
  forecastCache.hourly = parsed.hourly || [];
  forecastCache.daily = parsed.daily || { predictedYield24h: 0, updatedAt: null };
  
  console.log(`[Weather] 🛰️ Cache chargé depuis le disque : ~${forecastCache.daily?.predictedYield24h || 0} kWh prévus.`);
}

function saveForecastToDiskSync() {
  try {
    atomicWriteSync(FORECAST_FILE, JSON.stringify(forecastCache));
  } catch { }
}

/* --------------------------------------------------------------------------
   Fetch Open-Meteo + calcul de production estimée
   broadcastSSE est injecté depuis server.js pour éviter les cycles.
   -------------------------------------------------------------------------- */
async function fetchWeatherForecast(broadcastSSE) {
  const PEAK_W     = parseFloat(process.env.SOLAR_PEAK_W) || 9000;
  const PERF_RATIO = 0.85; // Pertes typiques : chaleur, onduleur, câbles
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}`
    + `&hourly=cloud_cover,shortwave_radiation,direct_radiation,diffuse_radiation`
    + `&daily=sunrise,sunset`
    + `&timezone=Europe%2FParis&forecast_days=2`;

  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    if (!data?.hourly) return false;

    const h   = data.hourly;
    const now = Date.now();

    const hourlyForecast = h.time.map((t, i) => {
      // Les strings t sont "YYYY-MM-DDTHH:mm". 
      // Puisqu'on a demandé timezone=Europe/Paris à l'API, ces heures sont à l'heure de Paris.
      // On force l'interprétation en ajoutant l'offset de Paris (ou en gérant manuellement)
      // Méthode simple : Date.parse(t + ":00+02:00") pour l'heure d'été
      // Méthode propre : utiliser le fait que l'utilisateur est en France
      const dateParis = new Date(t + ":00+02:00"); // Force Paris Summer Time (Standard en Avril)
      
      return {
        time:               dateParis.getTime(),
        cloudCover:         h.cloud_cover[i]         ?? 0,
        shortwaveRadiation: h.shortwave_radiation[i] ?? 0,
        predictedPower:     Math.max(
          0,
          Math.round(((h.shortwave_radiation[i] ?? 0) / 1000) * PEAK_W * PERF_RATIO)
        ),
      };
    });

    const next24h           = hourlyForecast.filter(p => p.time >= now && p.time <= now + 86_400_000);
    const predictedYield24h = Math.round(next24h.reduce((s, p) => s + p.predictedPower / 1000, 0) * 100) / 100;

    forecastCache = { lastUpdate: now, hourly: hourlyForecast, daily: { predictedYield24h, updatedAt: now } };
    saveForecastToDiskSync();
    console.log(`[Weather] ✅ Forecast mis à jour — ${next24h.length}h prévues, ~${predictedYield24h} kWh/24h`);
    broadcastSSE("forecast", forecastCache);
    return true;
  } catch (err) {
    console.error("[Weather] Erreur fetch:", err.message);
    return false;
  }
}

function startWeatherPolling(broadcastSSE) {
  console.log(`[Weather] Polling météo démarré (${WEATHER_LAT}, ${WEATHER_LON})`);
  fetchWeatherForecast(broadcastSSE);
  setInterval(() => fetchWeatherForecast(broadcastSSE), 60 * 60 * 1000);
}

module.exports = {
  get forecastCache() { return forecastCache; },
  loadForecastFromDisk,
  startWeatherPolling,
};
