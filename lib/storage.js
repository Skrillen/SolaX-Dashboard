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
  console.log(`[${new Date().toLocaleTimeString()}] 💾 Sauvegarde OK : ${path.basename(filePath)}`);
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
  console.log(`[${new Date().toLocaleTimeString()}] 💾 Sauvegarde OK : ${path.basename(filePath)}`);
}

/**
 * Lecture défensive d'un fichier JSON.
 * Retourne l'objet parsé, ou null si :
 *   - le fichier n'existe pas
 *   - le contenu n'est pas du JSON valide
 *   - la valeur parsée n'est pas un objet non-null
 *
 * @param {string} filePath
 * @returns {object|null}
 */
function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.warn(`[storage] Impossible de lire ${filePath} :`, err.message);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[storage] JSON invalide dans ${filePath} :`, err.message);
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`[storage] Données inattendues dans ${filePath} (attendu: objet)`);
    return null;
  }

  return parsed;
}

module.exports = { atomicWriteSync, atomicWrite, safeReadJson };
