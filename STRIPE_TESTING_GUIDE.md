# 🧪 Testing de Pagos con Stripe

> **Nota de vigencia:** el flujo real de la app es **carrito → Checkout Session** (no payment
> links manuales). Los pagos y el webhook los procesa el microservicio **`servicio-compras`**,
> al que se llega **por el gateway**: el webhook entra por `http://localhost:3000/webhook/stripe`
> (Caddy lo enruta a `servicio-compras:8085`). Para ver los logs del webhook usa
> `docker compose logs -f servicio-compras`. Los ejemplos con payment links de abajo siguen
> sirviendo para probar la integración/webhook de forma aislada.

## ✅ Requisitos Previos

Antes de empezar, asegúrate de tener:
- [x] Docker corriendo (todos los contenedores UP)
- [x] Stripe CLI instalado y autenticado
- [x] Claves de Stripe en `.env` (pk_test_, sk_test_)
- [x] `stripe listen` corriendo en una terminal
- [x] `STRIPE_WEBHOOK_SECRET` configurado en `.env`

---

## 🎯 Test 1: Simular Webhook con Stripe CLI

### Paso 1: Simular Evento
```bash
stripe trigger checkout.session.completed
```

### Paso 2: Verificar Logs
```bash
docker logs -f servicio-usuarios
```

**Output esperado:**
```
📨 Stripe Webhook received: checkout.session.completed
📦 Processing Stripe purchase: { customer: 'cus_test123', email: 'jenny.rosen@example.com', ... }
💼 Customer saved: { customerId: 1, partnerId: 1 }
🛍️ Line items: 1
💰 Purchase created: 1
✅ Line items saved
🎫 Generating vouchers... 1
🎉 Vouchers generated: 1
```

### Paso 3: Verificar en BD
```bash
docker exec -it proyecto-db psql -U admin -d proyectodb
```

```sql
-- Ver customer creado
SELECT * FROM stripe_customers ORDER BY created_at DESC LIMIT 1;

-- Ver compra creada
SELECT * FROM purchases ORDER BY created_at DESC LIMIT 1;

-- Ver line items
SELECT * FROM stripe_line_items ORDER BY created_at DESC LIMIT 5;

-- Ver vouchers
SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 5;
```

### Paso 4: Verificar en Frontend
1. Abrir http://localhost:3000
2. Login con las credenciales admin configuradas localmente
3. Click en **"Historial de Compras"**
4. Click en **"🔄 Actualizar Lista"**
5. Deberías ver la compra con:
   - ✓ Estado "Pagado"
   - 📦 Productos listados
   - Payment ID visible

**✅ Test 1 Exitoso**

---

## 🛒 Test 2: Compra Real con Payment Link

### Paso 1: Crear Producto en Stripe
1. Ve a https://dashboard.stripe.com/test/products
2. Click **"Add product"**
3. Completa:
   - **Name**: Test Product
   - **Price**: $10.00 USD
4. Click **"Save product"**

### Paso 2: Crear Payment Link
1. Ve a https://dashboard.stripe.com/test/payment-links
2. Click **"New"**
3. Selecciona "Test Product"
4. Success URL: `http://localhost:3000?checkout=success`
5. Click **"Create link"**
6. **Copia el link** (ej: `https://buy.stripe.com/test_xxxxxxxxxxxxx`)

### Paso 3: Realizar Compra
1. Abre el payment link en tu navegador
2. Completa el formulario:
   - **Email**: test@example.com
   - **Card**: 4242 4242 4242 4242
   - **Expiry**: 12/25
   - **CVC**: 123
   - **ZIP**: 12345
3. Click **"Pay"**

### Paso 4: Verificar Webhook
Terminal con `stripe listen` debería mostrar:
```
2024-01-15 14:30:12 --> checkout.session.completed [evt_xxxxxxxxxxxxx]
2024-01-15 14:30:12 <-- [200] POST http://localhost:3000/webhook/stripe
```

