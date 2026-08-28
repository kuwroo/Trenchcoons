import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname));

function writeDefaultsModule(settings) {
  const defaultsPath = path.join(root, 'src', 'defaults.js');
  const jsonPath = path.join(root, 'src', 'defaults.json');

  // Coerce numeric-looking strings for stable defaults object
  const coerced = {};
  for (const [k, v] of Object.entries(settings)) {
    if (typeof v === 'boolean') coerced[k] = v;
    else if (typeof v === 'number') coerced[k] = v;
    else if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) && !v.startsWith('#')) {
      coerced[k] = Number(v);
    } else {
      coerced[k] = v;
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(coerced, null, 2) + '\n');
  fs.writeFileSync(
    defaultsPath,
    `/** Auto-saved panel defaults — do not edit by hand; use "Save as project defaults". */\n` +
      `export const DEFAULTS = ${JSON.stringify(coerced, null, 2)};\n`
  );
  return coerced;
}

function saveDefaultsPlugin() {
  return {
    name: 'save-defaults',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/__save-defaults' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const settings = JSON.parse(body);
              const saved = writeDefaultsModule(settings);
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, count: Object.keys(saved).length, settings: saved }));
              // trigger HMR for defaults consumers
              const mod = server.moduleGraph.getModuleById(path.join(root, 'src', 'defaults.js'));
              if (mod) server.reloadModule(mod);
            } catch (err) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: String(err) }));
            }
          });
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [saveDefaultsPlugin()],
  server: {
    host: true,
    port: 5173,
  },
});
