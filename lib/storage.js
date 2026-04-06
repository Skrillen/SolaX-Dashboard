"use strict";

const fs  = require("fs");
const fsp = fs.promises;
const path = require("path");

/**
 * Écriture atomique synchrone.
 * Écrit dans <filePath>.tmp puis rename() atomique → filePath.
 * Un crash en plein milieu laisse l'ancien fichier intact.
 */
function atomicWriteSync(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, filePath);
}

/**
 * Écriture atomique asynchrone (non-bloquante).
 * Même principe que atomicWriteSync, mais avec des Promise.
 */
async function atomicWrite(filePath, data) {
  const tmp = filePath + ".tmp";
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(tmp, data, "utf8");
  await fsp.rename(tmp, filePath);
}

module.exports = { atomicWriteSync, atomicWrite };
