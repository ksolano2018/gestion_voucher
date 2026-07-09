# Plan de despliegue a Producción — CertJoin Vouchers

Runbook cronológico del despliegue a producción, separando responsabilidades:

- **Orkus** — implementación y soporte (rol `soporte` en la app; sin gestión de usuarios/roles).
- **CertJoin** — cliente y dueño del sistema (rol `admin`; provee las integraciones).

> Servidor destino: `76.13.114.140` (Ubuntu 24.04, 8 vCPU / 31 GB, CloudPanel).
> Subdominio público: `vouchers.certjoin.com` → gateway en `127.0.0.1:3000` detrás del reverse
> proxy de CloudPanel. Ver `DEPLOY-PD.md` (guía técnica) y `REQUISITOS-PD.md` (checklist).

---

## ✅ Fase 0 — Ya resuelto (Orkus)

| # | Tarea | Estado |
|---|---|---|
| 0.1 | Código listo en rama `production` (compose, `setup.sh`, `deploy.sh`) | ✅ |
| 0.2 | Docker + Compose instalados y usables por `certjoin-v` | ✅ verificado 2026-07-09 |
| 0.3 | Token de acceso al repo | ✅ |
| 0.4 | Imágenes Docker precompiladas en el servidor (build cache) | ✅ |

---

## ⛔ Fase 1 — Preparación de CertJoin (bloqueante · en paralelo)

> El despliegue público no avanza hasta tener esto. Todo puede hacerse a la vez.

| # | Tarea | Responsable | Entrega |
|---|---|---|---|
| 1.1 | **DNS**: registro A `vouchers.certjoin.com → 76.13.114.140` | CertJoin | dominio apuntando |
| 1.2 | **Moodle**: URL + token WS (9 funciones) + role ID + URL campus + mapeo de cursos | CertJoin | credenciales WS |
| 1.3 | **Stripe live**: `pk_live`, `sk_live` + crear webhook → `https://vouchers.certjoin.com/webhook/stripe` y copiar `whsec` | CertJoin | 3 claves |
| 1.4 | **SMTP**: host/puerto/seguridad/user/pass + `MAIL_FROM`/reply-to + **SPF/DKIM** | CertJoin | datos SMTP |
| 1.5 | **Correos iniciales** de admin y partner | CertJoin | 2 correos |

> 💡 Stripe entrega el `whsec` **al crear el webhook**, aunque la URL aún no esté viva. Moodle y
> SMTP son *opcionales* en el wizard: si Stripe llega primero, Orkus arranca y completa el resto luego.

---

## 🚀 Fase 2 — Despliegue del stack (Orkus · en el servidor)

> Requiere: Fase 1 lista (al menos Stripe = 1.3).

| # | Tarea | Responsable |
|---|---|---|
| 2.1 | `git clone -b production https://<TOKEN>@github.com/.../gestion_voucher.git ~/app` | Orkus |
| 2.2 | `cd ~/app && bash setup.sh` → cargar datos de CertJoin; genera secretos y levanta el stack | Orkus |
| 2.3 | Verificar `docker compose ps` (8 contenedores) y `/health` 200 en `127.0.0.1:3000` | Orkus |
| 2.4 | Guardar el resumen de contraseñas temporales (admin de CertJoin / soporte de Orkus) | Orkus |

---

## 🔒 Fase 3 — Exposición pública (Orkus · en CloudPanel)

> Requiere: **DNS propagado (1.1)** + stack arriba (2.3).

| # | Tarea | Responsable |
|---|---|---|
| 3.1 | En CloudPanel: sitio `vouchers.certjoin.com` como **Reverse Proxy** → `http://127.0.0.1:3000` | Orkus |
| 3.2 | Emitir **Let's Encrypt** (SSL/TLS → New Certificate) | Orkus |
| 3.3 | Probar `https://vouchers.certjoin.com` desde internet | Orkus |

---

## 🧩 Fase 4 — Configuración post-arranque

| # | Tarea | Responsable |
|---|---|---|
| 4.1 | Confirmar en Stripe que el **webhook** llega (endpoint ya vivo) → evento de prueba | Orkus |
| 4.2 | **Provisionar cursos** en Moodle si CertJoin no los trajo con finalización + quiz | Orkus (con acceso admin) |
| 4.3 | Si Moodle/SMTP se dejaron en blanco: completarlos en `.env` y `docker compose up -d` | Orkus |

---

## 🧪 Fase 5 — Validación end-to-end (Orkus)

| # | Prueba |
|---|---|
| 5.1 | Login **admin** (CertJoin) y **soporte** (Orkus) → fuerza cambio de contraseña ✔ |
| 5.2 | Compra → pago Stripe → **voucher generado** ✔ |
| 5.3 | Activación → **matrícula en Moodle** + **correo de bienvenida** ✔ |
| 5.4 | Verificar estados de curso (completado / certificado) ✔ |

---

## 🎁 Fase 6 — Entrega

| # | Tarea | Responsable |
|---|---|---|
| 6.1 | Entregar credenciales **admin** a CertJoin (cambia clave al primer login) | Orkus → CertJoin |
| 6.2 | **Cambiar la contraseña** del admin en el primer login | CertJoin |
| 6.3 | La **web de CertJoin** agrega el enlace/botón al subdominio | CertJoin |
| 6.4 | Cierre y documentación del despliegue | Orkus |

---

## 🔗 Ruta crítica (lo que marca los tiempos)

```
CertJoin 1.1 DNS ───────────────┐
CertJoin 1.3 Stripe ─► 2.2 setup.sh ─► 2.3 stack OK ─► 3.1/3.2 Proxy+SSL ─► 5.x validación ─► 6.x entrega
                                 (Moodle/SMTP se pueden completar en 4.x)   ▲
DNS debe estar propagado ────────────────────────────────────────────────┘ (necesario para el SSL)
```

**Orkus no tiene bloqueantes propios; el reloj lo pone CertJoin (Fase 1).** En cuanto lleguen
Stripe + DNS, Orkus ejecuta las Fases 2–6 en el mismo día.

---

## Resumen de responsabilidades

| Fase | Orkus | CertJoin |
|---|:---:|:---:|
| 0 · Preparación técnica | ✅ | — |
| 1 · Integraciones (DNS/Moodle/Stripe/SMTP/correos) | — | ⬜ |
| 2 · Despliegue del stack | ⬜ | — |
| 3 · Reverse Proxy + SSL | ⬜ | — |
| 4 · Config post-arranque | ⬜ | — |
| 5 · Validación E2E | ⬜ | — |
| 6 · Entrega | ⬜ | ⬜ |
