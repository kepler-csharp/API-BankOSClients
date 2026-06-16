const { Pool } = require('pg');

const BASE = {
  host: process.env.DB_HOST || '87.99.154.103',
  port: parseInt(process.env.DB_PORT || '5433'),
  user: process.env.DB_USER || 'bankos',
  password: process.env.DB_PASS || 'secret',
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

// Pool central (bankos_central)
const central = new Pool({ ...BASE, database: 'bankos_central' });

// Cache de pools por tenant
const tenantPools = {};

/**
 * Devuelve (y cachea) un Pool de conexión para un tenant específico.
 * La DB se llama tenant_{tenantId}
 */
function tenantPool(tenantId) {
  const db = `tenant_${tenantId}`;
  if (!tenantPools[db]) {
    tenantPools[db] = new Pool({ ...BASE, database: db });
  }
  return tenantPools[db];
}

/**
 * Obtiene el correo del ADMINISTRADOR de un banco (tenant).
 *
 * El administrador es un registro en la tabla `users` del propio tenant con
 * rol 'administrador'. Un cliente le hace la PQRS (y avisos de registro) al
 * admin de SU banco, así que el correo se resuelve aquí desde la base del
 * tenant, NO desde variables de entorno ni desde bankos_central.
 *
 * Si hubiera varios administradores, devuelve el más antiguo (el principal).
 * Devuelve null si el tenant no tiene administrador (en ese caso simplemente
 * no se envía el aviso, sin romper la operación).
 */
async function tenantAdminEmail(tenantId) {
  try {
    const pool = tenantPool(tenantId);
    const { rows } = await pool.query(
      `SELECT email FROM users
       WHERE role = 'administrador'
       ORDER BY created_at ASC
       LIMIT 1`
    );
    return rows[0]?.email || null;
  } catch (e) {
    console.warn(`[tenantAdminEmail] No se pudo obtener admin de ${tenantId}:`, e.message);
    return null;
  }
}

module.exports = { central, tenantPool, tenantAdminEmail };
