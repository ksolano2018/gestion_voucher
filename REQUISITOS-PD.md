# Requisitos previos al despliegue a Producción — CertJoin Vouchers

> **Contexto:** la aplicación es un stack **Docker** (gateway Caddy + 4 microservicios Node
> + PostgreSQL + frontend) que corre en su propio host y se integra con el **Moodle
> existente** del cliente por Web Services. La página web del cliente solo **enlaza** a la
> app en un subdominio (no la contiene).
>
> **Servidor de destino (confirmado por SSH, 2026-07-03):** `76.13.114.140`, **Ubuntu 24.04**,
> **8 vCPU**, **31 GB RAM** (~26 GB disponibles), disco **387 GB (317 GB libres)**, gestionado
> con **CloudPanel** (NGINX). Recursos de sobra. El acceso entregado (`certjoin-v`) es un
> **usuario de sitio de CloudPanel** (sin sudo, pero **con acceso al daemon de Docker**, ya
> instalado). **La app irá detrás del reverse proxy de CloudPanel.**

## Arquitectura objetivo (detrás de CloudPanel)

```
Internet ─▶ NGINX de CloudPanel (:80/:443, SSL Let's Encrypt)
                │  sitio "Reverse Proxy": vouchers.certjoin.com
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

## A) El servidor — estado y acciones

**Estado confirmado (`76.13.114.140`):**

| Recurso | Valor | Veredicto |
|---|---|---|
| SO | Ubuntu 24.04.3 LTS | ✅ |
| CPU | 8 vCPU | ✅ |
| RAM | 31 GB (~26 GB disponibles) + 2 GB swap | ✅ de sobra |
| Disco | 387 GB, 317 GB libres | ✅ de sobra |
| Panel | CloudPanel (NGINX + reverse proxy + Let's Encrypt) | ✅ resuelve HTTPS/proxy |
| git / curl / wget | ya instalados | ✅ |
| Salida a internet | GitHub / Docker Hub alcanzables | ✅ |
| **Docker Engine** | **29.6.1** (Compose **v5.3.0**), servicio `active` | ✅ **instalado** |
| **`certjoin-v` usa el daemon** | `docker ps` / `docker info` sin sudo | ✅ **resuelto** |

> Los recursos (RAM/CPU/disco) **ya no son un problema** en este servidor. Antes se evaluó
> uno de 4 GB que no alcanzaba; este de 31 GB corre el stack cómodo.

**Infra — RESUELTO ✅ (verificado por SSH, 2026-07-09):**

Docker **ya está instalado y operativo**: Docker **29.6.1** + Compose **v5.3.0**, servicio
`active`, y `certjoin-v` **alcanza el daemon sin sudo** (`docker ps` y `docker info` funcionan).
De hecho durante la prueba de primer arranque se levantó el stack completo en este servidor.

> Nota: `certjoin-v` no figura en el grupo `docker` (`id -nG`), pero igual accede al socket del
> daemon (permisos ya configurados). No hay que instalar ni cambiar nada de infra.

**Nada más que instalar:** todo lo demás va en contenedores (Node, PostgreSQL, Caddy) o ya
está (NGINX de CloudPanel). git y curl ya están presentes.

**Reverse proxy (CloudPanel, cuando el stack esté arriba):** crear/convertir el sitio de
`vouchers.certjoin.com` a **Reverse Proxy** → destino `http://127.0.0.1:3000`, y emitir el
certificado en **SSL/TLS → New Let's Encrypt Certificate** (hoy hay uno self-signed).

---

## B) Datos a solicitar al cliente (integraciones)

### Dominio / DNS
- El subdominio **`vouchers.certjoin.com`** con registro **A → `76.13.114.140`** (la IP de
  este servidor). CloudPanel le pone el SSL. La web del cliente enlazará a él.

### Acceso al repositorio (para `git clone` / `git pull`) — ✅ RESUELTO
- Ya se cuenta con un **token de acceso** al repo privado `gestion_voucher`. El servidor clona
  con `git clone -b production https://<TOKEN>@github.com/<owner>/gestion_voucher.git app` y
  luego actualiza con `git pull` + `./deploy.sh`.
- El token va **solo en el servidor** (comando de clone o `.env`), **nunca** se commitea.

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
- **Webhook** apuntando a `https://vouchers.certjoin.com/webhook/stripe` y su **signing secret**.

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

## D) De nuestro lado — LISTO ✅

Ya está preparado en la rama **`production`** del repo:
- `docker-compose.yml` con binds configurables (gateway en `127.0.0.1:3000` en PD).
- `.env.production.example` (raíz y app) y `deploy.sh` (sin TLS ni perfil moodle).
- `DEPLOY-PD.md` con la guía de primer arranque (CloudPanel + reverse proxy).

---

## Resumen ejecutivo (qué falta para arrancar)

| # | Pendiente | Responsable | Estado |
|---|---|---|---|
| 1 | **Docker** instalado + `certjoin-v` usa el daemon | Admin/proveedor | ✅ **resuelto** (verificado 2026-07-09) |
| 2 | **Token** de acceso al repo privado | Cliente/nosotros | ✅ **resuelto** |
| 3 | Datos de **Moodle** (URL + token WS + role ID + campus + cursos) | Cliente | ⛔ pendiente |
| 4 | Datos de **Stripe live** (`pk`/`sk`/`whsec` + webhook) | Cliente | ⛔ pendiente |
| 5 | Datos de **SMTP** (host/puerto/user/pass + from + SPF/DKIM) | Cliente | ⛔ pendiente |
| 6 | Registro **A** de `vouchers.certjoin.com` → `76.13.114.140` | Cliente | ⛔ pendiente |
| 7 | Correos **admin/partner** iniciales | Cliente | ⛔ pendiente |
| 8 | **Reverse Proxy** + Let's Encrypt en CloudPanel (cuando el stack esté arriba) | Nosotros | ⏳ al final |
| 9 | Artefactos de despliegue (rama `production`) | Nosotros | ✅ listo |

**Infra, código y acceso al repo ya están resueltos.** El arranque real depende ahora **solo de
los datos del cliente (3–7)**. Con esos datos se corre el wizard `setup.sh` y luego se crea el
Reverse Proxy + certificado en CloudPanel siguiendo `DEPLOY-PD.md`.
