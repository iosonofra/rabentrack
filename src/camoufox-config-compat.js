import fs from 'node:fs';
import path from 'node:path';

function removeUnsupportedMappings(node, supportedProperties, prefix = '') {
  const removed = [];

  for (const [key, value] of Object.entries(node || {})) {
    const sourcePath = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'string') {
      if (!supportedProperties.has(value)) {
        delete node[key];
        removed.push({ source: sourcePath, target: value });
      }
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      removed.push(...removeUnsupportedMappings(value, supportedProperties, sourcePath));
    }
  }

  return removed;
}

export function applyCamoufoxSchemaCompatibility(mapping, installDir = process.env.CAMOUFOX_INSTALL_DIR) {
  if (!installDir) return { applied: false, reason: 'install-dir-missing', removed: [] };

  const propertiesPath = path.join(installDir, 'properties.json');
  if (!fs.existsSync(propertiesPath)) {
    return { applied: false, reason: 'properties-file-missing', propertiesPath, removed: [] };
  }

  const properties = JSON.parse(fs.readFileSync(propertiesPath, 'utf8'));
  const supportedProperties = new Set(
    Array.isArray(properties)
      ? properties.map((entry) => entry?.property).filter(Boolean)
      : [],
  );

  if (supportedProperties.size === 0) {
    throw new Error(`Schema Camoufox non valido o vuoto: ${propertiesPath}`);
  }

  const removed = removeUnsupportedMappings(mapping, supportedProperties);
  return { applied: true, propertiesPath, removed };
}

