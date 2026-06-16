const express = require('express');
const { tenantPool } = require('./db');
const { requireAuth } = require('./auth-session');
const { ok, fail, wrap } = require('./helpers');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /accounts — mis cuentas (filtradas al usuario autenticado)
// Query: ?status=active&per_page=100&search=123456
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId } = req.session;
  const { status, search, per_page = 100 } = req.query;
  const pool = tenantPool(tenantId);

  let sql, params;

  if (search) {
    // Búsqueda de cuenta destino por número (para transferencias)
    // Devuelve cuentas activas que coincidan por número, SIN filtrar por userId
    // (porque el destino es de otro usuario)
    sql = `
      SELECT a.id, a.user_id, a.account_number, a.balance, a.currency, a.status,
             u.name AS owner_name
      FROM accounts a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.status = 'active'
        AND a.account_number ILIKE $1
      ORDER BY a.account_number
      LIMIT $2
    `;
    params = [`%${search}%`, Math.min(parseInt(per_page), 50)];
  } else {
    // Mis cuentas propias
    sql = `
      SELECT a.id, a.user_id, a.account_number, a.balance, a.currency, a.status,
             u.name AS owner_name
      FROM accounts a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.user_id = $1
        ${status ? 'AND a.status = $3' : ''}
      ORDER BY a.created_at ASC
      LIMIT $2
    `;
    params = status
      ? [userId, parseInt(per_page), status]
      : [userId, parseInt(per_page)];
  }

  const { rows } = await pool.query(sql, params);

  return ok(res, rows.map(formatAccount));
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /accounts/:id — detalle de una cuenta
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId } = req.session;
  const pool = tenantPool(tenantId);

  const { rows } = await pool.query(
    `SELECT a.id, a.user_id, a.account_number, a.balance, a.currency, a.status,
            u.name AS owner_name
     FROM accounts a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.id = $1 AND a.user_id = $2
     LIMIT 1`,
    [req.params.id, userId]
  );

  if (!rows[0]) return fail(res, 'Cuenta no encontrada.', 'NOT_FOUND', 404);
  return ok(res, formatAccount(rows[0]));
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /accounts/:id/qr — payload QR para cobro
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/qr', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId } = req.session;
  const pool = tenantPool(tenantId);

  const { rows } = await pool.query(
    `SELECT a.id, a.account_number, a.currency,
            u.name AS owner_name
     FROM accounts a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.id = $1 AND a.user_id = $2 AND a.status = 'active'
     LIMIT 1`,
    [req.params.id, userId]
  );

  if (!rows[0]) return fail(res, 'Cuenta no encontrada.', 'NOT_FOUND', 404);

  const a = rows[0];
  const payloadData = {
    account_id: a.id.toString(),
    account_number: a.account_number,
    tenant_id: tenantId,
    currency: a.currency,
    owner_name: a.owner_name || '',
  };

  return ok(res, {
    payload: JSON.stringify(payloadData),
    payload_data: payloadData,
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function formatAccount(r) {
  return {
    id: r.id.toString(),
    user_id: r.user_id?.toString(),
    account_number: r.account_number,
    balance: parseFloat(r.balance) || 0,
    currency: r.currency || 'COP',
    status: r.status || 'active',
    owner_name: r.owner_name || null,
  };
}

module.exports = router;
