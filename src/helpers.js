/**
 * Envuelve la respuesta en el formato que espera Flutter:
 * { success: true, data: ... }
 */
function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

/**
 * Error estructurado que el ApiClient de Flutter sabe parsear:
 * { success: false, error: { code, message } }
 */
function fail(res, message, code = 'ERROR', status = 400) {
  return res.status(status).json({ success: false, error: { code, message } });
}

/**
 * Wrapper global de errores async para rutas Express.
 */
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { ok, fail, wrap };
