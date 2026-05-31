# ⚡ Inicio Rápido: Flujo Stripe-First

## 🎯 5 Comandos para Empezar

### 1️⃣ Iniciar Webhook Forwarding
```bash
stripe listen --forward-to http://localhost:8081/webhook/stripe
```
**Output esperado:**
```
> Ready! Your webhook signing secret is whsec_xxxxxxxxxxxxx
```

### 2️⃣ Copiar Webhook Secret
Copia el `whsec_xxxxxxxxxxxxx` del paso anterior y agrégalo a tu `.env`:

```env
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx
```

### 3️⃣ Reiniciar Docker
```bash
docker compose restart servicio-usuarios
```

### 4️⃣ Crear Producto en Stripe
Ve a: https://dashboard.stripe.com/test/products
- Click "Add product"
- Name: **Curso Demo**
- Price: **$10.00**
- Click "Save"

### 5️⃣ Crear Payment Link
Ve a: https://dashboard.stripe.com/test/payment-links
- Click "New"
- Selecciona tu producto
- Success URL: `http://localhost:3000?checkout=success`
- Click "Create link"
- **Copia el link** (ej: `https://buy.stripe.com/test_xxxxxxxxxxxxx`)

---

## 🧪 Probar el Flujo

### Opción A: Compra Real
1. Abre el **Payment Link** en tu navegador
2. Completa:
   - Email: cualquiera
   - Card: `4242 4242 4242 4242`
   - Expiry: `12/25`
   - CVC: `123`
3. Click "Pay"
4. Ve a **Admin Dashboard** → **Historial de Compras**
5. Verás la nueva compra con detalle de line items y vouchers 🎉

### Opción B: Simular con CLI
```bash
stripe trigger checkout.session.completed
```
Esto enviará un evento de prueba a tu webhook.

---

## 📊 Verificar Datos

### Ver en el Admin Dashboard
1. Login como admin con las credenciales configuradas localmente
2. Click en "Historial de Compras"
3. Deberías ver:
   - ✅ Estado de pago (Pagado/Pendiente/Fallido)
   - 📦 Detalle de line items
   - 🎫 Vouchers generados (si pagó)

### Ver en la Base de Datos
```bash
docker exec -it proyecto-db psql -U admin -d proyectodb
```

```sql
-- Customers de Stripe
SELECT * FROM stripe_customers;

-- Compras con payment_intent
SELECT id, partner_id, qty, total_price, stripe_status, payment_intent_id 
FROM purchases 
ORDER BY created_at DESC 
LIMIT 5;

-- Productos individuales
SELECT * FROM stripe_line_items;

-- Vouchers generados
SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 10;
```

---

## 🔍 Logs en Tiempo Real

### Ver logs del webhook
```bash
docker logs -f servicio-usuarios
```

Cuando se procese una compra, verás:
```
📨 Stripe Webhook received: checkout.session.completed
📦 Processing Stripe purchase: { customer: 'cus_xxx', email: '...', amount: 10 }
💼 Customer saved: { customerId: 1, partnerId: 1 }
🛍️ Line items: 1
💰 Purchase created: 1
✅ Line items saved
🎫 Generating vouchers... 1
🎉 Vouchers generated: 1
```

---

## 📦 Estructura de Datos

### Compra Completa
```
purchases
  ├─ id: 1
  ├─ partner_id: 1
  ├─ qty: 2 (suma de todos los productos)
  ├─ total_price: 20.00
  ├─ stripe_status: "succeeded"
  ├─ payment_intent_id: "pi_xxxxxxxxxxxxx"
  └─ line_items:
       ├─ [0] Curso Demo (x2) - $20.00
       └─ ...
```

### Vouchers Generados
```
vouchers
  ├─ id: 1
  ├─ partner_id: 1
  ├─ purchase_id: 1
  ├─ code: "A1B2C3D4"
  └─ status: "AVAILABLE"
```

---

## 🚨 Problemas Comunes

### ❌ "Webhook signature verification failed"
**Solución**: Actualiza `STRIPE_WEBHOOK_SECRET` en `.env` con el valor de `stripe listen`.

### ❌ "Line items no aparecen"
**Solución**: Ya está implementado, asegúrate de usar el webhook correcto (`checkout.session.completed`).

### ❌ "Vouchers no se generan"
**Solución**: Solo se generan si `payment_status = 'paid'`. Usa tarjeta válida de prueba.

---

## 📚 Más Información

- **Guía Completa**: [STRIPE_WEBHOOK_FLOW.md](./STRIPE_WEBHOOK_FLOW.md)
- **Cambios Técnicos**: [STRIPE_CHANGES_V2.md](./STRIPE_CHANGES_V2.md)
- **Stripe Testing**: https://stripe.com/docs/testing

---

## ✅ Checklist

- [ ] Stripe CLI instalado y autenticado
- [ ] `stripe listen` corriendo en terminal
- [ ] `STRIPE_WEBHOOK_SECRET` en `.env`
- [ ] Docker reiniciado
- [ ] Producto creado en Stripe Dashboard
- [ ] Payment Link generado
- [ ] Compra de prueba completada
- [ ] Datos visibles en Admin Dashboard

---

**¡Listo! Tu app ahora recibe compras directamente desde Stripe 🚀**
