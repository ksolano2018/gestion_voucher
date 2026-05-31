# 🎯 GUÍA RÁPIDA: Stripe Demo - 5 pasos

## 📌 Tabla de Contenidos

1. [Setup Stripe](#1-setup-stripe) - 5 min
2. [Configurar Claves](#2-configurar-claves) - 2 min
3. [Reiniciar Docker](#3-reiniciar-docker) - 1 min
4. [Ejecutar Stripe CLI](#4-ejecutar-stripe-cli) - 1 min
5. [Test Completo](#5-test-completo) - 10 min

---

## 1️⃣ Setup Stripe

### Crear Cuenta
1. Ve a **https://dashboard.stripe.com**
2. Sign up si es primera vez
3. Completa información (país = tu país, resto opcional)

### Obtener Claves
1. Dashboard → **Developers** → **API Keys**
2. Asegúrate de estar en **Test Mode** (toggle en esquina superior)
3. Copia:
   - `Publishable key`: comienza con `pk_test_`
   - `Secret key`: comienza con `sk_test_`

---

## 2️⃣ Configurar Claves

### Editar `.env`
```powershell
# Abre con notepad o VS Code:
notepad "d:\Work\Proyecto\local-platform2\servicios\servicio-usuarios\.env"
```

Busca y reemplaza:
```
STRIPE_PUBLISHABLE_KEY=pk_test_TU_CLAVE
STRIPE_SECRET_KEY=sk_test_TU_CLAVE
```

**Guarda el archivo**

---

## 3️⃣ Reiniciar Docker

```powershell
cd d:\Work\Proyecto\local-platform2
docker compose down
docker compose up -d --build
```

Espera ~60 segundos a que levante.

---

## 4️⃣ Ejecutar Stripe CLI

### Descargar (1 vez)
```powershell
# Con Chocolatey (recomendado):
choco install stripe-cli

# O descarga manual:
# https://github.com/stripe/stripe-cli/releases
```

### Ejecutar (terminal dedicada - SIEMPRE ABIERTA)
**Terminal 2** - Abre una nueva PowerShell y ejecuta:

```powershell
stripe login
# Te pedirá autorizar → Presiona Enter → Autoriza en navegador
```

Después:
```powershell
stripe listen --forward-to localhost:8081/webhook/stripe
```

Verá:
```
> Ready! Your webhook signing secret is: whsec_test_XXXXXXXXX
```

### Agregar Webhook Secret
```powershell
notepad "d:\Work\Proyecto\local-platform2\servicios\servicio-usuarios\.env"
```

Agrega:
```
STRIPE_WEBHOOK_SECRET=whsec_test_XXXXXXXXX
```

Reinicia:
```powershell
docker compose restart servicio-usuarios
```

---

## 5️⃣ Test Completo

### Abrir Aplicación

1. **http://localhost:3000**
2. Login Partner:
   - Email: `partner@certjoin.com`
   - Contraseña: configurada localmente en `servicios/servicio-usuarios/.env`

### Realizar Compra

1. Menú → **Vouchers**
2. Selecciona curso + cantidad (ej: 2)
3. Click **"Agregar"**
4. Click **🛒** (carrito)
5. Verás total: `$XXX`
6. Click **"Continuar"**
7. Redirigido a Stripe Checkout

### Pagar

En Stripe Checkout:
- Email: `test@example.com`
- Tarjeta: **`4242 4242 4242 4242`** ← OBLIGATORIO
- Fecha: `12/25`
- CVC: `123`
- Nombre: `Test User`
- Click **"Pay $XX.XX"**

### Verificar

Verá:
1. ✅ **Mensaje**: "Compra exitosa"
2. ✅ **Carrito**: Vacío
3. ✅ **Admin Dashboard**:
   - Login: usar credenciales admin configuradas localmente
   - Ve→ **Administración** → **Compras**
   - Status: **✓ Pagado** (verde)
   - Payment ID: visible

---

## ⚡ Quick Reference - Errores Comunes

| Error | Solución |
|-------|----------|
| "Invalid API Key" | Verifica claves en `.env` + restart docker |
| "Webhook silencioso" | Terminal 2 debe estar ejecutando `stripe listen` |
| "Payment rechazado" | Usa tarjeta `4242 4242 4242 4242` (test mode) |
| "Compra no aparece" | Click "🔄 Actualizar Lista" en Admin |
| Port error | Asegúrate docker listen está activo. Ver: `docker compose ps` |

---

## 📚 Documentación Completa

- **Detalles técnicos**: Lee [STRIPE_CHANGES.md](STRIPE_CHANGES.md)
- **Guía completa**: Lee [STRIPE_COMPLETE_GUIDE.md](STRIPE_COMPLETE_GUIDE.md)
- **Setup inicial**: Lee [STRIPE_SETUP.md](STRIPE_SETUP.md)

---

## ✅ Checklist Final

```
Antes de empezar:
□ Cuenta Stripe creada (test mode)
□ Claves API copiadas
□ .env actualizado
□ Docker reiniciado
□ Stripe CLI instalado
□ Terminal 2: stripe listen ejecutándose

Testing:
□ Frontend accesible en localhost:3000
□ Partner login funciona
□ Vouchers o cursos cargan
□ Carrito funciona
□ Stripe Checkout carga
□ Pago procesado ✓
□ Admin ve compra pagada
□ Webhook recibido (ver Terminal 2)
```

---

## 🚀 ¡LISTO!

Una vez todo OK, tienes un flujo COMPLETO:
- Partner → Vouchers → Carrito → Stripe → Pago → Webhook → Admin Dashboard

**Está 100% operacional**, lista para presentación.

---

**Next: Abre [STRIPE_COMPLETE_GUIDE.md](STRIPE_COMPLETE_GUIDE.md) para instrucciones detalladas**
