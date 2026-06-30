# Guía de Usuario — CertJoin Local Platform

**Versión:** 2.x  
**Fecha:** Junio 2026  
**Audiencia:** Administradores y Partners

---

## Índice

1. [¿Qué es CertJoin Local Platform?](#1-qué-es-certjoin-local-platform)
2. [Acceso al sistema](#2-acceso-al-sistema)
3. [Roles de usuario](#3-roles-de-usuario)
4. [Panel de Administrador](#4-panel-de-administrador)
   - 4.1 [Gestión de usuarios](#41-gestión-de-usuarios)
   - 4.2 [Gestión de partners](#42-gestión-de-partners)
   - 4.3 [Gestión de cursos](#43-gestión-de-cursos)
   - 4.4 [Perfiles de precios](#44-perfiles-de-precios)
   - 4.5 [Compras manuales](#45-compras-manuales)
   - 4.6 [Activaciones y reenvío de emails](#46-activaciones-y-reenvío-de-emails)
   - 4.7 [Dashboard y reportes](#47-dashboard-y-reportes)
   - 4.8 [Integración con Moodle](#48-integración-con-moodle)
   - 4.9 [Sincronización con Stripe](#49-sincronización-con-stripe)
5. [Panel de Partner](#5-panel-de-partner)
   - 5.1 [Ver cursos disponibles](#51-ver-cursos-disponibles)
   - 5.2 [Carrito de compra](#52-carrito-de-compra)
   - 5.3 [Proceso de pago con Stripe](#53-proceso-de-pago-con-stripe)
   - 5.4 [Ver y gestionar vouchers](#54-ver-y-gestionar-vouchers)
   - 5.5 [Activar un voucher](#55-activar-un-voucher)
   - 5.6 [Reenviar email al estudiante](#56-reenviar-email-al-estudiante)
   - 5.7 [Clientes finales](#57-clientes-finales)
   - 5.8 [Historial de compras](#58-historial-de-compras)
6. [Flujo completo de extremo a extremo](#6-flujo-completo-de-extremo-a-extremo)
7. [Notificaciones de email](#7-notificaciones-de-email)
8. [Estados y significados](#8-estados-y-significados)
9. [Preguntas frecuentes](#9-preguntas-frecuentes)

---

## 1. ¿Qué es CertJoin Local Platform?

CertJoin Local Platform es una **plataforma de gestión de vouchers para certificaciones profesionales**. Permite a empresas y distribuidores (**Partners**) adquirir lotes de vouchers para cursos, activarlos en nombre de sus estudiantes o clientes finales, y gestionar automáticamente las matrículas en el campus virtual (Moodle).

**Ciclo general del sistema:**

```
Admin configura cursos y precios
       ↓
Partner compra vouchers (pago Stripe)
       ↓
Se generan vouchers automáticamente
       ↓
Partner activa voucher para un estudiante
       ↓
Estudiante queda matriculado en Moodle y recibe sus credenciales por email
       ↓
Sistema monitorea la completación del curso
```

---

## 2. Acceso al sistema

### URL de acceso

La plataforma está disponible en:

```
http://localhost:3000
```

### Inicio de sesión

1. Abrir el navegador e ingresar a `http://localhost:3000`.
2. En la pantalla de inicio de sesión, ingresar **email** y **contraseña**.
3. Hacer clic en **Iniciar sesión**.

El sistema emite un token de sesión (JWT) válido por tiempo limitado. Si la sesión expira, el sistema redirige automáticamente al login.

> **Seguridad:** Después de 5 intentos fallidos de inicio de sesión en 15 minutos, la cuenta queda bloqueada temporalmente.

### Cerrar sesión

Hacer clic en el botón de **Cerrar sesión** en la esquina superior del menú de navegación. Esto invalida el token de sesión de forma segura.

---

## 3. Roles de usuario

| Rol | Descripción |
|-----|-------------|
| **Admin** | Acceso completo a toda la plataforma. Gestiona usuarios, partners, cursos, precios, compras, activaciones y configuraciones. |
| **Partner** | Acceso a su área privada. Puede comprar vouchers, activarlos para sus estudiantes y ver sus propios datos. No puede ver información de otros partners. |

---

## 4. Panel de Administrador

El panel de administrador está accesible desde el menú lateral izquierdo. Todas las acciones se realizan sobre los datos de toda la plataforma.

---

### 4.1 Gestión de usuarios

Desde la sección **Usuarios** el administrador puede:

- **Listar usuarios:** Ver todos los usuarios registrados con paginación.
- **Crear usuario:** Ingresar email, contraseña y rol (admin o partner).
- **Editar usuario:** Modificar contraseña o rol.
- **Eliminar usuario:** Eliminar de forma permanente. Esta acción no se puede deshacer.

> **Nota:** Al crear un partner, también se debe crear su registro en la sección **Partners** para asociar el perfil de precios y demás configuraciones.

---

### 4.2 Gestión de partners

Desde la sección **Partners** el administrador puede:

- **Listar partners** con sus datos de contacto y perfil de precios asignado.
- **Crear partner:** Nombre, email, información de contacto y perfil de precios.
- **Ver estadísticas del partner:** Total de vouchers, usados, disponibles, complimentary y completados.

**Estadísticas disponibles por partner:**

| Métrica | Descripción |
|---------|-------------|
| Total | Total de vouchers adquiridos (pagados + complimentary) |
| Disponibles | Vouchers con estado AVAILABLE (sin activar) |
| Consumidos | Vouchers ya activados para un estudiante |
| Completados | Vouchers donde el estudiante completó el curso en Moodle |
| Complimentary | Vouchers otorgados manualmente (sin pago) |

---

### 4.3 Gestión de cursos

Desde la sección **Cursos** el administrador puede:

- **Listar cursos** disponibles en la plataforma.
- **Crear un curso:** Nombre y descripción.
- **Configurar el mapeo con Moodle:** Asociar el curso local con el `moodle_course_id` correspondiente en el campus virtual. Sin este mapeo, el sistema no puede matricular automáticamente a los estudiantes.

**Mapeo con Moodle:**

1. Ir a **Cursos → [Nombre del curso] → Configurar mapeo Moodle**.
2. Ingresar el ID del curso en Moodle (número entero).
3. Guardar. A partir de ese momento, las activaciones de ese curso generarán matrículas automáticas.

Para ver el estado de todos los mapeos:  
**Admin → Moodle → Estado de mapeos de cursos**

---

### 4.4 Perfiles de precios

Los perfiles de precios permiten aplicar **descuentos por volumen** según la cantidad de vouchers comprada. Cada partner puede tener asignado un perfil diferente.

**Estructura de un perfil:**

- **Nombre del perfil** (ej: "Distribuidor Gold")
- **Reglas de precio:** rangos de cantidad con precio unitario  
  Ejemplo:
  | Cantidad mínima | Cantidad máxima | Precio unitario |
  |-----------------|-----------------|-----------------|
  | 1 | 9 | $100 |
  | 10 | 49 | $90 |
  | 50 | — | $75 |

**Acciones disponibles:**
- Crear perfil
- Editar perfil y sus reglas
- Asignar perfil a un partner

---

### 4.5 Compras manuales

El administrador puede registrar compras manualmente, sin pasar por el flujo de Stripe. Esto se usa para vouchers **complimentary** o acuerdos especiales.

1. Ir a **Compras → Nueva compra manual**.
2. Seleccionar el partner, el curso y la cantidad.
3. Confirmar. Se generan los vouchers con tipo `COMPLIMENTARY`.

---

### 4.6 Activaciones y reenvío de emails

La sección **Activaciones** muestra el contexto completo de todas las activaciones de la plataforma:

- Estudiante (nombre, email)
- Partner que activó
- Curso activado
- Estado de la matrícula en Moodle
- Estado del email enviado
- Fecha de expiración del acceso

**Reenviar email al estudiante (Admin):**

El administrador puede reenviar el email de acceso a cualquier activación, sin límites de reintentos:

1. Ir a **Activaciones**.
2. Localizar la activación.
3. Hacer clic en **Reenviar email**.

> A diferencia de los partners, el administrador no tiene cooldown ni límite de intentos.

---

### 4.7 Dashboard y reportes

El Dashboard proporciona una vista general del estado de la plataforma con filtros avanzados:

**Filtros disponibles:**
- Rango de fechas
- Curso
- Canal de venta
- Estado de voucher (AVAILABLE, CONSUMED, EXPIRED)
- Medio de pago
- Partner

**Métricas mostradas:**
- Vouchers totales, activos, consumidos, expirados
- Completaciones de cursos
- Volumen de compras por período

---

### 4.8 Integración con Moodle

Desde la sección **Moodle** el administrador puede:

| Acción | Descripción |
|--------|-------------|
| **Test de conexión** | Verifica que el servicio de Moodle responde correctamente |
| **Listar cursos Moodle** | Muestra todos los cursos disponibles en el campus Moodle |
| **Ver estado de mapeos** | Indica qué cursos locales están vinculados a Moodle y cuáles no |

**Sincronización automática (en background):**

El sistema ejecuta trabajos automáticos periódicos:

| Proceso | Frecuencia | Descripción |
|---------|-----------|-------------|
| Sincronización de completaciones | ~5 min | Marca como COMPLETED a los estudiantes que terminaron el curso en Moodle |
| Sincronización de cursos | ~10 min | Descarga nuevos cursos de Moodle |
| Reintento de matrículas fallidas | ~15 min | Reintenta matrículas que fallaron en el primer intento |

---

### 4.9 Sincronización con Stripe

Desde **Admin → Stripe → Sincronizar clientes**:

- **Sincronización inmediata:** Descarga todos los clientes de Stripe y los asocia con los partners correspondientes.
- **Sincronización en background:** Ejecuta el proceso sin bloquear la interfaz. Se puede consultar el estado del job en cualquier momento.

Esta sincronización es útil cuando se agregan nuevos partners o cuando se realizaron pagos fuera del flujo normal.

---

## 5. Panel de Partner

El panel de partner es el área de trabajo del distribuidor. Solo muestra la información propia del partner autenticado.

---

### 5.1 Ver cursos disponibles

Desde la sección **Cursos** el partner puede ver el catálogo de cursos disponibles para su perfil, incluyendo:

- Nombre del curso
- Descripción
- Precio unitario según su perfil de precios asignado

---

### 5.2 Carrito de compra

El partner puede agregar cursos al carrito de compra:

1. Seleccionar un curso del catálogo.
2. Ingresar la **cantidad de vouchers** deseada.
3. El sistema calcula automáticamente el precio total según el perfil de precios y los rangos por volumen.
4. Hacer clic en **Agregar al carrito**.

El carrito se guarda localmente en el navegador. Se puede continuar agregando cursos antes de finalizar la compra.

---

### 5.3 Proceso de pago con Stripe

1. Desde el carrito, hacer clic en **Pagar / Ir a Checkout**.
2. El sistema crea una sesión de pago en Stripe y redirige al checkout de Stripe.
3. Ingresar los datos de tarjeta y confirmar el pago.
4. Stripe redirige de vuelta a la plataforma con el resultado.

**La plataforma espera automáticamente la confirmación del pago** (hasta ~20 segundos mediante polling). Una vez confirmado:
- Se generan los vouchers automáticamente.
- El carrito se limpia.
- Se actualiza la lista de vouchers disponibles.

> **Tarjeta de prueba (entorno de testing):**  
> Número: `4242 4242 4242 4242`  
> Expiración: cualquier fecha futura  
> CVC: cualquier 3 dígitos

---

### 5.4 Ver y gestionar vouchers

Desde la sección **Vouchers** el partner puede ver todos sus vouchers con los siguientes datos:

| Campo | Descripción |
|-------|-------------|
| Código | Código único del voucher (12 caracteres) |
| Estado | AVAILABLE, CONSUMED o EXPIRED |
| Tipo | STANDARD (comprado) o COMPLIMENTARY (otorgado) |
| Curso | Nombre del curso (solo si fue activado) |
| Estudiante | Email del estudiante (solo si fue activado) |
| Fecha de compra | Cuándo se generó el voucher |

**Filtros disponibles:** por estado, curso, fechas.

---

### 5.5 Activar un voucher

La activación consume un voucher disponible y matricula a un estudiante en el curso correspondiente.

**Pasos para activar:**

1. Ir a **Activar voucher** (o desde la sección de Vouchers).
2. Completar el formulario:

   | Campo | Descripción |
   |-------|-------------|
   | Curso | Seleccionar el curso para el que se activa |
   | Nombre del estudiante | Nombre completo |
   | Email del estudiante | Correo electrónico (se usa para la cuenta en Moodle) |
   | Cliente final | Nombre de la empresa o cliente que recibe el curso |
   | Meses de acceso | Duración del acceso al campus virtual |

3. Confirmar la activación.

**¿Qué ocurre al activar?**

1. El sistema selecciona automáticamente el primer voucher AVAILABLE del partner.
2. Cambia el estado del voucher a CONSUMED.
3. Crea la matrícula en Moodle:
   - Si el estudiante es nuevo en Moodle: se crea su cuenta y se genera una contraseña temporal.
   - Si ya tiene cuenta: se le agrega el nuevo curso.
4. Se envía un **email al estudiante** con sus credenciales de acceso y el link al campus.
5. Se registra la activación con fecha de expiración calculada.

> **Importante:** La elegibilidad para activar se verifica automáticamente. Si no hay vouchers disponibles pagados, el sistema mostrará un aviso antes de intentar activar.

---

### 5.6 Reenviar email al estudiante

Si el estudiante no recibió su email de acceso, el partner puede reenviarlo:

1. Ir a **Activaciones**.
2. Localizar la activación correspondiente.
3. Hacer clic en **Reenviar email**.

**Límites para partners:**
- Se puede reenviar **1 vez** (configurable por el administrador).
- Debe haber pasado al menos **10 minutos** desde el último intento.

Si necesita más reenvíos, contactar al administrador.

---

### 5.7 Clientes finales

El partner puede mantener un directorio de sus clientes finales (empresas o personas que reciben los cursos):

- **Listar clientes finales** registrados.
- **Agregar un cliente final:** Nombre y datos de contacto.
- **Eliminar un cliente final.**

Este directorio facilita completar el formulario de activación sin tener que escribir el nombre del cliente cada vez.

---

### 5.8 Historial de compras

Desde la sección **Compras** el partner puede ver todas sus compras anteriores:

| Campo | Descripción |
|-------|-------------|
| ID de compra | Identificador interno |
| Fecha | Fecha y hora de la compra |
| Cantidad | Número de vouchers comprados |
| Total | Monto pagado |
| Estado | PAID, PENDING, FAILED, REFUNDED |
| Canal | Medio de pago (Stripe, manual, etc.) |

Cada compra tiene un **historial de eventos de transacción** que muestra los cambios de estado del pago (útil para auditoría).

---

## 6. Flujo completo de extremo a extremo

```
┌──────────────────────────────────────────────────────────────────┐
│               FLUJO COMPLETO: DE COMPRA A CERTIFICACIÓN          │
└──────────────────────────────────────────────────────────────────┘

[ADMIN] Configura cursos + perfiles de precios + mapeo Moodle
              ↓
[ADMIN] Crea usuario con rol "partner" + crea partner
              ↓
[PARTNER] Inicia sesión → navega al catálogo de cursos
              ↓
[PARTNER] Agrega cursos al carrito (ej: 10 vouchers de Curso A)
              ↓
[PARTNER] Hace clic en "Pagar" → redirige a Stripe Checkout
              ↓
[STRIPE] Partner ingresa tarjeta → pago exitoso
              ↓
[SISTEMA] Webhook de Stripe → genera 10 vouchers AVAILABLE
              ↓
[PARTNER] Ve los 10 vouchers disponibles en su panel
              ↓
[PARTNER] Activa voucher:
          - Ingresa datos del estudiante
          - Sistema selecciona voucher → status CONSUMED
          - Matrícula automática en Moodle
          - Email con credenciales enviado al estudiante
              ↓
[ESTUDIANTE] Recibe email → accede al campus Moodle → completa el curso
              ↓
[SISTEMA] Job automático detecta completación → registra en plataforma
              ↓
[ADMIN/PARTNER] Ven el voucher con estado "Completado"
```

---

## 7. Notificaciones de email

El sistema envía emails automáticamente en los siguientes casos:

### Email de bienvenida (estudiante nuevo)

**Cuándo:** Al activar un voucher para un estudiante que no tiene cuenta en Moodle.

**Contenido:**
- Nombre del estudiante
- Contraseña temporal de Moodle
- Link al campus virtual
- Nombre del curso matriculado
- Duración del acceso (en meses)

### Email de nuevo curso (estudiante existente)

**Cuándo:** Al activar un voucher para un estudiante que ya tiene cuenta en Moodle.

**Contenido:**
- Link al campus virtual
- Nombre del nuevo curso
- Duración del acceso

### Reenvío de email

Disponible para partners (con límites) y administradores (sin límites).

---

## 8. Estados y significados

### Estados de Voucher

| Estado | Significado |
|--------|-------------|
| `AVAILABLE` | Voucher pagado y listo para activar |
| `CONSUMED` | Voucher activado, asignado a un estudiante |
| `EXPIRED` | Voucher que expiró sin ser utilizado |

### Estados de Pago

| Estado | Significado |
|--------|-------------|
| `PENDING` | Compra creada, esperando confirmación de Stripe |
| `PAID` | Pago confirmado, vouchers generados |
| `PROCESSING` | Stripe está procesando el pago |
| `FAILED` | El pago fue rechazado |
| `REFUNDED` | Pago devuelto |

### Estados de Matrícula Moodle

| Estado | Significado |
|--------|-------------|
| `PENDING` | Matrícula pendiente de procesar |
| `ENROLLED` | Estudiante matriculado en Moodle |
| `COMPLETED` | Estudiante completó el curso |
| `FAILED` | Error al matricular (se reintenta automáticamente) |
| `SKIPPED` | Curso no tiene mapeo Moodle configurado |
| `MOCKED` | Matrícula simulada (entorno de desarrollo) |

### Estados de Activación

| Estado | Significado |
|--------|-------------|
| `ACTIVE` | Activación vigente |
| `EXPIRED` | Fecha de expiración superada |
| `REVOKED` | Activación revocada manualmente por el administrador |

### Estados de Email

| Estado | Significado |
|--------|-------------|
| `SENT` | Email enviado correctamente |
| `FAILED` | Error al enviar el email |
| `PENDING` | Email en cola para enviar |

---

## 9. Preguntas frecuentes

**¿El estudiante no recibió su email de acceso, qué hago?**  
Como partner, ve a la sección Activaciones, localiza la activación y haz clic en "Reenviar email". Si ya usaste el intento disponible o pasaron menos de 10 minutos, contacta al administrador para que lo reenvíe sin restricciones.

**¿Cómo sé si un pago fue procesado correctamente?**  
En la sección Compras, el estado debe mostrar `PAID`. Si aparece `PENDING` por más de unos minutos, puede haber un problema con el webhook de Stripe. Contacta al administrador.

**¿Qué pasa si la matrícula en Moodle falla?**  
El sistema reintenta automáticamente cada ~15 minutos. El estado del voucher mostrará `FAILED` mientras tanto. Si persiste, el administrador puede revisar la conexión Moodle desde el panel de administración.

**¿Puedo activar un voucher sin conexión a Moodle?**  
Sí. La matrícula en Moodle no bloquea la activación. Si Moodle no está disponible, el voucher se consume igual y la matrícula queda en estado `PENDING` para reintentarse automáticamente.

**¿Puedo ver los vouchers de otros partners?**  
No. El sistema aplica aislamiento estricto por partner. Cada partner solo puede ver y gestionar sus propios datos.

**¿Cómo sé cuántos vouchers puedo activar?**  
La sección de Vouchers muestra el total de vouchers con estado AVAILABLE. También puedes ver las estadísticas generales de tu cuenta (total, disponibles, consumidos, completados) en el panel principal del partner.

**¿Qué es un voucher Complimentary?**  
Son vouchers otorgados por el administrador sin costo (sin pago de Stripe). Funcionan exactamente igual que los vouchers STANDARD para efectos de activación.

**¿Los precios cambian según cuánto compro?**  
Sí, si tu perfil de precios tiene reglas por volumen. Al agregar productos al carrito, el precio unitario se ajusta automáticamente según el rango de cantidad que aplique.

---

*Para soporte técnico o consultas sobre configuración, contactar al administrador de la plataforma.*
