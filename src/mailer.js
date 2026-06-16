const nodemailer = require('nodemailer');

/**
 * Servicio de correo real vía SMTP (Gmail por defecto).
 *
 * Configuración por variables de entorno:
 *   SMTP_HOST      smtp.gmail.com
 *   SMTP_PORT      465  (SSL)  ó  587 (STARTTLS)
 *   SMTP_SECURE    true para 465, false para 587
 *   SMTP_USER      tu-cuenta@gmail.com
 *   SMTP_PASS      contraseña de aplicación de 16 caracteres (NO la normal)
 *   MAIL_FROM      "BankOs <tu-cuenta@gmail.com>"
 *
 * El correo del ADMINISTRADOR no se configura aquí: se obtiene de la tabla
 * `users` de cada banco (tenant) buscando el rol 'administrador'. Ver
 * db.js → tenantAdminEmail().
 *
 * IMPORTANTE para Gmail: hay que generar una "Contraseña de aplicación"
 * en https://myaccount.google.com/apppasswords (requiere verificación en 2 pasos).
 * La contraseña normal NO funciona con SMTP desde 2022.
 */

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465');
const SMTP_SECURE = (process.env.SMTP_SECURE || 'true') === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || `BankOs <${SMTP_USER}>`;

let transporter = null;
let mailEnabled = false;

if (SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    // secure=true solo para el puerto 465 (SSL directo).
    // Para 587 debe ir secure=false y nodemailer hace STARTTLS solo.
    secure: SMTP_SECURE,
    requireTLS: !SMTP_SECURE, // fuerza STARTTLS cuando NO es 465
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
  });
  mailEnabled = true;

  transporter.verify().then(
    () => console.log(`📧 SMTP listo (${SMTP_HOST}:${SMTP_PORT} secure=${SMTP_SECURE} como ${SMTP_USER})`),
    (err) => console.warn(
      `⚠️  SMTP no verificó: ${err.message}\n` +
      `   Revisa: (1) SMTP_PASS debe ser una contraseña de aplicación de Gmail (16 chars, sin espacios),\n` +
      `   (2) si el puerto 465 da timeout, prueba SMTP_PORT=587 con SMTP_SECURE=false,\n` +
      `   (3) verifica que el VPS permita salida en ese puerto (egress firewall).`
    )
  );
} else {
  console.warn(
    '⚠️  SMTP sin credenciales: falta SMTP_USER o SMTP_PASS. Los correos se loguearán en consola.\n' +
    '   Para Gmail necesitas una contraseña de aplicación: https://myaccount.google.com/apppasswords'
  );
}

/**
 * Envía un correo. Si SMTP no está configurado, lo registra en consola
 * (modo degradado) para que el sistema nunca se caiga por falta de correo.
 */
