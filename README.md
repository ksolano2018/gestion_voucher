# Local Platform 2

Plataforma de gestion de vouchers con pagos Stripe, roles (admin/partner) y activacion con asignacion automatica de voucher por curso.

## Estado actual
- Seccion Productos eliminada del flujo activo.
- Compra de vouchers integrada al carrito existente.
- Activacion permitida solo con pago exitoso.
- El codigo de voucher no se ingresa manualmente: se asigna automaticamente desde BD.

## Inicio rapido
1. Ejecutar servicios:
   docker compose up -d --build
2. Frontend:
   http://localhost:3000
3. Credenciales:
   - Admin y Partner: configuradas localmente en servicios/servicio-usuarios/.env

## Arquitectura activa
- frontend: UI web
- servicio-usuarios: API principal (auth, compras, vouchers, activaciones)
- api-gateway: gateway HTTP
- servicio-pedidos: servicio auxiliar
- postgres: base de datos

## Servicios fuera del stack activo
- servicio-productos permanece en el repositorio solo como remanente historico y no se levanta con los archivos compose vigentes.

## Flujos principales
### Compra de voucher
1. Partner agrega vouchers al carrito desde la seccion Vouchers.
2. Se crea checkout Stripe.
3. Al volver de Stripe, frontend valida estado real de pago.
4. Solo con pago exitoso se habilita gestion de vouchers.

### Activacion
1. Partner abre Activar Voucher.
2. El sistema consulta elegibilidad (vouchers pagados disponibles).
3. Partner selecciona curso y completa:
   - Nombre de usuario
   - Email
   - Cliente Final (obligatorio)
4. Backend selecciona automaticamente un voucher disponible y lo asocia al curso.

## Endpoints clave
### Auth
- POST /oauth/token
- POST /oauth/refresh
- POST /oauth/logout

### Admin
- POST /admin/users
- GET /admin/users
- PUT /admin/users/:id
- DELETE /admin/users/:id
- GET /admin/purchases

### Partner
- POST /partner/:id/checkout
- GET /partner/:id/purchases/:purchaseId/status
- GET /partner/:id/vouchers
- GET /partner/:id/courses
- GET /partner/:id/activation-eligibility
- POST /partner/:id/activate
- GET /partner/:id/stats

## Base de datos (tablas relevantes)
- users
- partners
- pricing_profiles
- pricing_rules
- purchases
- vouchers
- activations
- courses
- partner_final_clients
- stripe_customers
- stripe_line_items
- system_events

## Migraciones
Se agregaron migraciones dedicadas para entornos existentes:
- database/migrations/20260325_vouchers_courses_activation.sql
- database/migrations/20260406_partner_pricing_profiles.sql
- database/migrations/20260410_partner_final_clients.sql
- database/migrations/20260412_users_first_last_name.sql

## Comandos utiles
- docker compose logs -f servicio-usuarios
- docker compose down
- docker compose down -v

## Notas
- La documentacion historica de Stripe puede mencionar productos en el contexto de line items de Stripe.
- El flujo funcional actual de la app se centra en vouchers.
- El despliegue automatizado hacia AWS fue retirado del repositorio; la operacion documentada vigente es local con Docker.
