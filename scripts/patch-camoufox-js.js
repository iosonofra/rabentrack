#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchCamoufoxLibrary } from '../src/camoufox-library-patch.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const utilsPath = path.join(rootDir, 'node_modules', 'camoufox-js', 'dist', 'utils.js');
const result = patchCamoufoxLibrary(utilsPath);

console.log(
  result.changed
    ? 'Compatibilità camoufox-js applicata allo schema del browser.'
    : 'Compatibilità camoufox-js già applicata.',
);

