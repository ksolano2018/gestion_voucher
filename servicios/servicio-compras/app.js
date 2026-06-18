'use strict';
// Microservicio servicio-compras (dominio de compras + pagos Stripe).
// Extraído de servicio-usuarios. Posee purchases, stripe_events/line_items,
// stripe_customers, transaction_events y la GENERACIÓN de vouchers (ensurePurchaseVouchers).
// Sirve sus rutas de usuario a través del gateway (valida JWT/RBAC con la BD compartida)
// y expone /internal/backfill/:partnerId (token interno) para que la activación, que
// vive en servicio-usuarios, rellene vouchers de compras pagadas.
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const purchasesRoutes = require('./src/modules/purchases/routes');
const { backfillPaidPurchaseVouchers } = require('./src/modules/purchases/service');

const app = express();

// Detrás del gateway: confiar en el primer hop para req.ip / rate-limit / logs.
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));

// JSON para todas las rutas EXCEPTO /webhook/stripe (Stripe exige el body crudo;
// express.raw se aplica en la propia ruta dentro de purchases/routes.js).
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook/stripe') return next();
  express.json({ limit: '10mb' })(req, res, next);
});

// CORS (mismo criterio que servicio-usuarios; se omite para webhooks server-to-server).
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? [process.env.FRONTEND_URL]
  : ['http://localhost:3000', 'http://localhost:8080'];
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook/stripe') return next();
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.indexOf(origin) !== -1) cb(null, true);
      else cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })(req, res, next);
});

// Validación de secretos (igual que usuarios: en prod exigir los sensibles).
const requiredEnvVars = ['JWT_SECRET'];
if (process.env.NODE_ENV === 'production') {
  requiredEnvVars.push('DB_PASSWORD', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET');
}
const missing = requiredEnvVars.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error('❌ servicio-compras: faltan variables de entorno:', missing.join(', '));
  process.exit(1);
}
if (process.env.JWT_SECRET.length < 32) {
  console.error('❌ servicio-compras: JWT_SECRET debe tener al menos 32 caracteres');
  process.exit(1);
}

const PORT = process.env.PORT || 8085;
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || '';

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'servicio-compras' }));

// Endpoint interno (token) para que servicio-usuarios rellene vouchers de compras pagadas
// durante la activación. Reemplaza la llamada local a backfillPaidPurchaseVouchers.
app.post('/internal/backfill/:partnerId', async (req, res) => {
  if (INTERNAL_API_TOKEN && req.get('x-internal-token') !== INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const generated = await backfillPaidPurchaseVouchers(req.params.partnerId);
    res.json({ ok: true, generated });
  } catch (e) {
    console.error('❌ Error en backfill de vouchers:', e.message);
    res.status(500).json({ error: 'backfill_failed' });
  }
});

// Rutas de compras/pagos (mismas paths que en el monolito; el gateway las enruta aquí).
app.use(purchasesRoutes);

// Error handler global (sin filtrar stack en prod).
app.use((err, req, res, next) => {
  console.error('❌ Error no manejado:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error', message: process.env.NODE_ENV === 'production' ? undefined : err.message });
});

process.on('unhandledRejection', (r) => console.error('unhandledRejection:', r));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

if (require.main === module) {
  app.listen(PORT, () => console.log(`✓ servicio-compras escuchando en puerto: ${PORT}`));
}

module.exports = { app };
