import fs from 'node:fs';

const PATCH_MARKER = '// RABEN_CAMOUFOX_SCHEMA_COMPATIBILITY';
const VALIDATION_BLOCK = '    // Validate the config\n    validateConfig(config, knownProperties);';
const COMPATIBILITY_BLOCK = `    ${PATCH_MARKER}\n    // camoufox-js may generate options removed from a newer Camoufox binary.\n    // Keep only keys declared by the installed browser before validation and launch.\n    for (const key of Object.keys(config)) {\n        if (!(key in knownProperties)) {\n            delete config[key];\n        }\n    }\n    // Validate the config\n    validateConfig(config, knownProperties);`;

export function patchCamoufoxLibrary(utilsPath) {
  if (!fs.existsSync(utilsPath)) {
    throw new Error(`Modulo camoufox-js non trovato: ${utilsPath}`);
  }

  const source = fs.readFileSync(utilsPath, 'utf8');
  if (source.includes(PATCH_MARKER)) return { changed: false, alreadyPatched: true };
  if (!source.includes(VALIDATION_BLOCK)) {
    throw new Error('Versione camoufox-js non riconosciuta: blocco di validazione non trovato.');
  }

  fs.writeFileSync(utilsPath, source.replace(VALIDATION_BLOCK, COMPATIBILITY_BLOCK), 'utf8');
  return { changed: true, alreadyPatched: false };
}

