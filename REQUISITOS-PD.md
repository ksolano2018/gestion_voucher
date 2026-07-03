# Requisitos previos al despliegue a Producción — CertJoin Vouchers

> **Contexto:** la aplicación es un stack **Docker** (gateway Caddy + 4 microservicios Node
> + PostgreSQL + frontend) que corre en su **propio host** y se integra con el **Moodle
> existente** del cliente por Web Services. La página web del cliente solo **enlaza** a la
> app en un subdominio (no la contiene). Una cuenta de **hosting compartido** no sirve
> (sin Docker/sudo, puertos 80/443 ocupados, RAM insuficiente): se requiere un **VPS con
> Docker y acceso root**.

## Arquitectura objetivo

```
[ Página web del cliente ]  --enlace-->  https://vouchers.tudominio.com
      (hosting actual)                            │
                                                  ▼
                                   [ VPS con Docker ]  ← la app (gateway + microservicios
                                                  │        + frontend + PostgreSQL)
                                                  │  (llamadas Web Services)
                                                  ▼
                                   [ Moodle del cliente ]  (se queda donde está)
```

- La web solo suma un botón/enlace al subdominio de la app.
- Moodle no se mueve; la app lo consume por WS.
- En Producción **no** se despliega el Moodle dockerizado (`--profile local-moodle` desactivado).

---

## A) Preguntas para el proveedor / infraestructura (el servidor)

1. ¿Ofrecen un **VPS con acceso root/sudo** (no hosting compartido/panel)?
2. ¿Podemos **instalar Docker Engine + Docker Compose v2**?
3. ¿Los **puertos 80 y 443 quedan libres** para la app (sin otro servidor web escuchándolos)? + 22 para SSH.
4. ¿Da **IP pública fija**?

**Especificaciones mínimas del servidor:**

| Recurso | Mínimo |
|---|---|
| SO | Ubuntu 22.04 / 24.04 (o Debian) |
| Acceso | root / sudo |
| RAM | ≥ 2 GB **libres** (recomendado 4 GB) |
| CPU | 1–2 vCPU |
| Disco | ≥ 20 GB libres |
| Puertos | 80, 443 y 22 libres |
| Red | salida a internet (GitHub, Docker Hub, Let's Encrypt) |

> Cualquier plan **VPS** estándar cumple (Hetzner, DigitalOcean, Linode, Contabo, o el tier
> VPS del mismo proveedor). Lo que **no** encaja es un plan de **hosting compartido/panel**.

---

## B) Datos a solicitar al cliente (integraciones)

### Dominio / DNS
- Un **subdominio** (ej. `vouchers.sudominio.com`) con registro **A → IP del VPS**.
  Se usa para el HTTPS de la app, el webhook de Stripe y el enlace desde la web.

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

- Ajustar **`deploy.sh`** para incluir el override TLS (`docker-compose.tls.yml`) y el
  dominio del cliente (`SITE_ADDRESS`).
- Crear **`servicios/servicio-usuarios/.env.production.example`** (plantilla de la app) y la
  guía **`DEPLOY-PD.md`** (primer arranque).
- PRD corre **sin** `--profile local-moodle` (Moodle externo): `COMPOSE_PROFILES=` vacío y
  `MOODLE_URL` = Moodle del cliente.

---

**Bloqueante #1: el punto A.** Sin un host con Docker/root y 80/443 libres, no se puede
desplegar. El resto (dominio, Moodle, Stripe, SMTP) se puede ir consiguiendo en paralelo.
