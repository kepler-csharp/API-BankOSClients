const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { tenantPool, central, tenantAdminEmail } = require('./db');
const { requireAuth } = require('./auth-session');
const { ok, fail, wrap } = require('./helpers');
const { sendMail, tpl } = require('./mailer');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /pqrs — mis PQRS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pqrs', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId } = req.session;
  const { per_page = 50 } = req.query;
  const pool = tenantPool(tenantId);

  let rows;
  try {
    const result = await pool.query(
      `SELECT id, type, subject, message, status, admin_response, created_at
       FROM pqrs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, Math.min(parseInt(per_page), 100)]
    );
    rows = result.rows;
  } catch (e) {
    // Si la tabla no existe aún, devolvemos vacío
    if (e.code === '42P01') return ok(res, []);
    throw e;
  }

  return ok(res, rows.map(formatPqrs));
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /pqrs/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pqrs/:id', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId } = req.session;
  const pool = tenantPool(tenantId);

  const { rows } = await pool.query(
    `SELECT id, type, subject, message, status, admin_response, created_at
     FROM pqrs WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [req.params.id, userId]
  );
  if (!rows[0]) return fail(res, 'PQRS no encontrada.', 'NOT_FOUND', 404);
  return ok(res, formatPqrs(rows[0]));
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /pqrs — crear PQRS
// Body: { type, subject, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/pqrs', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId, email, name } = req.session;
  const { type, subject, message } = req.body;

  if (!type || !subject || !message) {
    return fail(res, 'type, subject y message requeridos.', 'VALIDATION', 422);
  }

  const pool = tenantPool(tenantId);
  const pqrsId = uuidv4();

  let row;
  try {
    const result = await pool.query(
      `INSERT INTO pqrs (id, user_id, type, subject, message, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pendiente', NOW(), NOW())
       RETURNING id, type, subject, message, status, admin_response, created_at`,
      [pqrsId, userId, type, subject.trim(), message.trim()]
    );
    row = result.rows[0];
  } catch (e) {
    // Si la tabla no existe, crearla (con id UUID) y reintentar.
    if (e.code === '42P01') {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS pqrs (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL,
          type VARCHAR(50) NOT NULL,
          subject VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          status VARCHAR(50) DEFAULT 'pendiente',
          admin_response TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      const result = await pool.query(
        `INSERT INTO pqrs (id, user_id, type, subject, message, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'pendiente', NOW(), NOW())
         RETURNING id, type, subject, message, status, admin_response, created_at`,
        [pqrsId, userId, type, subject.trim(), message.trim()]
      );
      row = result.rows[0];
    } else {
      throw e;
    }
  }

  // ── Correos (no bloqueantes) ──────────────────────────────────────
  // 1) Acuse de recibo al cliente.
  // 2) Aviso al administrador del banco con el detalle.
  sendMail({
    to: email,
    ...tpl.pqrsUser({ userName: name, type, subject: subject.trim() }),
  });

  const adminEmail = await tenantAdminEmail(tenantId);
  if (adminEmail) {
    sendMail({
      to: adminEmail,
      ...tpl.pqrsAdmin({
        userName: name,
        userEmail: email,
        type,
        subject: subject.trim(),
        message: message.trim(),
      }),
    });
  }

  return ok(res, formatPqrs(row), 201);
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /config — configuración del tenant (límites, monedas, comisiones)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/config', requireAuth, wrap(async (req, res) => {
  const { tenantId } = req.session;

  // Intentar leer configuración desde bankos_central
  let config = {};
  try {
    const { rows } = await central.query(
      `SELECT data FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    if (rows[0]?.data) {
      config = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data)
        : rows[0].data;
    }
  } catch (e) {
    // Si falla, devolvemos defaults
  }

  // Defaults si no hay configuración en la DB
  return ok(res, {
    max_transaction_amount: config.max_transaction_amount || null,
    currencies: config.currencies || ['COP'],
    fee_deposit: config.fee_deposit || 0,
    fee_withdrawal: config.fee_withdrawal || 0,
    fee_transfer: config.fee_transfer || 0,
    ...config,
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function formatPqrs(r) {
  return {
    id: r.id.toString(),
    type: r.type,
    subject: r.subject,
    message: r.message,
    status: r.status,
    admin_response: r.admin_response || null,
    created_at: r.created_at ? r.created_at.toISOString() : null,
  };
}

module.exports = router;