### Paso 5: Verificar en Frontend
1. Ve al Admin Dashboard
2. Click **"🔄 Actualizar Lista"** en Historial de Compras
3. Deberías ver:
   - Nueva compra con estado **"✓ Pagado"**
   - Producto: **Test Product (x1) - $10.00**
   - Payment ID visible

### Paso 6: Verificar Vouchers
```sql
docker exec -it proyecto-db psql -U admin -d proyectodb
```

```sql
-- Ver vouchers generados
SELECT v.id, v.code, v.status, p.total_price, p.stripe_status
FROM vouchers v
JOIN purchases p ON p.id = v.purchase_id
ORDER BY v.created_at DESC
LIMIT 5;
```

**✅ Test 2 Exitoso**

---

## 🔥 Test 3: Multi-Producto

### Paso 1: Crear Múltiples Productos
Crea 2 productos en Stripe:
1. **Curso Java** - $199.00
2. **Curso JS** - $149.00

### Paso 2: Crear Payment Link con Multiple Items
1. Ve a payment links
2. Click **"New"**
3. Selecciona **ambos productos**
4. Permite que el cliente ajuste cantidades
5. Crea el link

### Paso 3: Comprar Múltiples Items
1. Abre el link
2. Ajusta cantidades:
   - Curso Java: **2**
   - Curso JS: **1**
3. Total: **$547.00** (199×2 + 149×1)
4. Completa checkout

### Paso 4: Verificar Line Items
En el Admin Dashboard deberías ver:
```
Productos:
  📦 Curso Java (x2) - $398.00
  📦 Curso JS (x1) - $149.00
Total: $547.00
```

### Paso 5: Verificar Vouchers
Deberían generarse **3 vouchers** (2+1):
```sql
SELECT COUNT(*) 
FROM vouchers v
JOIN purchases p ON p.id = v.purchase_id
WHERE p.total_price = 547.00;
-- Result: 3
```

**✅ Test 3 Exitoso**

---

## ❌ Test 4: Pago Fallido

### Paso 1: Usar Tarjeta de Prueba que Falla
Abre payment link y usa:
- **Card**: 4000 0000 0000 0002 (decline card)
- **Expiry**: 12/25
- **CVC**: 123

### Paso 2: Checkout Fallará
Stripe mostrará: "Your card was declined"

### Paso 3: Verificar Webhook (Opcional)
Si configuraste `payment_intent.payment_failed`, verás:
```
📨 Stripe Webhook received: payment_intent.payment_failed
❌ Payment failed: pi_xxxxxxxxxxxxx
```

### Paso 4: Verificar No Se Generan Vouchers
```sql
-- Compras fallidas NO tienen vouchers
SELECT p.id, p.stripe_status, COUNT(v.id) as voucher_count
FROM purchases p
LEFT JOIN vouchers v ON v.purchase_id = p.id
WHERE p.stripe_status = 'failed'
GROUP BY p.id;
-- voucher_count: 0
```

**✅ Test 4 Exitoso**

---

## 🔍 Test 5: Customer Info

### Paso 1: Comprar con Nombre
Al hacer checkout en Stripe, ingresa:
- **Email**: john.doe@example.com
- **Name**: John Doe
- Card: 4242 4242 4242 4242

### Paso 2: Verificar Customer Guardado
```sql
SELECT * FROM stripe_customers 
WHERE customer_email = 'john.doe@example.com';
```

**Output esperado:**
```
 id |  stripe_customer_id  | customer_email          | customer_name | partner_id
----+----------------------+-------------------------+---------------+------------
  1 | cus_xxxxxxxxxxxxx    | john.doe@example.com    | John Doe      | 1
```

