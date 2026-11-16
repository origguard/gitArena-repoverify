import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

export class SovereignRouter {
  constructor() {
    this.routes = [];
  }

  add(method, pathPattern, handler) {
    const keys = [];
    const regexPath = pathPattern.replace(/:([a-zA-Z0-9_]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });

    this.routes.push({
      method: method.toUpperCase(),
      regex: new RegExp(`^${regexPath}$`),
      keys,
      handler
    });
  }

  get(pathPattern, handler) { this.add('GET', pathPattern, handler); }
  post(pathPattern, handler) { this.add('POST', pathPattern, handler); }

  async handle(req, res, publicDir) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // 1. Chercher une route API correspondante
    for (const route of this.routes) {
      if (route.method === method) {
        const match = pathname.match(route.regex);
        if (match) {
          const params = {};
          route.keys.forEach((key, index) => {
            params[key] = decodeURIComponent(match[index + 1]);
          });

          req.params = params;
          req.query = Object.fromEntries(parsedUrl.searchParams.entries());

          if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
            req.body = await parseJsonBody(req);
          }

          return route.handler(req, res);
        }
      }
    }

    // 2. Fichier statique dans publicDir (protection stricte anti-Path Traversal)
    if (publicDir && method === 'GET') {
      const resolvedPublic = resolve(publicDir);
      let safeRel = '';
      try {
        safeRel = decodeURIComponent(pathname).replace(/^\/+/, '');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Chemin URL invalide' }));
      }
      if (!safeRel || safeRel === '.' || safeRel === '\\') {
        safeRel = 'index.html';
      }

      let filePath = resolve(resolvedPublic, safeRel);
      if (filePath !== resolvedPublic && !filePath.startsWith(resolvedPublic + sep)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Accès interdit (Path Traversal bloqué)' }));
      }

      if (existsSync(filePath)) {
        const stat = statSync(filePath);
        if (stat.isDirectory()) {
          filePath = join(filePath, 'index.html');
        }

        if (existsSync(filePath) && statSync(filePath).isFile()) {
          const ext = extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] || 'application/octet-stream';
          const content = readFileSync(filePath);

          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': content.length,
            'Cache-Control': 'no-cache'
          });
          return res.end(content);
        }
      }

      // Fallback SPA vers index.html
      const indexPath = join(publicDir, 'index.html');
      if (existsSync(indexPath)) {
        const indexContent = readFileSync(indexPath);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': indexContent.length
        });
        return res.end(indexContent);
      }
    }

    // 3. 404 Not Found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Route introuvable', path: pathname }));
  }
}

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}
