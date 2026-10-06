#!/usr/bin/env node

/**
 * Script per generare un archivio ZIP pulito per l'installazione / aggiornamento
 * di Raben - Tracking Center (per Proxmox VE Debian 12 o qualsiasi server Linux).
 * 
 * Regole di pulizia:
 * - Esclude: node_modules/, data/settings.json, data/shipments.json, data/camofox-profile,
 *   .env (file con credenziali attive), .git/, .impeccable/, file di cache e log.
 * - Include: src/, public/, scripts/, tests/, data/.gitkeep, package.json, package-lock.json,
 *   pnpm-workspace.yaml, Dockerfile, docker-compose.yml, .env.example, .gitignore, documentazione.
 * - Converte automaticamente i file script (*.sh, *.initd, *.service) con terminatori di linea LF (Unix).
 * - Imposta i permessi POSIX eseguibili (0755) negli header ZIP per tutti gli script bash.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const OUTPUT_ZIP_NAME = 'raben-tracking-center-update.zip';
const OUTPUT_ZIP_PATH = path.join(ROOT_DIR, OUTPUT_ZIP_NAME);
const PARENT_ZIP_PATH = path.join(ROOT_DIR, '..', OUTPUT_ZIP_NAME);

// Cartelle incluse (ricorsive)
const INCLUDED_DIRS = ['src', 'public', 'scripts', 'tests'];

// File singoli inclusi dalla root
const INCLUDED_ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-workspace.yaml',
  'Dockerfile',
  'docker-compose.yml',
  '.env.example',
  '.gitignore',
  'README.md',
  '006-cron-priorita-orari.md',
  'DEPLOY_PROXMOX.md',
  'DESIGN.md',
  'PRODUCT.md'
];

// File specifici in altre cartelle
const INCLUDED_SPECIFIC_FILES = [
  path.join('data', '.gitkeep')
];

// Estensioni o file da escludere tassativamente
const EXCLUDED_PATTERNS = [
  /node_modules/,
  /^\.git([\\/]|$)/,
  /^\.impeccable([\\/]|$)/,
  /^\.cache([\\/]|$)/,
  /(^|[\\/])\.env$/,
  /data[\\/](settings\.json|shipments\.json|camofox-profile)/,
  /\.zip$/,
  /\.log$/,
  /\.tmp$/,
  /\.bak$/,
  /\.DS_Store/,
  /Thumbs\.db/
];

function shouldExclude(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  return EXCLUDED_PATTERNS.some(re => re.test(normalized));
}

function getAllFiles(dir, baseDir = dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of list) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    if (shouldExclude(relPath)) continue;
    if (entry.isDirectory()) {
      results = results.concat(getAllFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      results.push({ fullPath, relPath });
    }
  }
  return results;
}

function buildCleanZip() {
  console.log('\n============================================================');
  console.log('   Generazione ZIP Aggiornamento Pulito - Raben Tracking    ');
  console.log('============================================================\n');

  const fileMap = new Map();

  // 1. Raccogli file dalle cartelle incluse
  for (const d of INCLUDED_DIRS) {
    const targetDir = path.join(ROOT_DIR, d);
    const files = getAllFiles(targetDir, ROOT_DIR);
    for (const f of files) {
      fileMap.set(f.relPath, f.fullPath);
    }
  }

  // 2. Raccogli file singoli dalla root
  for (const f of INCLUDED_ROOT_FILES) {
    const fullPath = path.join(ROOT_DIR, f);
    if (fs.existsSync(fullPath) && !shouldExclude(f)) {
      fileMap.set(f.replace(/\\/g, '/'), fullPath);
    }
  }

  // 3. Raccogli file specifici (es. data/.gitkeep)
  for (const f of INCLUDED_SPECIFIC_FILES) {
    const fullPath = path.join(ROOT_DIR, f);
    if (fs.existsSync(fullPath) && !shouldExclude(f)) {
      fileMap.set(f.replace(/\\/g, '/'), fullPath);
    }
  }

  const entries = [];
  let totalUncompressedBytes = 0;

  for (const [relPath, fullPath] of Array.from(fileMap.entries()).sort()) {
    let data = fs.readFileSync(fullPath);

    // Normalizza terminatori di linea a LF per script shell e config Linux
    const isScript = relPath.startsWith('scripts/') || relPath.endsWith('.sh') || relPath.endsWith('.initd') || relPath.endsWith('.service');
    if (isScript || relPath.endsWith('.md') || relPath.endsWith('.json') || relPath.endsWith('.example')) {
      const text = data.toString('utf8');
      if (text.includes('\r\n')) {
        data = Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8');
      }
    }

    const isExecutable = isScript && (relPath.endsWith('.sh') || relPath.endsWith('.initd'));

    entries.push({
      name: relPath,
      data,
      isExecutable
    });

    totalUncompressedBytes += data.length;
    const sizeStr = (data.length / 1024).toFixed(1) + ' KB';
    const flag = isExecutable ? '[x]' : '   ';
    console.log(`  ${flag} ${relPath.padEnd(45)} (${sizeStr.padStart(8)})`);
  }

  console.log(`\nTotale file preparati: ${entries.length} (${(totalUncompressedBytes / 1024 / 1024).toFixed(2)} MB non compressi)`);
  console.log('Compressione archivio ZIP in corso...');

  const zipBuffer = createZipBuffer(entries);

  // Scrivi su disco
  fs.writeFileSync(OUTPUT_ZIP_PATH, zipBuffer);
  console.log(`\nArchivio creato con successo:`);
  console.log(` -> ${OUTPUT_ZIP_PATH} (${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

  // Copia anche nella cartella genitore se accessibile
  try {
    const parentDir = path.dirname(PARENT_ZIP_PATH);
    if (fs.existsSync(parentDir)) {
      fs.copyFileSync(OUTPUT_ZIP_PATH, PARENT_ZIP_PATH);
      console.log(` -> Copia di comodo salvata anche in: ${PARENT_ZIP_PATH}`);
    }
  } catch {
    // ignore
  }

  // Calcolo hash SHA-256
  const sha256 = crypto.createHash('sha256').update(zipBuffer).digest('hex');
  console.log(`\nChecksum SHA-256: ${sha256}`);
  console.log('============================================================\n');
}

function createZipBuffer(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  const now = new Date();
  const year = Math.max(0, now.getFullYear() - 1980);
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = (year << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = entry.data;
    const crc = zlib.crc32(dataBuf);
    const uncompressedSize = dataBuf.length;
    const compressed = zlib.deflateRawSync(dataBuf, { level: 9 });
    const compressedSize = compressed.length;

    // Local file header (30 bytes + name)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed 2.0
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(8, 8); // compression method 8 = deflate
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localChunks.push(localHeader, nameBuf, compressed);

    // Central directory header (46 bytes + name)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4); // UNIX (3) + zip 2.0 (20)
    centralHeader.writeUInt16LE(20, 6); // version needed 2.0
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8
    centralHeader.writeUInt16LE(8, 10); // deflate
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk start
    centralHeader.writeUInt16LE(0, 36); // internal attr
    const mode = entry.isExecutable ? 0o100755 : 0o100644;
    centralHeader.writeUInt32LE(((mode << 16) >>> 0), 38); // external attr (Unix file mode)
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralChunks.reduce((acc, c) => acc + c.length, 0);

  // End of Central Directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(entries.length, 8); // entries this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12); // size of CD
  eocd.writeUInt32LE(centralDirOffset, 16); // offset of CD
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

buildCleanZip();
