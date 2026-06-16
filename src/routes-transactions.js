const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { tenantPool, central } = require('./db');
const { requireAuth } = require('./auth-session');
const { ok, fail, wrap } = require('./helpers');
const { sendMail, tpl } = require('./mailer');

const router = express.Router();

// Códigos de retiro en memoria: { [userId_accountId_amount]: { code, exp } }
const withdrawalCodes = new Map();

// Helper: nombre legible del banco (tenant) desde bankos_central.
async function tenantName(tenantId) {
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /transactions — mis transacciones
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId } = req.session;
  const { per_page = 50, type, account_id } = req.query;
  const pool = tenantPool(tenantId);

  const { rows: myAccounts } = await pool.query(
    `SELECT id FROM accounts WHERE user_id = $1`,
    [userId]
  );
  const myIds = myAccounts.map(a => a.id.toString());

  if (myIds.length === 0) return ok(res, []);

  const conditions = [
    `(t.account_id::text = ANY($1) OR t.destination_account_id::text = ANY($1))`,
  ];
  const params = [myIds];
  let pi = 2;

  if (type) {
    conditions.push(`t.type = $${pi++}`);
    params.push(type);
  }
  if (account_id) {
    conditions.push(`(t.account_id::text = $${pi} OR t.destination_account_id::text = $${pi})`);
    params.push(account_id.toString());
    pi++;
  }

  params.push(Math.min(parseInt(per_page), 100));

  const sql = `
    SELECT t.id, t.type, t.status, t.account_id, t.destination_account_id,
           t.amount, t.converted_amount, t.currency, t.destination_currency,
           t.fee, t.balance_after, t.description, t.created_at
    FROM transactions t
    WHERE ${conditions.join(' AND ')}
    ORDER BY t.created_at DESC
    LIMIT $${pi}
  `;

  const { rows } = await pool.query(sql, params);
  return ok(res, rows.map(formatTx));
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /transactions/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId } = req.session;
  const pool = tenantPool(tenantId);

  const { rows: myAccounts } = await pool.query(
    `SELECT id FROM accounts WHERE user_id = $1`,
    [userId]
  );
  const myIds = myAccounts.map(a => a.id.toString());

  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.status, t.account_id, t.destination_account_id,
            t.amount, t.converted_amount, t.currency, t.destination_currency,
            t.fee, t.balance_after, t.description, t.created_at
     FROM transactions t
     WHERE t.id = $1
       AND (t.account_id::text = ANY($2) OR t.destination_account_id::text = ANY($2))
     LIMIT 1`,
    [req.params.id, myIds]
  );

  if (!rows[0]) return fail(res, 'Transacción no encontrada.', 'NOT_FOUND', 404);
  return ok(res, formatTx(rows[0]));
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /transactions/deposit
// ─────────────────────────────────────────────────────────────────────────────
router.post('/deposit', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId, email, name } = req.session;
  const { account_id, amount, description } = req.body;

  if (!account_id || !amount || parseFloat(amount) <= 0) {
    return fail(res, 'account_id y amount requeridos.', 'VALIDATION', 422);
  }

  const pool = tenantPool(tenantId);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [account] } = await client.query(
      `SELECT id, account_number, balance, currency, status FROM accounts WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [account_id, userId]
    );
    if (!account) {
      await client.query('ROLLBACK');
      return fail(res, 'Cuenta no encontrada.', 'NOT_FOUND', 404);
    }
    if (account.status !== 'active') {
      await client.query('ROLLBACK');
      return fail(res, 'La cuenta no está activa.', 'FORBIDDEN', 403);
    }

    const amt = parseFloat(amount);
    const fee = 0;
    const newBalance = parseFloat(account.balance) + amt;

    await client.query(
      `UPDATE accounts SET balance = $1, updated_at = NOW() WHERE id = $2`,
      [newBalance, account_id]
    );

    const { rows: [tx] } = await client.query(
      `INSERT INTO transactions
         (id, type, status, account_id, amount, currency, fee, balance_after, description, created_at, updated_at)
       VALUES ($1, 'deposit', 'completed', $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING *`,
      [uuidv4(), account_id, amt, account.currency, fee, newBalance, description || null]
    );

    await client.query('COMMIT');

    // Correo de confirmación (no bloqueante)
    sendMail({ to: email, ...tpl.transfer({
      userName: name, amount: amt, currency: account.currency,
      toAccount: account.account_number, incoming: true,
    }) });

    return ok(res, formatTx(tx), 201);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[deposit] Error:', e.message);
    return fail(res, 'Error al procesar el depósito.', 'ERROR', 500);
  } finally {
    client.release();
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /transactions/transfer — MISMO banco (intra-tenant)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/transfer', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId, email, name } = req.session;
  const { source_account_id, destination_account_id, amount, description } = req.body;

  if (!source_account_id || !destination_account_id || !amount || parseFloat(amount) <= 0) {
    return fail(res, 'source_account_id, destination_account_id y amount requeridos.', 'VALIDATION', 422);
  }
  if (source_account_id === destination_account_id) {
    return fail(res, 'La cuenta de origen y destino no pueden ser la misma.', 'VALIDATION', 422);
  }

  const pool = tenantPool(tenantId);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [src] } = await client.query(
      `SELECT id, account_number, balance, currency, status FROM accounts WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [source_account_id, userId]
    );
    if (!src) {
      await client.query('ROLLBACK');
      return fail(res, 'Cuenta de origen no encontrada.', 'NOT_FOUND', 404);
    }
    if (src.status !== 'active') {
      await client.query('ROLLBACK');
      return fail(res, 'La cuenta de origen no está activa.', 'FORBIDDEN', 403);
    }

    const amt = parseFloat(amount);
    const fee = 0;
    const srcBalance = parseFloat(src.balance);

    if (srcBalance < amt + fee) {
      await client.query('ROLLBACK');
      return fail(res, `Saldo insuficiente. Disponible: ${srcBalance} ${src.currency}`, 'INSUFFICIENT_FUNDS', 422);
    }

    const { rows: [dst] } = await client.query(
      `SELECT id, account_number, balance, currency, status FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE`,
      [destination_account_id]
    );
    if (!dst) {
      await client.query('ROLLBACK');
      return fail(res, 'Cuenta de destino no encontrada o inactiva.', 'NOT_FOUND', 404);
    }

    const newSrcBalance = srcBalance - amt - fee;
    const newDstBalance = parseFloat(dst.balance) + amt;

    await client.query(`UPDATE accounts SET balance = $1, updated_at = NOW() WHERE id = $2`, [newSrcBalance, source_account_id]);
    await client.query(`UPDATE accounts SET balance = $1, updated_at = NOW() WHERE id = $2`, [newDstBalance, destination_account_id]);

    const { rows: [tx] } = await client.query(
      `INSERT INTO transactions
         (id, type, status, account_id, destination_account_id,
          amount, currency, destination_currency, fee, balance_after, description, created_at, updated_at)
       VALUES ($1, 'transfer', 'completed', $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING *`,
      [uuidv4(), source_account_id, destination_account_id, amt, src.currency, dst.currency, fee, newSrcBalance, description || null]
    );

    await client.query('COMMIT');

    sendMail({ to: email, ...tpl.transfer({
      userName: name, amount: amt, currency: src.currency,
      toAccount: dst.account_number, incoming: false,
    }) });

    return ok(res, formatTx(tx), 201);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[transfer] Error:', e.message);
    return fail(res, 'Error al procesar la transferencia.', 'ERROR', 500);
  } finally {
    client.release();
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /transactions/resolve-external — busca una cuenta en OTRO banco
// Body: { dest_tenant_id, account_number }
// Devuelve datos básicos de la cuenta destino (sin exponer saldo).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/resolve-external', requireAuth, wrap(async (req, res) => {
  const { dest_tenant_id, account_number } = req.body;
  if (!dest_tenant_id || !account_number) {
    return fail(res, 'dest_tenant_id y account_number requeridos.', 'VALIDATION', 422);
  }

  // Verificar que el banco destino existe
  const bankName = await tenantName(dest_tenant_id);

  let destPool;
  try {
    destPool = tenantPool(dest_tenant_id);
  } catch (e) {
    return fail(res, 'Banco destino no disponible.', 'NOT_FOUND', 404);
  }

  let rows;
  try {
    const result = await destPool.query(
      `SELECT a.id, a.account_number, a.currency, a.status, u.name AS owner_name
       FROM accounts a LEFT JOIN users u ON u.id = a.user_id
       WHERE LOWER(a.account_number) = LOWER($1) AND a.status = 'active' LIMIT 1`,
      [account_number.toString().trim()]
    );
    rows = result.rows;
  } catch (e) {
    console.error('[resolve-external] Error:', e.message);
    return fail(res, 'No se pudo consultar el banco destino.', 'ERROR', 503);
  }

  if (!rows[0]) return fail(res, 'Cuenta no encontrada en el banco destino.', 'NOT_FOUND', 404);

  const a = rows[0];
  return ok(res, {
    account_id: a.id.toString(),
    account_number: a.account_number,
    currency: a.currency,
    owner_name: a.owner_name || '',
    tenant_id: dest_tenant_id,
    bank_name: bankName,
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /transactions/transfer-external — transferencia ENTRE BANCOS
// Body: { source_account_id, dest_tenant_id, dest_account_number, amount, description? }
//
// Como cada banco vive en su propia DB (tenant_X) en el MISMO servidor
// PostgreSQL, no hay transacción distribuida nativa. Implementamos un patrón
// de 2 fases con compensación: debitamos origen; si el crédito en destino
// falla, revertimos el débito. Se registra una transacción en CADA banco.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/transfer-external', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId, email, name } = req.session;
  const { source_account_id, dest_tenant_id, dest_account_number, amount, description } = req.body;

  if (!source_account_id || !dest_tenant_id || !dest_account_number || !amount || parseFloat(amount) <= 0) {
    return fail(res, 'source_account_id, dest_tenant_id, dest_account_number y amount requeridos.', 'VALIDATION', 422);
  }
  if (dest_tenant_id === tenantId) {
    return fail(res, 'Para transferir dentro del mismo banco usa transferencia normal.', 'VALIDATION', 422);
  }

  const amt = parseFloat(amount);
  const fee = 0;

  const srcPool = tenantPool(tenantId);
  let destPool;
  try {
    destPool = tenantPool(dest_tenant_id);
  } catch {
    return fail(res, 'Banco destino no disponible.', 'NOT_FOUND', 404);
  }

  // ── FASE 1: débito en el banco origen (transacción local atómica) ──
  const srcClient = await srcPool.connect();
  let srcTx, srcAccountNumber, srcCurrency, newSrcBalance;
  try {
    await srcClient.query('BEGIN');

    const { rows: [src] } = await srcClient.query(
      `SELECT id, account_number, balance, currency, status FROM accounts WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [source_account_id, userId]
    );
    if (!src || src.status !== 'active') {
      await srcClient.query('ROLLBACK');
      return fail(res, 'Cuenta de origen no disponible.', 'NOT_FOUND', 404);
    }

    const srcBalance = parseFloat(src.balance);
    if (srcBalance < amt + fee) {
      await srcClient.query('ROLLBACK');
      return fail(res, `Saldo insuficiente. Disponible: ${srcBalance} ${src.currency}`, 'INSUFFICIENT_FUNDS', 422);
    }

    srcAccountNumber = src.account_number;
    srcCurrency = src.currency;
    newSrcBalance = srcBalance - amt - fee;

    await srcClient.query(`UPDATE accounts SET balance = $1, updated_at = NOW() WHERE id = $2`, [newSrcBalance, source_account_id]);

    const { rows: [tx] } = await srcClient.query(
      `INSERT INTO transactions
         (id, type, status, account_id, amount, currency, fee, balance_after, description, created_at, updated_at)
       VALUES ($1, 'transfer', 'completed', $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING *`,
      [uuidv4(), source_account_id, amt, src.currency, fee, newSrcBalance,
       (description ? description + ' · ' : '') + `Transferencia a banco ${dest_tenant_id} cuenta ${dest_account_number}`]
    );
    srcTx = tx;

    await srcClient.query('COMMIT');
  } catch (e) {
    await srcClient.query('ROLLBACK');
    srcClient.release();
    console.error('[transfer-external] Error débito:', e.message);
    return fail(res, 'Error al debitar la cuenta de origen.', 'ERROR', 500);
  } finally {
    srcClient.release();
  }

  // ── FASE 2: crédito en el banco destino (transacción local atómica) ──
  const destClient = await destPool.connect();
  try {
    await destClient.query('BEGIN');

    const { rows: [dst] } = await destClient.query(
      `SELECT id, account_number, balance, currency, status FROM accounts WHERE LOWER(account_number) = LOWER($1) AND status = 'active' FOR UPDATE`,
      [dest_account_number.toString().trim()]
    );
    if (!dst) {
      await destClient.query('ROLLBACK');
      throw new Error('DEST_NOT_FOUND');
    }

    const newDstBalance = parseFloat(dst.balance) + amt;
    await destClient.query(`UPDATE accounts SET balance = $1, updated_at = NOW() WHERE id = $2`, [newDstBalance, dst.id]);

    await destClient.query(
      `INSERT INTO transactions
         (id, type, status, account_id, amount, currency, fee, balance_after, description, created_at, updated_at)
       VALUES ($1, 'transfer', 'completed', $2, $3, $4, 0, $5, $6, NOW(), NOW())`,
      [uuidv4(), dst.id, amt, dst.currency, newDstBalance,
       `Transferencia recibida del banco ${tenantId} cuenta ${srcAccountNumber}`]
    );

    await destClient.query('COMMIT');

    // Correos a ambas partes (no bloqueante)
    const destBankName = await tenantName(dest_tenant_id);
    sendMail({ to: email, ...tpl.transfer({
      userName: name, amount: amt, currency: srcCurrency,
      toAccount: dest_account_number, toBank: destBankName, incoming: false,
    }) });

    return ok(res, formatTx(srcTx), 201);
  } catch (e) {
    await destClient.query('ROLLBACK');

    // ── COMPENSACIÓN: revertir el débito del origen ──
    try {
      const comp = await srcPool.connect();
      try {
        await comp.query('BEGIN');
        const { rows: [src] } = await comp.query(
          `SELECT balance FROM accounts WHERE id = $1 FOR UPDATE`, [source_account_id]
        );
        const restored = parseFloat(src.balance) + amt + fee;
        await comp.query(`UPDATE accounts SET balance = $1, updated_at = NOW() WHERE id = $2`, [restored, source_account_id]);
        await comp.query(`UPDATE transactions SET status = 'reversed', updated_at = NOW() WHERE id = $1`, [srcTx.id]);
        await comp.query('COMMIT');
      } catch (ce) {
        await comp.query('ROLLBACK');
        console.error('[transfer-external] FALLÓ LA COMPENSACIÓN:', ce.message, 'tx origen:', srcTx.id);
      } finally {
        comp.release();
      }
    } catch (ce) {
      console.error('[transfer-external] No se pudo conectar para compensar:', ce.message);
    }

    console.error('[transfer-external] Error crédito destino:', e.message);
    if (e.message === 'DEST_NOT_FOUND') {
      return fail(res, 'Cuenta destino no encontrada. La transferencia fue revertida.', 'NOT_FOUND', 404);
    }
    return fail(res, 'No se pudo completar la transferencia. Se revirtió el cargo.', 'ERROR', 500);
  } finally {
    destClient.release();
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /withdrawal/request-code
// Genera un código de 6 dígitos (memoria, 10 min) y lo envía por CORREO REAL.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/withdrawal/request-code', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId, email, name } = req.session;
  const { account_id, amount } = req.body;

  if (!account_id || !amount || parseFloat(amount) <= 0) {
    return fail(res, 'account_id y amount requeridos.', 'VALIDATION', 422);
  }

  const pool = tenantPool(tenantId);
  const { rows: [account] } = await pool.query(
    `SELECT id, balance, currency FROM accounts WHERE id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [account_id, userId]
  );
  if (!account) return fail(res, 'Cuenta no encontrada.', 'NOT_FOUND', 404);

  const amt = parseFloat(amount);
  if (parseFloat(account.balance) < amt) {
    return fail(res, 'Saldo insuficiente.', 'INSUFFICIENT_FUNDS', 422);
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const key = `${userId}_${account_id}_${amt}`;
  withdrawalCodes.set(key, { code, exp: Date.now() + 10 * 60 * 1000 });

  console.log(`[withdrawal-code] userId=${userId} account=${account_id} amount=${amt} code=${code}`);

  // Envío por correo REAL (no bloqueante: si falla, el código sigue válido y se loguea)
  sendMail({ to: email, ...tpl.otp({ userName: name, code, minutes: 10 }) });

  return ok(res, { message: 'Código enviado a tu correo registrado.' });
}));

// ─────────────────────────────────────────────────────────────────────────────
// POST /withdrawal/confirm
// ─────────────────────────────────────────────────────────────────────────────
router.post('/withdrawal/confirm', requireAuth, wrap(async (req, res) => {
  const { userId, tenantId, email, name } = req.session;
  const { account_id, amount, code, description } = req.body;

  if (!account_id || !amount || !code) {
    return fail(res, 'account_id, amount y code requeridos.', 'VALIDATION', 422);
  }

  const amt = parseFloat(amount);
  const key = `${userId}_${account_id}_${amt}`;
  const stored = withdrawalCodes.get(key);

  if (!stored) return fail(res, 'No hay un código pendiente para esta operación.', 'INVALID_CODE', 422);
  if (Date.now() > stored.exp) {
    withdrawalCodes.delete(key);
    return fail(res, 'El código expiró. Solicita uno nuevo.', 'INVALID_CODE', 422);
  }
  if (stored.code !== code.trim()) return fail(res, 'Código incorrecto.', 'INVALID_CODE', 422);

  withdrawalCodes.delete(key);

  const pool = tenantPool(tenantId);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [account] } = await client.query(
      `SELECT id, account_number, balance, currency, status FROM accounts WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [account_id, userId]
    );
    if (!account || account.status !== 'active') {
      await client.query('ROLLBACK');
      return fail(res, 'Cuenta no disponible.', 'NOT_FOUND', 404);
    }

    const fee = 0;
    const currentBalance = parseFloat(account.balance);
    if (currentBalance < amt + fee) {
      await client.query('ROLLBACK');
      return fail(res, 'Saldo insuficiente.', 'INSUFFICIENT_FUNDS', 422);
    }

    const newBalance = currentBalance - amt - fee;

    await client.query(`UPDATE accounts SET balance = $1, updated_at = NOW() WHERE id = $2`, [newBalance, account_id]);

    const { rows: [tx] } = await client.query(
      `INSERT INTO transactions
         (id, type, status, account_id, amount, currency, fee, balance_after, description, created_at, updated_at)
       VALUES ($1, 'withdrawal', 'completed', $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING *`,
      [uuidv4(), account_id, amt, account.currency, fee, newBalance, description || null]
    );

    await client.query('COMMIT');

    sendMail({ to: email, ...tpl.transfer({
      userName: name, amount: amt, currency: account.currency,
      toAccount: account.account_number, incoming: false,
    }) });

    return ok(res, formatTx(tx), 201);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[withdrawal] Error:', e.message);
    return fail(res, 'Error al procesar el retiro.', 'ERROR', 500);
  } finally {
    client.release();
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function formatTx(r) {
  return {
    id: r.id.toString(),
    type: r.type,
    status: r.status,
    account_id: r.account_id?.toString() || null,
    destination_account_id: r.destination_account_id?.toString() || null,
    amount: parseFloat(r.amount) || 0,
    converted_amount: r.converted_amount ? parseFloat(r.converted_amount) : null,
    currency: r.currency || 'COP',
    destination_currency: r.destination_currency || null,
    fee: parseFloat(r.fee) || 0,
    balance_after: parseFloat(r.balance_after) || 0,
    description: r.description || null,
    created_at: r.created_at ? r.created_at.toISOString() : null,
  };
}

module.exports = router;
