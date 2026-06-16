const express = require('express');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { central, tenantPool, tenantAdminEmail } = require('./db');
const { createSession, destroySession, requireAuth } = require('./auth-session');
const { ok, fail, wrap } = require('./helpers');
const { sendMail, tpl } = require('./mailer');

const router = express.Router();

// Nombre legible del banco (tenant) desde bankos_central.
async function tenantDisplayName(tenantId) {
  try {
    const { rows } = await central.query(
      `SELECT data->>'name' AS name FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    return rows[0]?.name || tenantId;
  } catch {
    return tenantId;
  }
}

// PHP genera hashes con prefijo $2y$, Node.js espera $2b$. Son idénticos internamente.
function phpHashToNode(hash) {
  if (hash && hash.startsWith('$2y$')) return '$2b$' + hash.slice(4);
  return hash;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /banks
// ─────────────────────────────────────────────────────────────────────────────
router.get('/banks', wrap(async (req, res) => {
  const { rows } = await central.query(
    `SELECT id, data->>'name' AS name FROM tenants ORDER BY id`
  );
  return ok(res, rows.map(r => ({ id: r.id, name: r.name || r.id })));
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/login
// ─────────────────────────────────────────────────────────────────────────────
router.post('/auth/login', wrap(async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) return fail(res, 'Falta X-Tenant-ID.', 'ERROR', 400);

  const { email, password } = req.body;
  if (!email || !password) return fail(res, 'Email y contraseña requeridos.', 'VALIDATION', 422);

  const pool = tenantPool(tenantId);
  let user;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, password, role FROM users WHERE email = $1 LIMIT 1`,
      [email.trim().toLowerCase()]
    );
    user = rows[0];
  } catch (e) {
    console.error(`[login] DB error tenant ${tenantId}:`, e.message);
    return fail(res, 'Base de datos del banco no disponible.', 'ERROR', 503);
  }

  if (!user) return fail(res, 'Correo o contraseña incorrectos.', 'INVALID_CREDENTIALS', 401);

  const match = await bcrypt.compare(password, phpHashToNode(user.password));
  if (!match) return fail(res, 'Correo o contraseña incorrectos.', 'INVALID_CREDENTIALS', 401);

  if (user.role !== 'cliente') {
    return fail(res, 'Esta aplicación es exclusiva para clientes del banco.', 'FORBIDDEN', 403);
  }

  const token = createSession({
    userId: user.id.toString(),
    tenantId,
    email: user.email,
    name: user.name,
    role: user.role,
  });

  return ok(res, {
    token,
    user: { id: user.id.toString(), name: user.name, email: user.email, role: user.role },
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/register
// ─────────────────────────────────────────────────────────────────────────────
router.post('/auth/register', wrap(async (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  if (!tenantId) return fail(res, 'Falta X-Tenant-ID.', 'ERROR', 400);

  const { name, email, password, password_confirmation } = req.body;
  if (!name || !email || !password) return fail(res, 'Nombre, email y contraseña requeridos.', 'VALIDATION', 422);
  if (password !== password_confirmation) return fail(res, 'Las contraseñas no coinciden.', 'VALIDATION', 422);
  if (password.length < 8) return fail(res, 'Mínimo 8 caracteres.', 'VALIDATION', 422);

  const pool = tenantPool(tenantId);

  const { rows: existing } = await pool.query(
    `SELECT id FROM users WHERE email = $1 LIMIT 1`,
    [email.trim().toLowerCase()]
  );
  if (existing.length > 0) return fail(res, 'El correo ya está registrado.', 'VALIDATION', 422);

  const hash = await bcrypt.hash(password, 12);
  const now = new Date();
  const userId = uuidv4();
  const accountId = uuidv4();

  let newUser;
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (id, name, email, password, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'cliente', $5, $6)
       RETURNING id, name, email, role`,
      [userId, name.trim(), email.trim().toLowerCase(), hash, now, now]
    );
    newUser = rows[0];
  } catch (e) {
    console.error('[register] DB error:', e.message);
    return fail(res, 'No se pudo crear el usuario.', 'ERROR', 500);
  }

  let accountNumber = null;
  try {
    accountNumber = generateAccountNumber();
    await pool.query(
      `INSERT INTO accounts (id, user_id, account_number, balance, currency, status, created_at, updated_at)
       VALUES ($1, $2, $3, 0.00, 'COP', 'active', $4, $5)`,
      [accountId, newUser.id, accountNumber, now, now]
    );
  } catch (e) {
    console.warn('[register] No se pudo crear cuenta automática:', e.message);
  }

  // ── Correos (no bloqueantes) ──────────────────────────────────────
  // 1) Bienvenida al cliente recién registrado.
  // 2) Aviso al administrador del banco.
  const bankName = await tenantDisplayName(tenantId);
  sendMail({
    to: newUser.email,
    ...tpl.welcome({ userName: newUser.name, bankName, accountNumber: accountNumber || '—' }),
  });

  const adminEmail = await tenantAdminEmail(tenantId);
  if (adminEmail) {
    sendMail({
      to: adminEmail,
      ...tpl.adminNewUser({
        userName: newUser.name,
        userEmail: newUser.email,
        bankName,
        accountNumber: accountNumber || '—',
      }),
    });
  }

  const token = createSession({
    userId: newUser.id.toString(),
    tenantId,
    email: newUser.email,
    name: newUser.name,
    role: newUser.role,
  });

  return ok(res, {
    token,
    user: { id: newUser.id.toString(), name: newUser.name, email: newUser.email, role: newUser.role },
  }, 201);
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/me
// ─────────────────────────────────────────────────────────────────────────────
router.get('/auth/me', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId } = req.session;
  const pool = tenantPool(tenantId);
  const { rows } = await pool.query(
    `SELECT id, name, email, role FROM users WHERE id = $1 LIMIT 1`, [userId]
  );
  if (!rows[0]) return fail(res, 'Usuario no encontrado.', 'NOT_FOUND', 404);
  const u = rows[0];
  return ok(res, { id: u.id.toString(), name: u.name, email: u.email, role: u.role });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/logout
// ─────────────────────────────────────────────────────────────────────────────
router.post('/auth/logout', requireAuth, wrap(async (req, res) => {
  destroySession(req.token);
  return ok(res, { message: 'Sesión cerrada.' });
}));

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /auth/me/password
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/auth/me/password', requireAuth, wrap(async (req, res) => {
  const { current_password, password, password_confirmation } = req.body;
  const { userId, tenantId } = req.session;

  if (!current_password || !password) return fail(res, 'Contraseña actual y nueva requeridas.', 'VALIDATION', 422);
  if (password !== password_confirmation) return fail(res, 'Las contraseñas no coinciden.', 'VALIDATION', 422);
  if (password.length < 8) return fail(res, 'Mínimo 8 caracteres.', 'VALIDATION', 422);

  const pool = tenantPool(tenantId);
  const { rows } = await pool.query(`SELECT password FROM users WHERE id = $1 LIMIT 1`, [userId]);
  if (!rows[0]) return fail(res, 'Usuario no encontrado.', 'NOT_FOUND', 404);

  const match = await bcrypt.compare(current_password, phpHashToNode(rows[0].password));
  if (!match) return fail(res, 'La contraseña actual no es válida.', 'INVALID_PASSWORD', 401);

  const hash = await bcrypt.hash(password, 12);
  await pool.query(`UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2`, [hash, userId]);
  return ok(res, { message: 'Contraseña actualizada.' });
}));

function generateAccountNumber() {
  const ts = Date.now().toString().slice(-6);
  const rand = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return ts + rand;
}

module.exports = router;