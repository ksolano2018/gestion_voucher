# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-07-08

Entrada consolidada del trabajo posterior a 1.0.0 (arquitectura, integraciones y despliegue).

### Added
- Integración con Moodle vía WebServices: matrícula automática al activar voucher y seguimiento de estados de curso (completado / certificado).
- Correo de bienvenida al estudiante con **plantillas editables desde el panel admin** (BD + Mustache, versionadas), con fallback al default en código.
- Reenvío de notificaciones (partner/admin) y aviso a cuentas Moodle existentes.
- Timeout de sesión por inactividad (30 min): access JWT + refresh deslizante (server + frontend).
- Rol **soporte** (admin operativo sin gestión de usuarios/roles) y cambio de contraseña obligatorio al primer login (`must_change_password`), para la gobernanza de credenciales en producción.
- Agrupación del sidebar (admin y partner) por tipo de operación.
- Rama `production` con artefactos de despliegue a PD: `setup.sh` (wizard de primer arranque), `deploy.sh`, `docker-compose.tls.yml`, plantillas `.env.production.example`, `DEPLOY-PD.md`, `REQUISITOS-PD.md` y `.gitattributes` (normalización LF).
- Despliegue automatizado a QA (`.github/workflows/deploy-qa.yml`) sobre EC2 con TLS (Caddy + Let's Encrypt vía DuckDNS).

### Changed
- **Gateway real** con Caddy como ingreso único (`:3000`): enruta API/webhooks a los servicios y el resto (SPA) al frontend; el frontend y los servicios internos dejan de exponer puertos.
- Modularización del monolito `servicio-usuarios` en `src/` (auth, users, roles, partners, pricing, purchases, moodle, audit-reports, vouchers/activación, schedulers, schema) — patrón strangler.
- Extracción de microservicios: **servicio-compras** (compras + Stripe), **servicio-moodle** (adaptador WS) y **servicio-notificaciones** (correo), comunicados por red interna con token.
- Reportería: los totales de dinero muestran 2 decimales, consistentes con el historial.

### Fixed
- Generación de vouchers atómica e idempotente: evita duplicados por carrera entre webhook de Stripe y backfill.
- Reconciliación de cursos por nombre en el sync de Moodle para no duplicar.

## [1.0.0] - 2026-05-05

### Added
- Left vertical navigation panel for admin and partner modules, replacing the horizontal card grid
- User management table with avatar, role badge, status indicator, and action columns
- Modal-based CRUD flows for users: create, edit, deactivate/activate, force password change, delete
- Roles sub-view with modal for creating a role including permissions configuration in a single step
- Toast notification system (success/danger/warning/info) replacing browser alerts
- Confirmation modals before destructive operations (delete user, delete client, activate voucher, save permissions)
- Logout dropdown on the username in the header
- Role-based navigation panel for partner role (same structure as admin)
- `VERSION` file for semantic versioning tracking
- `.env.example` template for environment variable documentation
- `.gitignore` with comprehensive rules for secrets, dependencies, build artifacts, and CI/CD files

### Changed
- Users section reorganized: list view and roles view are now separate sub-tabs
- Admin and partner sections break out of the app-shell max-width constraint for full-width panel layout
- Role creation now includes permission configuration inline within the creation modal
- All `confirm()` dialogs replaced with Bootstrap modals
- All inline alert messages replaced with toast notifications

### Removed
- CI/CD deployment configuration (`docker-compose.prod.yml`, GitHub Actions deploy workflows)
- Horizontal card grid navigation at the top of admin and partner sections
- Inline role creation form (replaced by modal)
- `simulate_payment.ps1`, `test-sync-events.ps1`, `test_admin_login.js` excluded via `.gitignore`
