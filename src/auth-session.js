const { v4: uuidv4 } = require('uuid');

// Sesiones en memoria: token -> { userId, tenantId, email, name, role, exp }
// Para producción usaría Redis, pero para este scope es suficiente.
const sessions = new Map();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

function createSession({ userId, tenantId, email, name, role }) {
  const token = uuidv4() + '-' + uuidv4();
  const exp = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { userId, tenantId, email, name, role, exp });
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.exp) {
    sessions.delete(token);
    return null;
  }
  return s;
}

// Middleware: extrae Bearer token y adjunta la sesión a req
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Sesión inválida o expirada.' },
    });
  }

  // El tenant del header DEBE coincidir con el de la sesión
  const headerTenant = req.headers['x-tenant-id'];
  if (headerTenant && headerTenant !== session.tenantId) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Tenant no coincide con la sesión.' },
    });
  }

  req.session = session;
  req.token = token;
  next();
}

module.exports = { createSession, destroySession, getSession, requireAuth };
