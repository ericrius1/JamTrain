import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const HANDPOSE_CACHE = 'public, max-age=31536000, immutable';

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.json':
      return 'application/json; charset=utf-8';
    case '.bin':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

function handposeCachePlugin(): Plugin {
  const root = resolve(process.cwd(), 'public/handpose');
  const rootWithSep = root.endsWith(sep) ? root : root + sep;

  const installMiddleware = (middlewares: { use: (handler: (req: any, res: any, next: () => void) => void) => void }) => {
    middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/handpose/')) {
        next();
        return;
      }

      const pathname = new URL(req.url, 'http://localhost').pathname;
      const relativePath = decodeURIComponent(pathname.slice('/handpose/'.length));
      const filePath = resolve(root, relativePath);

      if (!filePath.startsWith(rootWithSep)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }

      try {
        const info = await stat(filePath);
        if (!info.isFile()) {
          next();
          return;
        }

        res.setHeader('Cache-Control', HANDPOSE_CACHE);
        res.setHeader('Content-Type', contentType(filePath));
        res.setHeader('Content-Length', String(info.size));
        res.setHeader('Last-Modified', info.mtime.toUTCString());
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(filePath).pipe(res);
      } catch {
        next();
      }
    });
  };

  return {
    name: 'jam-train-handpose-cache',
    configureServer(server) {
      installMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      installMiddleware(server.middlewares);
    },
  };
}

export default defineConfig({
  plugins: [handposeCachePlugin()],
  server: {
    host: '0.0.0.0',
  },
});
