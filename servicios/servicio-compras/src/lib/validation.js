'use strict';
// Middleware de validación de express-validator, compartido por todos los módulos.
const { validationResult } = require('express-validator');
const { logSecurityEvent } = require('./audit');

// Mismo criterio que servicio-usuarios/src/lib/validation.js (QA-32): nunca loguear ni
// responder en claro un valor de un campo de tipo contraseña.
function redactSensitiveValue(err) {
  const field = String(err.path || err.param || '').toLowerCase();
  const looksLikePassword = field.includes('password') || field.includes('contrasena') || field.includes('contraseña');
  if (looksLikePassword) {
    return { ...err, value: '[redactado]' };
  }
  return err;
}

function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const safeErrors = errors.array().map(redactSensitiveValue);
    logSecurityEvent('VALIDATION_ERROR', { errors: safeErrors, ip: req.ip });
    return res.status(400).json({ error: 'Datos inválidos', details: safeErrors });
  }
  next();
}

module.exports = { handleValidationErrors };
