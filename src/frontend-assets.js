import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

const publicDir = new URL('../public/', import.meta.url);

function representation(body, type) {
  const identity = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    type,
    identity,
    gzip: gzipSync(identity),
    br: brotliCompressSync(identity, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
  };
}

// Prepared once before accepting requests; no compression work on each request.
export function createFrontendAssets() {
  const assets = new Map();
  let html = readFileSync(new URL('index.html', publicDir), 'utf8');
  for (const [name, type] of [['app.js', 'text/javascript'], ['styles.css', 'text/css'], ['overrides.css', 'text/css']]) {
    const body = readFileSync(new URL(name, publicDir));
    const digest = createHash('sha256').update(body).digest('hex');
    const path = `/assets/${digest}/${name}`;
    assets.set(path, representation(body, type));
    html = html.replace(new RegExp(`/${name.replaceAll('.', '\\.')}(?:\\?v=[^"']*)?(?=["'])`, 'g'), path);
  }
  const index = representation(html, 'text/html');

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const isIndex = req.path === '/' || req.path === '/index.html';
    const asset = isIndex ? index : assets.get(req.path);
    if (!asset) return next();
    // Absent Accept-Encoding uses identity; never send unsolicited compression.
    const encoding = req.get('Accept-Encoding') ? req.acceptsEncodings('br', 'gzip', 'identity') : 'identity';
    res.vary('Accept-Encoding');
    res.set('Cache-Control', isIndex ? 'no-cache' : 'public, max-age=31536000, immutable');
    if (!encoding) return res.status(406).end();
    res.set('Content-Type', `${asset.type}; charset=utf-8`);
    if (encoding !== 'identity') res.set('Content-Encoding', encoding);
    return res.send(asset[encoding]);
  };
}
