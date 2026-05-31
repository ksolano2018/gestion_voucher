# 📋 Implementación: Sistema de Eventos de Transacción

## Descripción General

Se ha implementado un sistema completo de auditoría y seguimiento de transacciones que permite:
1. **Sincronización de usuarios con Stripe** - Cada usuario en Stripe se sincroniza automáticamente con la aplicación
2. **Dos identificadores únicos** - Un ID de la aplicación y uno de Stripe para cada usuario/partner
3. **Eventos de transacción** - Registro detallado de todos los cambios de estado de una transacción
4. **Visibilidad para Partners** - Los partners pueden ver el historial de sus transacciones
5. **Visibilidad para Admin** - El administrador puede ver todas las transacciones del sistema

---

## 🗄️ Nueva Tabla: `transaction_events`

```sql
CREATE TABLE transaction_events (
  id SERIAL PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  partner_id INTEGER REFERENCES partners(id),
  payment_intent_id VARCHAR(200),
  previous_status VARCHAR(50),
  new_status VARCHAR(50) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  stripe_event_id VARCHAR(200),
  stripe_event_data JSONB,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Propósito
- Registra cada cambio de estado de una transacción
- Almacena datos del evento de Stripe original
- Permite auditoría completa del flujo de pago

### Índices
- `idx_transaction_events_purchase` - Para búsquedas rápidas por compra
- `idx_transaction_events_partner` - Para búsquedas rápidas por partner
- `idx_transaction_events_created` - Para ordenamiento por fecha

---

## 🔧 Funciones Implementadas

### `logTransactionEvent()`
```javascript
async function logTransactionEvent(
  purchaseId,           // ID de la compra
  newStatus,            // Nuevo estado (PAID, FAILED, REFUNDED, etc)
  previousStatus,       // Estado anterior
  eventType,            // Tipo de evento Stripe
  stripeEventId,        // ID del evento en Stripe
  stripeEventData,      // Datos completos del evento
  paymentIntentId,      // ID del payment intent
  partnerId,            // ID del partner
  metadata              // Datos adicionales (monto, moneda, etc)
)
```

**Uso**: Se llama en cada caso del webhook cuando hay cambio de estado

---

## 🌐 Nuevos Endpoints del Webhook

El webhook se mejoró para registrar eventos en `transaction_events` para los siguientes casos:

### Casos de Pago Registrados
1. ✅ `payment_intent.succeeded` - Pago exitoso
2. ⏳ `payment_intent.processing` - Pago en procesamiento
3. ⚠️ `payment_intent.requires_action` - Requiere acción (3D Secure, etc)
4. ❌ `payment_intent.canceled` - Pago cancelado
5. 💔 `payment_intent.payment_failed` - Pago fallido
6. 💳 `charge.refunded` - Reembolso procesado
7. 🛒 `checkout.session.completed` - Sesión de checkout completada

---

## 📊 API Endpoints - PARTNER

### 1. Ver Historial de Transacción de una Compra
```
GET /partner/:id/purchases/:purchaseId/transaction-history

Autorización: Partner dueño o Admin
Respuesta: Array de eventos de transacción ordenados cronológicamente
```

**Ejemplo de respuesta:**
```json
{
  "purchase_id": 1,
  "events": [
    {
      "id": 1,
      "purchase_id": 1,
      "previous_status": "PENDING",
      "new_status": "PAID",
      "event_type": "payment_intent.succeeded",
      "stripe_event_id": "evt_xxx",
      "metadata": {
        "amount": 199.00,
        "currency": "usd"
      },
      "created_at": "2026-03-04T10:30:00Z"
    }
  ]
}
```

### 2. Ver Todos los Eventos de Transacción del Partner
```
GET /partner/:id/transaction-events?page=1&limit=50

Autorización: Partner dueño o Admin
Parámetros:
  - page: Número de página (default: 1)
  - limit: Resultados por página (default: 50)
  
