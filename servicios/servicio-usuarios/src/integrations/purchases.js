'use strict';
// Cliente del microservicio servicio-compras.
// La activación (módulo vouchers) ya no genera vouchers localmente: pide a
// servicio-compras que rellene los vouchers de las compras pagadas del partner.
// Mantiene la firma `backfillPaidPurchaseVouchers(partnerId)` para no tocar los
// call-sites. Best-effort: nunca lanza (si compras no responde, la activación
// sigue con los vouchers ya existentes).
const COMPRAS_URL = (process.env.COMPRAS_URL || 'http://servicio-compras:8085').replace(/\/$/, '');
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || '';

async function backfillPaidPurchaseVouchers(partnerId) {
  try {
    const headers = {};
    if (INTERNAL_API_TOKEN) headers['x-internal-token'] = INTERNAL_API_TOKEN;
    const resp = await fetch(`${COMPRAS_URL}/internal/backfill/${encodeURIComponent(partnerId)}`, {
      method: 'POST',
      headers,
    });
    if (!resp.ok) {
      console.error(`⚠️ servicio-compras backfill respondió ${resp.status} (partner ${partnerId})`);
      return 0;
    }
    const data = await resp.json().catch(() => ({}));
    return data.generated || 0;
  } catch (e) {
    console.error('⚠️ Error llamando a servicio-compras (backfill):', e.message);
    return 0;
  }
}

module.exports = { backfillPaidPurchaseVouchers };
