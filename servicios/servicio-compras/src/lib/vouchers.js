'use strict';
// Generación de códigos de voucher. Helper compartido por el módulo de compras
// (cortesía / compra externa / ajuste) y por la activación de vouchers.
const crypto = require('crypto');

function generateVoucherCode() {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

module.exports = { generateVoucherCode };
