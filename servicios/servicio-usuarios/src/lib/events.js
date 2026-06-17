'use strict';
// Emisor de eventos de dominio in-process (costura del strangler).
// Hoy es un EventEmitter de Node sin consumidores obligatorios: la activación de
// vouchers publica VOUCHER_ACTIVATED / EMAIL_RESEND_REQUESTED de forma aditiva y
// no bloqueante. En la Fase 3 este emisor se reemplaza por un bus real
// (Postgres LISTEN/NOTIFY o cola) sin tocar a los productores.
const { EventEmitter } = require('events');

const domainEvents = new EventEmitter();
// Evitar que un listener defectuoso tumbe el proceso; los emits son best-effort.
domainEvents.setMaxListeners(50);

/**
 * Publica un evento de dominio sin propagar errores al flujo de negocio.
 * @param {string} eventName
 * @param {object} payload
 */
function emitDomainEvent(eventName, payload) {
  try {
    domainEvents.emit(eventName, payload);
  } catch (e) {
    console.error(`⚠️ Error emitiendo evento de dominio ${eventName}:`, e.message);
  }
}

module.exports = { domainEvents, emitDomainEvent };
