'use strict';
// Lógica de dominio de compras (purchases) reutilizable.
// `backfillPaidPurchaseVouchers` la consumen tanto las rutas de compras como las
// de activación de vouchers (supernodo aún inline en app.js): genera los vouchers
// faltantes de las compras ya pagadas de un partner. Idempotente.
const crypto = require('crypto');
const pool = require('../../db/pool');

async function backfillPaidPurchaseVouchers(partnerId) {
  const paidPurchases = await pool.query(
    `SELECT id, partner_id, qty
     FROM purchases
     WHERE partner_id=$1
       AND (status='PAID' OR stripe_status IN ('succeeded', 'paid'))`,
    [partnerId]
  );

  let generated = 0;
  for (const p of paidPurchases.rows) {
    const existing = await pool.query('SELECT COUNT(*) AS cnt FROM vouchers WHERE purchase_id=$1', [p.id]);
    const currentCount = parseInt(existing.rows[0].cnt, 10) || 0;
    const missing = Math.max((p.qty || 0) - currentCount, 0);

    for (let i = 0; i < missing; i++) {
      const code = crypto.randomBytes(6).toString('hex').toUpperCase();
      await pool.query(
        'INSERT INTO vouchers (partner_id, purchase_id, code, status) VALUES ($1, $2, $3, $4)',
        [p.partner_id, p.id, code, 'AVAILABLE']
      );
      generated += 1;
    }
  }

  return generated;
}

module.exports = { backfillPaidPurchaseVouchers };
