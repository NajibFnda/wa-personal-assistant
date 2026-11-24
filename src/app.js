import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, UPLOADS_DIR, db } from './config/db.js';
import apiRouter, { requirePinMiddleware } from './routes/api.js';
import { initWebPush } from './services/notifier.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';
import { initWhatsApp } from './services/whatsapp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Serve uploaded media/files (protected by WEB_PIN if configured)
  app.use('/uploads', requirePinMiddleware, express.static(UPLOADS_DIR));

  // REST API routes
  app.use('/api', apiRouter);

  // Static PWA & Web Dashboard files
  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Service-Worker-Allowed', '/');
        }
      },
    })
  );

  // SPA fallback (Express 5 compatible)
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
    }
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  return app;
}

const isDirectExecution =
  process.env.pm_id !== undefined ||
  (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename));

if (isDirectExecution) {
  const PORT = Number(process.env.PORT) || 3000;
  const app = createApp();

  initWebPush();

  const server = app.listen(PORT, () => {
    console.log('====================================================');
    console.log(' 🤖 All-in-One Personal Assistant Aktif');
    console.log(` 🌐 Web Dashboard : http://localhost:${PORT}`);
    console.log(` 🗄️  Database      : ${path.join(PROJECT_ROOT, 'assistant.db')}`);
    console.log('====================================================');
  });

  startScheduler();

  if (process.env.DISABLE_WHATSAPP !== 'true') {
    initWhatsApp().catch((err) => {
      console.error('[App] Failed to start WhatsApp service:', err);
    });
  }

  const shutdown = (signal) => {
    console.log(`\n[App] Menerima ${signal}, mematikan layanan dengan aman...`);
    stopScheduler();
    server.close(() => {
      try {
        db.close();
      } catch {
        // ignore
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
