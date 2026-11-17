'use strict';
// Middleware de validación de express-validator, compartido por todos los módulos.
const { validationResult } = require('express-validator');
const { logSecurityEvent } = require('./audit');

// Si alguien pega su contraseña por error en un campo de tipo "contraseña" o en
// "username" (que en este sistema siempre debe ser un email), ese valor crudo
// quedaba en texto plano tanto en la respuesta HTTP como en la auditoría (QA-32).
// Se enmascara antes de loguear/responder, sin tocar el resto del error.
function redactSensitiveValue(err) {
  const field = String(err.path || err.param || '').toLowerCase();
  const looksLikePassword = field.includes('password') || field.includes('contrasena') || field.includes('contraseña');
  const usernameNotEmail = field === 'username' && typeof err.value === 'string' && !err.value.includes('@');
  if (looksLikePassword || usernameNotEmail) {
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
