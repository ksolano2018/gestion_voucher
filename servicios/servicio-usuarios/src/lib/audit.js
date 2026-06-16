'use strict';
// Logging transversal de auditoría/seguridad. Único punto que escribe en
// system_events / transaction_events; los demás módulos lo usan, no tocan esas tablas.
const pool = require('../db/pool');

// Log de seguridad (solo consola, no bloqueante).
function logSecurityEvent(event, details) {
  const timestamp = new Date().toISOString();
  console.log(`[SECURITY] ${timestamp} - ${event}:`, JSON.stringify(details));
}

// Persiste un evento de sistema para auditoría (no lanza si falla).
async function logSystemEvent(eventType, eventCategory, userId, stripeCustomerId, purchaseId, eventData, status = 'SUCCESS', errorMessage = null, req = null) {
  try {
    const ipAddress = req ? req.ip : null;
    const userAgent = req ? req.get('user-agent') : null;

    await pool.query(
      `INSERT INTO system_events (event_type, event_category, user_id, stripe_customer_id, purchase_id, event_data, status, error_message, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [eventType, eventCategory, userId, stripeCustomerId, purchaseId, JSON.stringify(eventData), status, errorMessage, ipAddress, userAgent]
    );
    console.log(`✓ System event logged: ${eventType} (${eventCategory})`);
  } catch (e) {
    console.error('❌ Error logging system event:', e.message);
  }
}

// Persiste un cambio de estado de transacción (compra) para el rastro de auditoría.
async function logTransactionEvent(purchaseId, newStatus, previousStatus, eventType, stripeEventId, stripeEventData, paymentIntentId, partnerId, metadata = null) {
  try {
    await pool.query(
      `INSERT INTO transaction_events (purchase_id, partner_id, payment_intent_id, previous_status, new_status, event_type, stripe_event_id, stripe_event_data, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [purchaseId, partnerId, paymentIntentId, previousStatus, newStatus, eventType, stripeEventId, JSON.stringify(stripeEventData || {}), JSON.stringify(metadata || {})]
    );
    console.log(`✓ Transaction event logged: Purchase ${purchaseId} - ${previousStatus} → ${newStatus} (${eventType})`);
  } catch (e) {
    console.error('❌ Error logging transaction event:', e.message);
  }
}

module.exports = { logSecurityEvent, logSystemEvent, logTransactionEvent };
