# Guía de Administración - Gestión de Usuarios

## Acceso a la Consola de Administración

### Credenciales de Admin
- **Email:** `admin@certjoin.com`
- **Contraseña:** configurada localmente en `servicios/servicio-usuarios/.env`

Al ingresar, serás redirigido automáticamente a `/admin` donde verás la consola de administración.

## Funcionalidades de Gestión de Usuarios

### 1. Crear Nuevo Usuario

En la sección **"Gestión de Usuarios"** encontrarás un formulario para crear usuarios:

1. **Email**: Ingresa el email del nuevo usuario
2. **Contraseña**: Establece una contraseña inicial
3. **Rol**: Selecciona entre:
   - **Admin**: Acceso completo a la consola de administración
   - **Partner**: Acceso a la sección de partners (gestión de vouchers)
4. Haz clic en **"+ Crear"**

### 2. Listar Usuarios

Haz clic en el botón **"Actualizar"** para ver la tabla completa de usuarios con:
- Email del usuario
- Rol asignado (distintivo con color)
- ID de Partner (si aplica)
- Botones de acciones

### 3. Editar Usuario

Para cambiar la contraseña o el rol de un usuario existente:

1. Haz clic en el botón **"Editar"** en la fila del usuario
2. Se abrirá un modal con:
   - **Email**: Solo lectura (no se puede cambiar)
   - **Nueva Contraseña**: Deja en blanco si no deseas cambiarla
   - **Rol**: Selecciona el nuevo rol
3. Haz clic en **"Guardar"** para confirmar los cambios

### 4. Eliminar Usuario

Para eliminar un usuario:

1. Haz clic en el botón **"Eliminar"** en la fila del usuario
2. Confirma la acción en el diálogo de confirmación
3. El usuario será eliminado y todos sus tokens de acceso serán revocados

## Dashboard Administrativo

### Objetivo
- Monitorear en tiempo real la salud de la operación.
- Identificar rápidamente anomalías en la generación y canje de vouchers.
- Facilitar decisiones tácticas (promociones, asignación de canales, soporte).

### Acceso
1. Inicia sesión como **Admin**.
2. Desde el menú lateral elige **Dashboard** (primer elemento del bloque de administración).
3. El panel se abre con la vista "Resumen General" filtrada por los últimos 7 días.

### Filtros Configurables
| Filtro | Descripción |
| --- | --- |
| **Rango de fechas** | Selector doble (desde/hasta) con accesos rápidos: Hoy, 7 días, 30 días, Trimestre actual. |
| **Cursos** | Múltiple selección: todos los cursos disponibles, con contador de vouchers emitidos y canjeados por curso. |
| **Canal de venta** | Web, partners, campañas especiales. Útil para medir performance por canal. |
| **Estado del voucher** | Emitido, Canjeado, Expirado, Revocado. Permite aislar embudos específicos. |
| **Medio de pago** | Stripe, transferencia, cortesía. Ayuda a detectar incidencias de cobro. |
| **Partner** | Solo aparece si existe un partner asignado; filtra métricas y tablas relacionadas. |

Los filtros se pueden combinar; siempre que cambies un criterio el tablero recarga métricas, gráficas y tablas en <2 segundos.

### Widgets y Métricas Principales
- **Tarjetas resumen**: Vouchers emitidos, canjeados, en espera y tasa de conversión (canjeados/emitidos) para el rango aplicado.
- **Gráfica temporal**: Línea o barras apiladas que compara emisión vs canje día a día. Incluye promedio móvil de 7 días para detectar tendencias.
- **Top cursos**: Ranking de 5 cursos por cantidad de vouchers; muestra % de participación y variación versus periodo anterior.
- **Mapa de calor de horarios**: Cruza día de la semana vs franja horaria para ver cuándo se generan más vouchers.
- **Alertas operativas**: Tarjetas pequeñas (rojas/amarillas) que se encienden cuando:
   - La tasa de canje cae más de 15% respecto al promedio semanal.
   - Existe un pico de vouchers expirados.
   - Un partner supera el 80% de su cuota asignada.

### Tabla Detallada
- Lista los vouchers que cumplen con los filtros vigentes.
- Columnas sugeridas: ID, curso, estado, fecha emisión, fecha canje, canal, partner, monto, medio de pago.
- Incluye búsqueda rápida por email del alumno o código de voucher.
- Botón **Exportar CSV** descarga exactamente lo visible (máx. 5.000 filas por exportación).

### Buenas Prácticas de Uso
1. **Validar campañas**: Aplica filtro de canal "Campañas" + rango de fechas de la promoción para medir adopción.
2. **Anticipar soporte**: Revisa el widget de alertas cada mañana; si hay pico de expirados, coordina recordatorios automáticos.
3. **Planificar inventario**: Usa el ranking de cursos y el mapa de calor para dimensionar sesiones extra o instructores.
4. **Revisión semanal**: Los lunes compara el periodo "Últimos 7 días" vs "Semana anterior" para detectar desvíos tempranos.

## Roles Disponibles

### Admin (Administrador)
- Acceso completo a la consola de administración
- Puede crear, editar y eliminar usuarios
- Puede gestionar partners
- Puede generar compras y vouchers
- Acceso a todas las secciones

### Partner
- Acceso limitado a la sección de partners
- Puede cargar y activar vouchers
- No puede gestionar usuarios ni partners
- No puede ver datos sensibles

## API de Gestión de Usuarios

Si prefieres usar la API directamente:

### Crear Usuario
```bash
POST http://localhost:8081/admin/users
Header: Authorization: Bearer <access_token>
Body: {
  "email": "newuser@example.com",
  "password": "password123",
  "role": "partner",
  "partner_id": null
}
```

### Listar Usuarios
```bash
GET http://localhost:8081/admin/users
Header: Authorization: Bearer <access_token>
```

### Actualizar Usuario
```bash
PUT http://localhost:8081/admin/users/:id
Header: Authorization: Bearer <access_token>
Body: {
  "password": "newpassword123",  // Opcional
  "role": "admin"                // Opcional
}
```

### Eliminar Usuario
```bash
DELETE http://localhost:8081/admin/users/:id
Header: Authorization: Bearer <access_token>
```

## Notas Importantes

- ⚠️ Los emails de usuario deben ser únicos en el sistema
- ⚠️ Las contraseñas se cifran usando bcrypt (no se pueden recuperar, solo resetear)
- ⚠️ Al eliminar un usuario, se revocan automáticamente todos sus tokens de acceso
- ✅ Los cambios se aplican inmediatamente
- ✅ La tabla se actualiza automáticamente después de crear, editar o eliminar usuarios

## Usuarios por Defecto

El sistema viene con dos usuarios pre-configurados:

1. **Admin**
   - Email: `admin@certjoin.com`
   - Contraseña: configurada localmente en `servicios/servicio-usuarios/.env`
   - Rol: Admin

2. **Partner Demo**
   - Email: `partner@certjoin.com`
   - Contraseña: configurada localmente en `servicios/servicio-usuarios/.env`
   - Rol: Partner

Estos usuarios se crean automáticamente en el primer inicio del sistema.
