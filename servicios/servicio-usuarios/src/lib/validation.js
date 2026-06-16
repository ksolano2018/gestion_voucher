'use strict';
// Middleware de validación de express-validator, compartido por todos los módulos.
const { validationResult } = require('express-validator');
const { logSecurityEvent } = require('./audit');

function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logSecurityEvent('VALIDATION_ERROR', { errors: errors.array(), ip: req.ip });
    return res.status(400).json({ error: 'Datos inválidos', details: errors.array() });
  }
  next();
}

module.exports = { handleValidationErrors };
