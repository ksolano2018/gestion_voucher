# Índice de Documentación

## Operación y arquitectura
1. [README.md](README.md) — Estado vigente, arquitectura activa (gateway + microservicios), flujos de compra/activación, roles y comandos base.
2. [ADMIN_GUIDE.md](ADMIN_GUIDE.md) — Consola administrativa: gestión de usuarios, roles/RBAC, dashboard y métricas.
3. [GUIA_USUARIO.md](GUIA_USUARIO.md) — Guía funcional para el usuario final (admin y partner).

## Base de datos
4. [database/init.sql](database/init.sql) — Esquema base y datos semilla.
5. [database/migrations/](database/migrations/) — Migraciones incrementales para entornos existentes.
6. [TRANSACTION_EVENTS_IMPLEMENTATION.md](TRANSACTION_EVENTS_IMPLEMENTATION.md) — Diseño del sistema de eventos de transacción y auditoría (tabla `transaction_events`, endpoints).

## Stripe
7. [STRIPE_TESTING_GUIDE.md](STRIPE_TESTING_GUIDE.md) — Configuración de claves, webhook por el gateway y pruebas con Stripe CLI (test mode).

## Despliegue
8. [DEPLOY-PD.md](DEPLOY-PD.md) — Guía de primer arranque en producción (VPS + CloudPanel, wizard `setup.sh`).
9. [REQUISITOS-PD.md](REQUISITOS-PD.md) — Checklist de requisitos previos al despliegue a producción.
10. `.github/workflows/deploy-qa.yml` — Despliegue automatizado a QA (EC2 + TLS), dispara solo en push a la rama `qa`.

## Notas de vigencia
- La operación local usa **Docker Compose** con ingreso único por el gateway (`http://localhost:3000`).
- QA se despliega automáticamente desde la rama `qa`; producción vive en la rama `production`.
- Si una guía contradice a [README.md](README.md) o a `database/init.sql`, prevalece lo documentado allí.
