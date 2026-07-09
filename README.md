# CertJOIN — Plataforma de Vouchers

Plataforma de gestión de vouchers con pagos Stripe, roles (admin / partner / soporte con RBAC granular) y activación con asignación automática de voucher por curso e integración con Moodle (matrícula + estados de curso).

## Estado actual
- Compra de vouchers integrada al carrito; la activación solo se habilita con pago exitoso.
- El código de voucher no se ingresa manualmente: se asigna automáticamente desde BD.
- Al activar, se matricula al estudiante en Moodle vía WebServices y se le envía un correo de bienvenida (plantilla editable desde el panel).
- Ingreso único por el **gateway** (Caddy). El frontend y los servicios internos no exponen puertos al exterior.

## Inicio rápido (local)
1. Copiar `servicios/servicio-usuarios/.env.example` → `.env` y completar las claves (Stripe, JWT, admin/partner).
2. Levantar el stack:
   ```bash
   docker compose up -d --build
   ```
3. Abrir la app: **http://localhost:3000** (todo pasa por el gateway).
4. Credenciales admin/partner: definidas en `servicios/servicio-usuarios/.env`.

Perfiles opcionales de desarrollo (no se levantan por defecto):
- `--profile local-moodle` — Moodle dockerizado (MariaDB + erseco/alpine-moodle) en `http://localhost:8095`.
- `--profile local-mail` — Mailpit (buzón SMTP local) en `http://localhost:8025`.
- `--profile dev-mock` — mock del WS de Moodle (`moodle-mock`).

## Arquitectura activa
Ingreso único por el gateway; los microservicios se comunican por la red interna de Docker con un token interno (`INTERNAL_API_TOKEN`). Postgres es compartido; cada módulo es dueño de sus tablas.

| Componente | Rol | Puerto |
| --- | --- | --- |
| `api-gateway` (Caddy) | Único ingreso; enruta API/webhooks a los servicios y el resto (SPA) al frontend | `:3000` (host) |
| `frontend` | UI web (servida por el gateway, mismo origen) | interno |
| `servicio-usuarios` | API principal: auth/JWT, usuarios, roles/RBAC, partners, cursos, vouchers/activación, auditoría/reportería, settings | interno `:8081` |
| `servicio-compras` | Compras + pagos Stripe (checkout, webhook, historial); expone backfill para la activación | interno `:8085` |
| `servicio-moodle` | Adaptador del WebServices de Moodle (matrícula, completaciones). No usa BD | interno `:8084` |
| `servicio-notificaciones` | Envío de correo al estudiante (asíncrono, idempotente) | interno `:8083` |
| `postgres` | Base de datos compartida | interno `:5432` |

> El monolito original (`servicio-usuarios`) fue modularizado en `src/` y varios dominios (compras, Moodle, notificaciones) se extrajeron a microservicios propios (patrón strangler). Ver `.claude`/memoria del proyecto para el plan de refactor.

## Flujos principales
### Compra de voucher
1. El partner agrega vouchers al carrito desde la sección Vouchers.
2. Se crea una Checkout Session de Stripe (vía `servicio-compras`).
3. Al volver de Stripe, el frontend valida el estado real del pago.
4. El webhook de Stripe (`/webhook/stripe` → `servicio-compras`) confirma el pago y genera los vouchers de forma **atómica e idempotente**.

### Activación
1. El partner abre Activar Voucher; el sistema consulta elegibilidad (vouchers pagados disponibles).
2. Selecciona curso y completa nombre, email y Cliente Final (obligatorio).
3. El backend asigna automáticamente un voucher disponible, matricula al estudiante en Moodle y dispara el correo de bienvenida.

## Roles y permisos
- **admin** — acceso completo (incluye gestión de usuarios y roles). En producción lo genera el cliente.
- **soporte** — admin operativo SIN gestión de usuarios/roles (`users: none`); rol para el equipo de soporte, revocable por el cliente.
- **partner** — sección de partners: carga y activa vouchers; sin acceso a datos de otros partners.
- RBAC granular por módulo (`dashboard`, `purchases`, `users`, `courses`, `pricing`, `stats`, `audit`, `reports`, `financial_ops`) × nivel (`none`/`view`/`edit`).

## Base de datos
- Esquema base: `database/init.sql`. Migraciones incrementales: `database/migrations/`.
- Tablas relevantes: `users`, `roles`, `partners`, `pricing_profiles`, `pricing_rules`, `purchases`, `vouchers`, `activations`, `courses`, `partner_final_clients`, `stripe_customers`, `stripe_line_items`, `system_events`, `transaction_events`, `email_templates`.

## Despliegue
- **QA**: automatizado con GitHub Actions (`.github/workflows/deploy-qa.yml`) sobre EC2; TLS con Caddy + Let's Encrypt (dominio DuckDNS). Dispara **solo** en push a la rama `qa`.
- **Producción (PD)**: rama `production`. VPS con Docker detrás del reverse proxy de CloudPanel (gateway en `127.0.0.1:3000`). Primer arranque con el wizard `setup.sh`. Ver `DEPLOY-PD.md` y `REQUISITOS-PD.md`.

## Comandos útiles
```bash
docker compose logs -f servicio-usuarios      # logs de un servicio
docker compose ps                             # estado de contenedores
docker compose down                           # detener
docker compose down -v                         # detener y borrar volúmenes (¡borra datos!)
pwsh tests/run-all.ps1                          # suite E2E local
```

## Documentación
Ver [DOCUMENTATION_INDEX.md](DOCUMENTATION_INDEX.md) para el índice completo.