### Paso 3: Verificar Endpoint API
```bash
curl -X GET http://localhost:3000/admin/stripe-customers \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Response esperada:**
```json
[
  {
    "id": 1,
    "stripe_customer_id": "cus_xxxxxxxxxxxxx",
    "customer_email": "john.doe@example.com",
    "customer_name": "John Doe",
    "partner_id": 1,
    "created_at": "2024-01-15T14:45:00.000Z"
  }
]
```

**✅ Test 5 Exitoso**

---

## 📊 Test 6: Reportes

### Producto Más Vendido
```sql
SELECT 
  product_name, 
  SUM(quantity) as total_sold,
  SUM(total_amount) as revenue
FROM stripe_line_items
GROUP BY product_name
ORDER BY total_sold DESC;
```

**Output esperado:**
```
    product_name     | total_sold | revenue
---------------------+------------+---------
 Curso Java         |         5  | 995.00
 Curso JS           |         3  | 447.00
 Test Product       |         2  |  20.00
```

### Revenue por Día
```sql
SELECT 
  DATE(p.created_at) as date,
  COUNT(*) as purchases,
  SUM(p.total_price) as revenue
FROM purchases p
WHERE p.stripe_status = 'succeeded'
GROUP BY DATE(p.created_at)
ORDER BY date DESC;
```

**✅ Test 6 Exitoso**

---

## 🚨 Troubleshooting Tests

### ❌ Test falla: "Webhook signature verification failed"
**Solución:**
```bash
# En la terminal con stripe listen, copiar el secret:
whsec_xxxxxxxxxxxxx

# Actualizar .env
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx

# Reiniciar Docker
docker compose restart servicio-usuarios
```

### ❌ Line items vacíos en frontend
**Causa:** Webhook no ejecutó `listLineItems`.

**Solución:** Verificar logs:
```bash
docker logs servicio-usuarios | grep "Line items"
```
Debería mostrar:
```
🛍️ Line items: 1
✅ Line items saved
```

### ❌ Vouchers no se generan
**Causa:** `payment_status !== 'paid'`.

**Solución:** Usar tarjeta válida (4242...) o forzar:
```bash
stripe trigger checkout.session.completed --override payment_status=paid
```

### ❌ Frontend no muestra nueva compra
**Causa:** Cache del navegador.

**Solución:** 
1. Hard refresh: Ctrl + Shift + R
2. Click en "🔄 Actualizar Lista"

---

## ✅ Checklist de Tests

- [ ] Test 1: Simular webhook con CLI
- [ ] Test 2: Compra real con payment link
- [ ] Test 3: Multi-producto (2+ items)
- [ ] Test 4: Pago fallido (tarjeta rechazada)
- [ ] Test 5: Customer info guardado
- [ ] Test 6: Reportes SQL funcionando
- [ ] Verificar frontend muestra productos
- [ ] Verificar vouchers generados correctamente
- [ ] Verificar estado de pago (badges)
- [ ] Verificar logs sin errores

---

## 🎯 Resultados Esperados

Al completar todos los tests deberías tener:

### En la BD:
- ✅ Múltiples registros en `stripe_customers`
- ✅ Compras en `purchases` con `stripe_status = 'succeeded'`
- ✅ Productos detallados en `stripe_line_items`
- ✅ Vouchers generados (cantidad = suma de qty de line_items)

### En el Frontend:
- ✅ Admin Dashboard muestra compras con productos
- ✅ Estados de pago visibles (✓ Pagado, ⏳ Pendiente, ✗ Fallido)
- ✅ Payment IDs visibles
- ✅ Productos individuales listados

### En Stripe Dashboard:
- ✅ Payments exitosos visibles
- ✅ Customers creados
- ✅ Events registrados (checkout.session.completed)

---

## 📚 Siguiente Paso

Una vez completados estos tests, estás listo para:
1. **Producción**: Cambiar a claves live, configurar webhook público
2. **Emails**: Implementar notificaciones con vouchers
3. **Dashboard**: Agregar vista de customers
4. **Asociación**: Conectar customers con partners específicos

---

**¡Todos los tests pasados = Sistema funcionando perfectamente! 🎉**
