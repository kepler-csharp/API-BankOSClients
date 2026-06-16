const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes-auth');
const accountRoutes = require('./routes-accounts');
const txRoutes = require('./routes-transactions');
const pqrsConfigRoutes = require('./routes-pqrs-config');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middlewares globales ──────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Log de requests (útil para debug)
app.use((req, _res, next) => {
  const tenant = req.headers['x-tenant-id'] || '-';
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} tenant=${tenant}`);
  next();
});

// ── Rutas ─────────────────────────────────────────────────────────────────────
// El ApiClient de Flutter apunta a /api/v1, así que montamos todo ahí.
//
// IMPORTANTE: el router de transacciones define internamente las rutas
// /deposit, /transfer, /withdrawal/request-code y /withdrawal/confirm.
// Por eso lo montamos UNA sola vez en /api/v1/transactions, y dejamos que
// el propio router maneje el sub-path /withdrawal. Montarlo además en
// /api/v1/withdrawal duplicaba la ruta (→ /withdrawal/withdrawal/...) y
// causaba el 404 al pedir el código de retiro.
app.use('/api/v1', authRoutes);          // /api/v1/banks, /api/v1/auth/*
app.use('/api/v1/transactions', txRoutes);
app.use('/api/v1/accounts', accountRoutes);
app.use('/api/v1', pqrsConfigRoutes);    // /api/v1/pqrs, /api/v1/config

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }));

// 404 explícito (para que el cliente reciba el formato estándar)
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Ruta no encontrada: ${req.method} ${req.path}` },
  });
});

// ── Error handler global ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message || err);
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL', message: 'Error interno del servidor.' },
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏦 BankOS Proxy corriendo en http://0.0.0.0:${PORT}`);
  console.log(`   DB: ${process.env.DB_HOST || '87.99.154.103'}:${process.env.DB_PORT || '5433'}`);
  console.log(`   Endpoints disponibles:`);
  console.log(`     GET   /api/v1/banks`);
  console.log(`     POST  /api/v1/auth/login`);
  console.log(`     POST  /api/v1/auth/register`);
  console.log(`     GET   /api/v1/auth/me`);
  console.log(`     POST  /api/v1/auth/logout`);
  console.log(`     PATCH /api/v1/auth/me/password`);
  console.log(`     GET   /api/v1/accounts`);
  console.log(`     GET   /api/v1/accounts/:id`);
  console.log(`     GET   /api/v1/accounts/:id/qr`);
  console.log(`     GET   /api/v1/transactions`);
  console.log(`     POST  /api/v1/transactions/deposit`);
  console.log(`     POST  /api/v1/transactions/transfer`);
  console.log(`     POST  /api/v1/transactions/transfer-external   (entre bancos)`);
  console.log(`     POST  /api/v1/transactions/resolve-external     (buscar cuenta en otro banco)`);
  console.log(`     POST  /api/v1/transactions/withdrawal/request-code`);
  console.log(`     POST  /api/v1/transactions/withdrawal/confirm`);
  console.log(`     GET   /api/v1/pqrs`);
  console.log(`     POST  /api/v1/pqrs`);
  console.log(`     GET   /api/v1/config\n`);
});
