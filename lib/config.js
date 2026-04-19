"use strict";

const path = require("path");

/* --------------------------------------------------------------------------
   Fichiers de persistance
   -------------------------------------------------------------------------- */
const CACHE_FILE           = path.join(__dirname, "..", "data", "solax-cache.json");
const HISTORY_FILE         = path.join(__dirname, "..", "data", "solax-history.json");
const FORECAST_FILE        = path.join(__dirname, "..", "data", "forecast-cache.json");
const DB_FILE              = path.join(__dirname, "..", "data", "solax.db");
const HISTORY_RETENTION_DAYS = 7;

/* --------------------------------------------------------------------------
   Credentials SolaX (OAuth2)
   -------------------------------------------------------------------------- */
const CLIENT_ID     = process.env.SOLAX_CLIENT_ID;
const CLIENT_SECRET = process.env.SOLAX_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("SOLAX_CLIENT_ID ou SOLAX_CLIENT_SECRET manquant : définissez-les dans .env ou l'environnement.");
  process.exit(1);
}

/* --------------------------------------------------------------------------
   Liste des onduleurs & compteur
   -------------------------------------------------------------------------- */
const SOLAX_SNS_ENV = process.env.SOLAX_SNS;
if (!SOLAX_SNS_ENV) {
  console.error("SOLAX_SNS manquant : définissez-le dans .env ou l'environnement avec une liste d'onduleurs.");
  process.exit(1);
}
const wifiSns = SOLAX_SNS_ENV.split(",").map((s) => s.trim());
const METER_SN = process.env.SOLAX_METER_SN || null;

/* --------------------------------------------------------------------------
   Environnement & runtime
   -------------------------------------------------------------------------- */
const isProd    = process.env.NODE_ENV === "production";
const startTime = Date.now();

/* --------------------------------------------------------------------------
   Météo (Open-Meteo)
   -------------------------------------------------------------------------- */
const WEATHER_LAT = parseFloat(process.env.WEATHER_LAT) || 48.8566;
const WEATHER_LON = parseFloat(process.env.WEATHER_LON) || 2.3522;

module.exports = {
  CACHE_FILE,
  HISTORY_FILE,
  FORECAST_FILE,
  DB_FILE,
  HISTORY_RETENTION_DAYS,
  CLIENT_ID,
  CLIENT_SECRET,
  wifiSns,
  METER_SN,
  isProd,
  startTime,
  WEATHER_LAT,
  WEATHER_LON,
};
