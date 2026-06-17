'use strict';
// Lógica de dominio de compras (purchases) reutilizable.
//
// `ensurePurchaseVouchers` es el ÚNICO punto que genera vouchers "estándar" de una
// compra pagada. Es atómico e idempotente: toma un advisory lock por compra y
// dentro de la misma transacción cuenta los vouchers existentes y crea solo los que
// faltan hasta `purchases.qty`. Esto evita la duplicación por concurrencia entre los
// distintos disparadores (polling /status, backfill al abrir vouchers/elegibilidad/
// activación, y los webhooks de Stripe), que antes hacían "contar y generar" sin
// serializar y se pisaban (ej.: comprar 10 y terminar con 15).
const crypto = require('crypto');
const pool = require('../../db/pool');

/**
 * Garantiza que la compra `purchaseId` tenga exactamente `qty` vouchers (crea los
 * faltantes). Atómico vía pg_advisory_xact_lock(purchaseId). Devuelve cuántos creó.
 */
async function ensurePurchaseVouchers(purchaseId) {
  const id = parseInt(purchaseId, 10);
  if (!Number.isInteger(id)) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializa a todos los generadores concurrentes para ESTA compra. El lock se
    // libera automáticamente al COMMIT/ROLLBACK de la transacción.
    await client.query('SELECT pg_advisory_xact_lock($1)', [id]);

    const pr = await client.query('SELECT partner_id, qty FROM purchases WHERE id=$1', [id]);
    if (pr.rowCount === 0) {
      await client.query('ROLLBACK');
      return 0;
    }
    const { partner_id, qty } = pr.rows[0];

    const cnt = await client.query('SELECT COUNT(*)::int AS c FROM vouchers WHERE purchase_id=$1', [id]);
    const missing = Math.max((qty || 0) - cnt.rows[0].c, 0);

    for (let i = 0; i < missing; i++) {
      const code = crypto.randomBytes(6).toString('hex').toUpperCase();
      await client.query(
        'INSERT INTO vouchers (partner_id, purchase_id, code, status) VALUES ($1, $2, $3, $4)',
        [partner_id, id, code, 'AVAILABLE']
      );
    }

    await client.query('COMMIT');
    return missing;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Rellena los vouchers faltantes de todas las compras pagadas de un partner.
 * Delega en `ensurePurchaseVouchers` (atómico) por cada compra.
 */
async function backfillPaidPurchaseVouchers(partnerId) {
  const paidPurchases = await pool.query(
    `SELECT id
     FROM purchases
     WHERE partner_id=$1
       AND (status='PAID' OR stripe_status IN ('succeeded', 'paid'))`,
    [partnerId]
  );

  let generated = 0;
  for (const p of paidPurchases.rows) {
    generated += await ensurePurchaseVouchers(p.id);
  }
  return generated;
}

module.exports = { ensurePurchaseVouchers, backfillPaidPurchaseVouchers };
