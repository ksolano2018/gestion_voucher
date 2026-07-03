# Despliegue a Producción — CertJoin Vouchers (VPS + CloudPanel)

Guía de **primer arranque** y de **actualizaciones**. La app corre en Docker y queda
**detrás del reverse proxy de CloudPanel** (que pone el HTTPS). Los `.env` viven **solo en
el servidor** (el cliente es dueño de sus credenciales); `deploy.sh` **nunca** los toca.

> Antes de empezar, revisar **`REQUISITOS-PD.md`**. Bloqueantes: **RAM ≥ 6 GB** y **root** en
> el VPS. Moodle y correo son los del cliente (no se despliegan aquí).

---

## 0. Prerrequisitos
- VPS Ubuntu 22.04/24.04 con **root/sudo** y **≥ 6 GB RAM** libres.
- **Docker Engine + Docker Compose v2** (se instala en el paso 1).
- Un **subdominio** (ej. `vouchers.tudominio.com`) con registro **A → IP del VPS**.
- Acceso de **lectura al repositorio** (deploy key SSH o token) para `git clone`/`git pull`.
- Datos listos (ver `REQUISITOS-PD.md`): Moodle (URL + token WS + role id), Stripe (keys +
  webhook secret), SMTP.

## 1. Instalar Docker (como root, una sola vez)
```bash
curl -fsSL https://get.docker.com | sh          # instala Docker Engine + Compose v2
docker --version && docker compose version       # verificar
# (opcional) permitir a un usuario usar docker sin sudo:
usermod -aG docker <usuario>                      # cerrar y reabrir sesión tras esto
```

## 2. Clonar el repositorio
```bash
sudo mkdir -p /opt/certjoin && sudo chown "$USER" /opt/certjoin
git clone -b production <URL_DEL_REPO> /opt/certjoin/app
cd /opt/certjoin/app
```

## 3. Crear los dos `.env` internos (y completarlos)
```bash
cp .env.production.example .env
cp servicios/servicio-usuarios/.env.production.example servicios/servicio-usuarios/.env
# Editar ambos y reemplazar todos los CAMBIAR_*  (nano/vim)
chmod 600 .env servicios/servicio-usuarios/.env
```
Puntos clave al rellenar:
- **`.env` (raíz):** `DB_PASSWORD`, `INTERNAL_API_TOKEN` (fuertes), `COMPOSE_PROFILES=` vacío,
  y los binds a localhost ya vienen puestos (`GATEWAY_BIND/DB_BIND/USUARIOS_BIND=127.0.0.1`).
- **`servicio-usuarios/.env`:** `FRONTEND_URL=https://<subdominio>`, `MOODLE_URL`/`MOODLE_TOKEN`
  del Moodle del cliente, `STRIPE_*`, `SMTP_*`, `ADMIN_PASSWORD`/`PARTNER_PASSWORD`.
  `DB_PASSWORD` debe coincidir con el del `.env` raíz.
- Generar secretos: `openssl rand -hex 32`.

## 4. Levantar la app
```bash
./deploy.sh
```
`deploy.sh` valida que existan los `.env`, hace `git pull`, `mkdir -p logs/usuarios` y
`docker compose up -d --build` (sin override TLS, sin perfil Moodle). El gateway queda en
**`127.0.0.1:3000`** (no expuesto a internet).

Verificar que está arriba (localhost):
```bash
docker compose ps
curl -s http://127.0.0.1:3000/health        # debe responder el gateway/app
```

## 5. Publicar el subdominio en CloudPanel (reverse proxy + SSL)
En el panel de CloudPanel:
1. **Sites → Add Site → Create a Reverse Proxy.**
2. **Domain name:** `vouchers.tudominio.com`  ·  **Reverse Proxy URL:** `http://127.0.0.1:3000`.
3. Crear el sitio y luego, en el sitio, **SSL/TLS → New Let's Encrypt Certificate** (con el
   registro A ya apuntando al VPS).
4. Probar: `https://vouchers.tudominio.com` debe cargar el frontend.

> CloudPanel/NGINX ya escucha en 80/443 y termina el HTTPS; nosotros no tocamos esos puertos.

## 6. Moodle del cliente (una vez)
La app usa el **Moodle existente** por Web Services. Verificar con su admin que:
- El **servicio externo de WS** está habilitado con las **9 funciones** listadas en
  `REQUISITOS-PD.md` y hay un **token** (va en `MOODLE_TOKEN`).
- Los **cursos/certificaciones** tienen la estructura para validar *completado/certificado*
  (finalización + quiz con preguntas y nota de aprobación). Si falta, se coordina provisionar.
- El **role id de estudiante** (`MOODLE_ROLE_ID`, por defecto 5) es correcto.
Tras poner `MOODLE_URL`/`MOODLE_TOKEN` en el `.env`, la app sincroniza los cursos por su cuenta.

## 7. Stripe (una vez)
En el dashboard de Stripe (modo live), crear un **webhook** hacia
`https://<subdominio>/webhook/stripe` y copiar su **signing secret** a `STRIPE_WEBHOOK_SECRET`.

## 8. Verificación end-to-end
- Login admin en `https://<subdominio>` con `ADMIN_EMAIL`/`ADMIN_PASSWORD`.
- Que el catálogo muestre los cursos sincronizados desde el Moodle del cliente.
- Una compra de prueba (Stripe) → voucher generado → activación → matrícula en Moodle + correo.

---

## Actualizaciones (despliegues siguientes)
```bash
cd /opt/certjoin/app
./deploy.sh          # git pull + rebuild; NO toca los .env
```

## Respaldo de la base de datos
```bash
docker exec proyecto-db pg_dump -U admin voucherdb > backup_$(date +%F).sql
```

## Notas
- **No** se usa `docker-compose.tls.yml` en PD (CloudPanel hace el TLS).
- **No** se levanta el Moodle dockerizado (`COMPOSE_PROFILES=` vacío).
- Los puertos internos (gateway 3000, Postgres 5432, API 8081) quedan en **localhost**; el
  único acceso público es el subdominio vía CloudPanel.
- Si el VPS tiene poca RAM, el `--build` puede fallar por OOM: ampliar RAM (recomendado) o
  añadir swap temporalmente.