Respuesta: Array de eventos con paginación
```

**Ejemplo de respuesta:**
```json
{
  "events": [
    {
      "id": 1,
      "purchase_id": 1,
      "previous_status": "PENDING",
      "new_status": "PAID",
      "event_type": "payment_intent.succeeded",
      "stripe_event_id": "evt_xxx",
      "created_at": "2026-03-04T10:30:00Z",
      "purchase_id": 1,
      "total_price": 199.00,
      "qty": 5
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 100,
    "pages": 2
  }
}
```

---

## 📊 API Endpoints - ADMIN

### 1. Ver Todos los Eventos de Transacción
```
GET /admin/transaction-events
  ?page=1
  &limit=50
  &purchase_id=1
  &partner_id=1
  &event_type=payment_intent.succeeded
  &status=PAID

Autorización: Admin
Parámetros (todos opcionales):
  - page: Número de página
  - limit: Resultados por página
  - purchase_id: Filtrar por compra
  - partner_id: Filtrar por partner
  - event_type: Filtrar por tipo de evento
  - status: Filtrar por estado final (PAID, FAILED, etc)
  
Respuesta: Array de eventos con información completa
```

**Ejemplo de respuesta:**
```json
{
  "events": [
    {
      "id": 1,
      "purchase_id": 1,
      "partner_id": 1,
      "payment_intent_id": "pi_xxx",
      "previous_status": "PENDING",
      "new_status": "PAID",
      "event_type": "payment_intent.succeeded",
      "stripe_event_id": "evt_xxx",
      "created_at": "2026-03-04T10:30:00Z",
      "total_price": 199.00,
      "qty": 5,
      "purchase_status": "PAID",
      "partner_name": "Demo Partner",
      "partner_email": "partner@certjoin.com"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 500,
    "pages": 10
  }
}
```

### 2. Ver Historial de Transacción de una Compra (Admin)
```
GET /admin/purchases/:purchaseId/transaction-history

Autorización: Admin
Respuesta: Historial completo con datos de Stripe
```

**Ejemplo de respuesta:**
```json
{
  "purchase_id": 1,
  "partner_id": 5,
  "events": [
    {
      "id": 1,
      "purchase_id": 1,
      "previous_status": null,
      "new_status": "PENDING",
      "event_type": "checkout.session.completed",
      "stripe_event_id": "evt_xxx",
      "stripe_event_data": { /* Datos completos del evento Stripe */ },
      "metadata": {
        "session_id": "cs_xxx",
        "amount": 199.00,
        "currency": "usd"
      },
      "created_at": "2026-03-04T10:30:00Z"
    },
    {
      "id": 2,
      "purchase_id": 1,
      "previous_status": "PENDING",
      "new_status": "PAID",
      "event_type": "payment_intent.succeeded",
      "stripe_event_id": "evt_yyy",
      "metadata": {
        "amount": 199.00,
        "currency": "usd"
      },
      "created_at": "2026-03-04T10:31:00Z"
    }
  ]
}
```

### 3. Resumen de Eventos de Transacción (Dashboard)
```
GET /admin/transaction-events/summary

Autorización: Admin
Respuesta: Conteos por estado, partners únicos y compras únicas
```

**Ejemplo de respuesta:**
```json
{
  "status_summary": [
    {
      "new_status": "PAID",
      "count": 450,
      "unique_partners": 45,
      "unique_purchases": 100
    },
    {
      "new_status": "FAILED",
      "count": 30,
      "unique_partners": 15,
      "unique_purchases": 30
    },
    {
      "new_status": "REFUNDED",
      "count": 20,
      "unique_partners": 10,
      "unique_purchases": 20
    }
  ],
  "total_events": 500,
  "events_24h": 75
}
```

---

## 🔄 Flujo de Sincronización de Usuarios Stripe

### Cuando se crea un usuario en Stripe:
1. Se recibe evento `customer.created` en el webhook
2. Se ejecuta `upsertPartnerAndUserFromStripeCustomer()`
3. Se sincroniza con la tabla `users` (con `stripe_customer_id`)
4. Se sincroniza con la tabla `stripe_customers`
5. Se registra en `system_events` con categoría `STRIPE_SYNC`

### Identificadores:
- **App ID**: `users.id` (SERIAL, único en aplicación)
- **Stripe ID**: `users.stripe_customer_id` (VARCHAR, viene de Stripe)

### Relaciones:
```
User (app_id + stripe_id) → Partner → Purchases → TransactionEvents
```

---

## 📈 Estados de Transacción Registrados

| Estado | Descripción | Eventos |
|--------|-------------|---------|
| `PENDING` | Esperando pago o confirmación | `payment_intent.processing`, `payment_intent.requires_action` |
| `PAID` | Pago completado exitosamente | `payment_intent.succeeded`, `checkout.session.completed` |
| `FAILED` | Pago fallido o cancelado | `payment_intent.payment_failed`, `payment_intent.canceled` |
| `REFUNDED` | Reembolso procesado | `charge.refunded` |

---

## 🔍 Consultas Útiles

### Partners: Ver estado actual de todas sus compras
```sql
SELECT 
  p.id,
  p.total_price,
  (SELECT new_status FROM transaction_events WHERE purchase_id = p.id ORDER BY created_at DESC LIMIT 1) as current_status,
  (SELECT MAX(created_at) FROM transaction_events WHERE purchase_id = p.id) as last_update
FROM purchases p
WHERE p.partner_id = :partner_id
ORDER BY last_update DESC;
```

### Admin: Compras por estado en últimas 24h
```sql
SELECT 
  new_status,
  COUNT(*) as count
FROM transaction_events
WHERE created_at >= NOW() - INTERVAL '24 hours'
GROUP BY new_status;
```

### Admin: Partners con más pagos fallidos
```sql
SELECT 
  pt.id,
  pt.name,
  COUNT(*) as failed_payments
FROM transaction_events te
JOIN partners pt ON te.partner_id = pt.id
WHERE te.new_status = 'FAILED'
GROUP BY pt.id, pt.name
ORDER BY failed_payments DESC
LIMIT 10;
```

---

## 🧪 Testing

### Simular evento de pago exitoso:
```bash
curl -X POST http://localhost:8081/webhook/stripe \
  -H "Content-Type: application/json" \
  -H "stripe-signature: test" \
  -d '{
    "id": "evt_test_123",
    "type": "payment_intent.succeeded",
    "data": {
      "object": {
        "id": "pi_test_123",
        "amount": 29900,
        "currency": "usd",
        "metadata": { "purchase_id": "1" }
      }
    }
  }'
```

### Consultar historial de una compra:
```bash
curl -X GET http://localhost:8081/admin/purchases/1/transaction-history \
  -H "Authorization: Bearer $TOKEN"
```

---

## 🔐 Seguridad

- ✅ Endpoints de partner requieren que el usuario pertenezca al partner
- ✅ Endpoints de admin solo accesibles con rol `admin`
- ✅ Rate limiting en endpoints de lectura
- ✅ Los datos de Stripe se almacenan en JSONB para auditoría completa
- ✅ Transacciones atómicas para mantener consistencia de datos

---

## 📝 Próximos Pasos (Opcional)

1. **Notificaciones**: Enviar email/SMS cuando hay cambios de estado críticos
2. **Webhooks propios**: Permitir que partners registren webhooks para eventos
3. **Métricas**: Dashboard en tiempo real de tasas de éxito/fracaso
4. **Alertas**: Alertar al admin si hay muchos fallos en corto tiempo
5. **Exportar**: Permitir export de transacciones a CSV/Excel

---

## 📞 Contacto

Para dudas sobre la implementación, consultar la documentación de Stripe en:
https://stripe.com/docs/webhooks
