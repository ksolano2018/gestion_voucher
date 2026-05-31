# Índice de Documentación

## Documentación recomendada

### Operación actual
1. [README.md](README.md)
   - Estado vigente del sistema
   - Arquitectura activa
   - Flujo funcional de vouchers
   - Comandos base con Docker

2. [ADMIN_GUIDE.md](ADMIN_GUIDE.md)
   - Operación de consola administrativa
   - Gestión de usuarios
   - Dashboard y métricas

3. [TESTING_QUICK.md](TESTING_QUICK.md)
   - Verificaciones rápidas
   - Flujos manuales principales

### Base de datos
4. [database/init.sql](database/init.sql)
   - Esquema base inicial
   - Tablas activas del sistema
   - Datos semilla principales

5. [TRANSACTION_EVENTS_IMPLEMENTATION.md](TRANSACTION_EVENTS_IMPLEMENTATION.md)
   - Contexto de eventos y auditoría
   - Endpoints y comportamiento asociado

### Stripe
6. [STRIPE_START_HERE.md](STRIPE_START_HERE.md)
   - Punto de entrada para configuración Stripe

7. [STRIPE_TESTING_GUIDE.md](STRIPE_TESTING_GUIDE.md)
   - Casos de prueba de pagos y webhook

## Documentación histórica
- Los archivos de resumen de implementación y sincronización Stripe se mantienen como referencia histórica.
- Si una guía contradice a [README.md](README.md) o [database/init.sql](database/init.sql), prevalece la operación local actual documentada allí.

## Notas de vigencia
- El despliegue automatizado a AWS ya no forma parte del repositorio.
- La operación soportada y documentada en este proyecto es local con Docker Compose.

**Sistema de sincronización automática de usuarios con Stripe y auditoría centralizada de eventos completamente implementado, documentado y en producción.**

---

**Versión**: 1.0
**Estado**: ✅ COMPLETADO
**Fecha**: 2026-03-01
**Mantenedor**: Sistema automático
