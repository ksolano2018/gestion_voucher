# Requisitos previos al despliegue a Producción — CertJoin Vouchers

> **Contexto:** la aplicación es un stack **Docker** (gateway Caddy + 4 microservicios Node
> + PostgreSQL + frontend) que corre en su propio host y se integra con el **Moodle
> existente** del cliente por Web Services. La página web del cliente solo **enlaza** a la
> app en un subdominio (no la contiene).
>
> **Servidor de destino (confirmado por SSH, 2026-07-03):** el mismo VPS que ya aloja la web
> y Moodle — `srv1255468` / `72.62.173.253`, **Ubuntu 24.04**, **1 vCPU**, **4 GB RAM**,
> disco 47 GB (~50% libre), gestionado con **CloudPanel** (NGINX). El acceso entregado
> (`cert-v`) es un **usuario del panel** (sin Docker ni sudo). **La app irá detrás del
> reverse proxy de CloudPanel.**

## Arquitectura objetivo (detrás de CloudPanel)

```
Internet ─▶ NGINX de CloudPanel (:80/:443, SSL Let's Encrypt)
                │  sitio "Reverse Proxy": vouchers.dominio.com
                ▼
          http://127.0.0.1:3000  ← gateway (Caddy, solo localhost, SIN TLS propio)
                └▶ stack Docker (usuarios / compras / moodle / notificaciones / frontend / Postgres)
                                  └▶ Moodle del cliente (por Web Services)
```

- CloudPanel/NGINX es el **único que toca 80/443** y termina el HTTPS → nosotros **no** los ocupamos ni usamos `docker-compose.tls.yml`.
- El gateway se enlaza a **`127.0.0.1:3000`** (no expuesto a internet); CloudPanel le hace proxy.
- La página web del cliente solo suma un **enlace** al subdominio.
- Moodle no se mueve; la app lo consume por WS. En Producción **no** se despliega el Moodle dockerizado (`--profile local-moodle` desactivado).

---

## A) El servidor — estado y acciones (con el proveedor / admin)

**Estado confirmado del VPS:**

| Recurso | Valor | Veredicto |
|---|---|---|
| SO | Ubuntu 24.04 | ✅ |
| CPU | 1 vCPU (load < 1) | ✅ ok |
| **RAM** | **4 GB, ~90% en uso (≈400 MB libres)** | ❌ **insuficiente — bloqueante** |
| Disco | 47 GB, ~50% libre (~23 GB) | ✅ ok |
| Panel | CloudPanel (NGINX + reverse proxy + Let's Encrypt) | ✅ resuelve HTTPS/proxy |
| Salida a internet | GitHub / Docker Hub alcanzables | ✅ |

**Acciones / preguntas pendientes:**

1. **RAM — el bloqueante.** Con ~400 MB libres el stack **no arranca** (necesita ~0.7–1 GB en marcha + picos en el build). **Ampliar el VPS a ≥ 6 GB (ideal 8 GB).**
   - *Stopgap si no se puede ya:* añadir **swap** (~4 GB) para evitar OOM — funciona pero más lento, no recomendado como solución final.
2. **Acceso root/sudo** para instalar **Docker Engine + Docker Compose v2**. El usuario del panel `cert-v` **no sirve** (sin sudo). *(El admin de CloudPanel suele tener root SSH del servidor; alternativa: que el admin instale Docker y nos dé un usuario en el grupo `docker`.)*
3. **CloudPanel:** crear un sitio **Reverse Proxy** para el subdominio → destino `http://127.0.0.1:3000`, con **SSL Let's Encrypt** activado. *(CloudPanel ya maneja 80/443 → no hace falta liberarlos.)*

---

## B) Datos a solicitar al cliente (integraciones)

### Dominio / DNS
- Un **subdominio** (ej. `vouchers.sudominio.com`) con registro **A → `72.62.173.253`**
  (la IP del mismo VPS). CloudPanel le pone el SSL. La web del cliente enlazará a él.

### Moodle (el suyo — no desplegamos uno)
- **URL base** del Moodle, accesible desde el VPS.
- **Token de Web Services** (o acceso admin para crearlo) con servicio externo habilitado y
  estas **9 funciones**:
  - `core_user_create_users`
  - `core_user_get_users_by_field`
  - `core_user_update_users`
  - `enrol_manual_enrol_users`
  - `core_course_get_courses`
  - `core_completion_get_course_completion_status`
  - `core_completion_get_activities_completion_status`
  - `mod_quiz_get_quizzes_by_courses`
  - `mod_quiz_get_user_best_grade`
- **Cursos/certificaciones** con estructura para validar *completado/certificado*
  (finalización activada + quiz con preguntas y nota de aprobación) y su **mapeo de IDs**.
  Si falta, lo provisionamos nosotros con acceso admin (ya tenemos los scripts).
- **Role id de estudiante** (por defecto `5`, confirmar en su Moodle).
- **URL de login del Campus** (para el botón del correo de bienvenida).

### Stripe (cuenta del cliente, modo live)
- **Publishable key** + **Secret key**.
- **Webhook** apuntando a `https://<subdominio>/webhook/stripe` y su **signing secret**.

### Correo (SMTP del cliente)
- Host, puerto, seguridad (SSL/TLS), usuario y contraseña.
- **Remitente** (`MAIL_FROM`) y **reply-to**.
- **SPF/DKIM** del dominio remitente configurados (para no caer en spam).

### Credenciales iniciales de la app
- Correo/clave del **admin** y del **partner** iniciales (o política para setearlas).
- (Opcional) URL pública de un **logo** para el correo (`MAIL_LOGO_URL`).

---

## C) Lo que generamos nosotros (NO pedir al cliente)

`DB_PASSWORD`, `JWT_SECRET`, `INTERNAL_API_TOKEN` — secretos internos fuertes que van en el
`.env` del servidor (el cliente es el dueño del archivo, en el VPS).

---

## D) Pendientes de nuestro lado (antes de desplegar)

- Adaptar el stack al modo **"detrás de CloudPanel"**: gateway enlazado a **`127.0.0.1:3000`**
  (solo localhost), **sin** `docker-compose.tls.yml` (CloudPanel termina el HTTPS),
  `FRONTEND_URL = https://<subdominio>`.
- Ajustar **`deploy.sh`** a ese modo y **sin** `--profile local-moodle` (Moodle externo):
  `COMPOSE_PROFILES=` vacío y `MOODLE_URL` = Moodle del cliente.
- Crear **`servicios/servicio-usuarios/.env.production.example`** (plantilla de la app) y la
  guía **`DEPLOY-PD.md`** (primer arranque + provisión de Moodle si aplica).

---

## Resumen ejecutivo (qué falta para arrancar)

| # | Pendiente | Responsable |
|---|---|---|
| 1 | **Ampliar RAM del VPS a ≥6 GB** (bloqueante #1) | Proveedor / cliente |
| 2 | **Root/sudo** para instalar Docker | Proveedor / admin |
| 3 | Elegir **subdominio** + registro A → 72.62.173.253 | Cliente |
| 4 | Datos de **Moodle, Stripe, SMTP** (sección B) | Cliente |
| 5 | Adaptar `deploy.sh` + `.env` + `DEPLOY-PD.md` (modo CloudPanel) | Nosotros |

**Sin (1) y (2) no se puede desplegar.** El reverse proxy + SSL ya están resueltos por
CloudPanel; el resto se consigue en paralelo.