async function sendMail({ to, subject, html, text }) {
  if (!mailEnabled) {
    console.log(`📧 [SIN-SMTP] Para: ${to} | Asunto: ${subject}\n${text || html}`);
    return { simulated: true };
  }
  try {
    const info = await transporter.sendMail({
      from: MAIL_FROM,
      to,
      subject,
      text: text || undefined,
      html: html || undefined,
    });
    console.log(`📧 Enviado a ${to}: ${info.messageId}`);
    return { messageId: info.messageId };
  } catch (e) {
    // Nunca lanzamos: un fallo de correo no debe tumbar la operación bancaria.
    console.error(`📧 Error enviando a ${to}: ${e.message}`);
    return { error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plantillas
// ─────────────────────────────────────────────────────────────────────────────

const wrap = (title, body) => `
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;background:#0f1b3d;border-radius:16px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#3b5bdb,#7048e8);padding:24px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:22px">🏦 BankOs</h1>
  </div>
  <div style="padding:28px;color:#e7ebff">
    <h2 style="color:#fff;font-size:18px;margin-top:0">${title}</h2>
    ${body}
  </div>
  <div style="padding:16px;text-align:center;color:#8b9bd4;font-size:11px;border-top:1px solid #1e2d5c">
    Este es un correo automático de BankOs. No respondas a este mensaje.
  </div>
</div>`;

function tplOtp({ userName, code, minutes }) {
  return {
    subject: 'Tu código de retiro — BankOs',
    text: `Hola ${userName}, tu código de retiro es ${code}. Vence en ${minutes} minutos. Si no solicitaste este retiro, ignora este correo.`,
    html: wrap('Código de confirmación de retiro', `
      <p>Hola <b>${userName}</b>,</p>
      <p>Para confirmar tu retiro usa este código de verificación:</p>
      <div style="background:#1e2d5c;border-radius:12px;padding:18px;text-align:center;margin:18px 0">
        <span style="font-size:34px;letter-spacing:10px;color:#74c0fc;font-weight:bold">${code}</span>
      </div>
      <p style="color:#8b9bd4">Este código vence en <b>${minutes} minutos</b>. Si no solicitaste este retiro, ignora este correo y revisa la seguridad de tu cuenta.</p>
    `),
  };
}

function tplWelcome({ userName, bankName, accountNumber }) {
  return {
    subject: `Bienvenido a ${bankName} — BankOs`,
    text: `Hola ${userName}, tu cuenta en ${bankName} fue creada con éxito. Número de cuenta: ${accountNumber}.`,
    html: wrap('¡Cuenta creada con éxito!', `
      <p>Hola <b>${userName}</b>,</p>
      <p>Tu cuenta en <b>${bankName}</b> ha sido creada correctamente. Ya puedes operar desde la app.</p>
      <div style="background:#1e2d5c;border-radius:12px;padding:16px;margin:18px 0">
        <p style="margin:0;color:#8b9bd4;font-size:12px">Número de cuenta</p>
        <p style="margin:4px 0 0;font-size:20px;color:#fff;font-weight:bold;letter-spacing:1px">${accountNumber}</p>
      </div>
      <p style="color:#8b9bd4">Si tú no creaste esta cuenta, contáctanos de inmediato.</p>
    `),
  };
}

function tplAdminNewUser({ userName, userEmail, bankName, accountNumber }) {
  return {
    subject: `Nuevo cliente registrado en ${bankName}`,
    text: `Nuevo registro en ${bankName}: ${userName} (${userEmail}), cuenta ${accountNumber}.`,
    html: wrap('Nuevo cliente registrado', `
      <p>Se registró un nuevo cliente en <b>${bankName}</b>:</p>
      <ul style="color:#e7ebff;line-height:1.8">
        <li><b>Nombre:</b> ${userName}</li>
        <li><b>Correo:</b> ${userEmail}</li>
        <li><b>Cuenta:</b> ${accountNumber}</li>
        <li><b>Fecha:</b> ${new Date().toLocaleString('es-CO')}</li>
      </ul>
    `),
  };
}

function tplPqrsUser({ userName, type, subject }) {
  return {
    subject: 'Recibimos tu PQRS — BankOs',
    text: `Hola ${userName}, recibimos tu ${type}: "${subject}". Te responderemos pronto.`,
    html: wrap('Recibimos tu solicitud', `
      <p>Hola <b>${userName}</b>,</p>
      <p>Hemos recibido tu <b>${type}</b> con el asunto:</p>
      <div style="background:#1e2d5c;border-radius:12px;padding:14px;margin:14px 0;color:#fff">${subject}</div>
      <p style="color:#8b9bd4">Nuestro equipo la revisará y te responderá por este medio. Gracias por contactarnos.</p>
    `),
  };
}

function tplPqrsAdmin({ userName, userEmail, type, subject, message }) {
  return {
    subject: `Nueva PQRS (${type}) — ${subject}`,
    text: `Nueva PQRS de ${userName} (${userEmail}). Tipo: ${type}. Asunto: ${subject}. Mensaje: ${message}`,
    html: wrap('Nueva PQRS recibida', `
      <ul style="color:#e7ebff;line-height:1.8">
        <li><b>Cliente:</b> ${userName} (${userEmail})</li>
        <li><b>Tipo:</b> ${type}</li>
        <li><b>Asunto:</b> ${subject}</li>
      </ul>
      <p style="color:#8b9bd4;margin-bottom:4px">Mensaje:</p>
      <div style="background:#1e2d5c;border-radius:12px;padding:14px;color:#fff">${message}</div>
    `),
  };
}

function tplTransfer({ userName, amount, currency, toAccount, toBank, incoming }) {
  const title = incoming ? 'Recibiste una transferencia' : 'Transferencia enviada';
  const verb = incoming ? 'Recibiste' : 'Enviaste';
  return {
    subject: `${title} — BankOs`,
    text: `Hola ${userName}, ${verb.toLowerCase()} ${amount} ${currency} ${incoming ? 'en' : 'a'} la cuenta ${toAccount}${toBank ? ' del banco ' + toBank : ''}.`,
    html: wrap(title, `
      <p>Hola <b>${userName}</b>,</p>
      <p>${verb} una transferencia por:</p>
      <div style="background:#1e2d5c;border-radius:12px;padding:18px;text-align:center;margin:16px 0">
        <span style="font-size:28px;color:#69db7c;font-weight:bold">${amount} ${currency}</span>
      </div>
      <p style="color:#8b9bd4">${incoming ? 'Origen' : 'Destino'}: cuenta <b>${toAccount}</b>${toBank ? ` · banco <b>${toBank}</b>` : ''}.</p>
    `),
  };
}

module.exports = {
  sendMail,
  mailEnabled,
  tpl: {
    otp: tplOtp,
    welcome: tplWelcome,
    adminNewUser: tplAdminNewUser,
    pqrsUser: tplPqrsUser,
    pqrsAdmin: tplPqrsAdmin,
    transfer: tplTransfer,
  },
};
