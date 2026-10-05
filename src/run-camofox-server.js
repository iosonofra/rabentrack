import browserforgeMapping from 'camoufox-js/dist/mappings/browserforge.config.js';
import { applyCamoufoxSchemaCompatibility } from './camoufox-config-compat.js';

const compatibility = applyCamoufoxSchemaCompatibility(browserforgeMapping);

if (compatibility.applied && compatibility.removed.length > 0) {
  console.warn(
    `Compatibilità Camoufox: escluse ${compatibility.removed.length} proprietà non supportate dal browser installato: ` +
    compatibility.removed.map(({ target }) => target).join(', '),
  );
}

await import('@askjo/camofox-browser/server.js');

