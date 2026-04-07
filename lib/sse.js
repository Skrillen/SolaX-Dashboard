"use strict";

const { wifiSns } = require("./config");
const { cache, isSunActive }   = require("./solax");
const historyMod  = require("./history");
const weatherMod  = require("./weather");

/* --------------------------------------------------------------------------
   Clients SSE connectés
   -------------------------------------------------------------------------- */
const sseClients = new Set();

/* --------------------------------------------------------------------------
   Broadcast vers tous les clients SSE
   -------------------------------------------------------------------------- */
function broadcastSSE(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(message);
    if (res.flush) res.flush(); // Nécessaire avec le middleware 'compression'
  }
}

/* --------------------------------------------------------------------------
   Construction du payload PV
   -------------------------------------------------------------------------- */
function buildPvPayload() {
  const list = wifiSns.map((sn) => {
    if (cache[sn]) {
      return {
        ...cache[sn].data,
        _sn:             sn,
        _fromCache:      true,
        _cacheTimestamp: cache[sn].timestamp,
      };
    }
    return {
      _sn:          sn,
      _error:       true,
      _errorMessage:"En attente du 1er background fetch...",
    };
  });

  return {
    inverters: list,
    meter:     cache["meter"] ? cache["meter"].data : null,
    forecast:  (weatherMod.forecastCache.daily?.predictedYield24h > 0) ? weatherMod.forecastCache : null,
    _isPaused: false, // Polling 24h/24 — jamais en pause
    _sunActive: isSunActive(),
  };
}

/* --------------------------------------------------------------------------
   Push global de toutes les données
   -------------------------------------------------------------------------- */
function pushDataToClients() {
  broadcastSSE("pv",      buildPvPayload());
  broadcastSSE("history", historyMod.history);
}

module.exports = {
  sseClients,
  broadcastSSE,
  buildPvPayload,
  pushDataToClients,
};
