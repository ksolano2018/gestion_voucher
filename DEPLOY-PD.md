# Despliegue a Producción — CertJoin Vouchers (VPS + CloudPanel)

Guía de **primer arranque** y de **actualizaciones**. La app corre en Docker y queda
**detrás del reverse proxy de CloudPanel** (que pone el HTTPS). Los `.env` viven **solo en
el servidor**; `deploy.sh` **nunca** los toca.

> Antes de empezar, revisar **`REQUISITOS-PD.md`**. En el servidor actual (31 GB RAM, 8 vCPU)
> los recursos sobran; lo único de infra es tener **Docker** instalado y que el usuario de
> despliegue pueda usarlo. Moodle y correo son los del cliente (no se despliegan aquí).

**Modelo de credenciales (gobernanza):** el **admin es del cliente** y el **soporte es
nuestro** (rol `soporte` = admin operativo **sin** gestión de usuarios/roles, revocable por
el cliente). Ambos se siembran con contraseña **temporal** y **cambio obligatorio al primer
login** → nadie conoce la contraseña definitiva del otro. Los secretos de infra
(`DB_PASSWORD`, `JWT_SECRET`, `INTERNAL_API_TOKEN`) se generan fuertes y quedan solo en el server.

---

## 0. Prerrequisitos
- VPS Ubuntu 22.04/24.04.
- **Docker Engine + Docker Compose v2** instalados y el **usuario de despliegue puede usar
  docker** (en el grupo `docker`, o root). Si no está, ver paso 1.
- Un **subdominio** (ej. `vouchers.certjoin.com`) con registro **A → IP del VPS**.
- Acceso de **lectura al repositorio** (deploy key SSH o token) para `git clone`/`git pull`.
- Datos del cliente (ver `REQUISITOS-PD.md`): Moodle (URL + token WS + role id), **Stripe
  (keys + webhook secret)**, SMTP.

## 1. Instalar Docker (solo si falta — requiere root, una vez)
```bash
curl -fsSL https://get.docker.com | sh          # Docker Engine + Compose v2 + buildx
usermod -aG docker <usuario_de_despliegue>       # que use docker sin sudo (re-login tras esto)
docker --version && docker compose version       # verificar
```
> En el servidor actual Docker ya está instalado y el usuario de sitio (`certjoin-v`) ya
> puede usarlo — este paso puede no ser necesario.

## 2. Clonar el repositorio
Como usuario de despliegue (ej. `certjoin-v`), en su **home** (fuera de `htdocs`):
```bash
git clone -b production <URL_DEL_REPO> ~/app
cd ~/app        # ej. /home/certjoin-v/app
```
> Los **datos** (Postgres, etc.) viven en **volúmenes de Docker** (`/var/lib/docker/volumes`),
> no en esta carpeta → sobreviven a `git pull`, rebuilds y a borrar/reclonar `app`.

## 3. Configurar y desplegar

### Opción A — Wizard (recomendada)
```bash
bash setup.sh
```
El wizard: genera los secretos de infra, pregunta la config del cliente (subdominio, Moodle,
Stripe, SMTP), crea contraseñas **temporales** para admin y soporte (con cambio obligatorio),
escribe los dos `.env` (chmod 600), levanta el stack y muestra un **resumen** con las
credenciales — separando lo que se **entrega al cliente** (admin) de lo **nuestro** (soporte).
Guarda ese resumen: las temporales no se vuelven a mostrar.

### Opción B — Manual
```bash
cp .env.production.example .env
cp servicios/servicio-usuarios/.env.production.example servicios/servicio-usuarios/.env
# Editar ambos y reemplazar los CAMBIAR_*  (secretos: openssl rand -hex 32)
chmod 600 .env servicios/servicio-usuarios/.env
./deploy.sh
```
Claves al rellenar: `DB_PASSWORD` debe coincidir en los dos `.env`; `COMPOSE_PROFILES=` vacío;
binds `127.0.0.1` ya puestos; `SEED_FORCE_PASSWORD_CHANGE=true`; define `SUPPORT_EMAIL`/
`SUPPORT_PASSWORD` para crear la cuenta de soporte.

**Verificar que está arriba (localhost):**
```bash
docker compose ps
curl -s http://127.0.0.1:3000/health
```
El gateway queda en **`127.0.0.1:3000`** (no expuesto a internet).

## 4. Publicar el subdominio en CloudPanel (reverse proxy + SSL)
1. **Sites → Add Site → Create a Reverse Proxy.**
2. **Domain name:** `vouchers.certjoin.com`  ·  **Reverse Proxy URL:** `http://127.0.0.1:3000`.
3. En el sitio: **SSL/TLS → New Let's Encrypt Certificate** (con el registro A ya apuntando al VPS).
4. Probar: `https://vouchers.certjoin.com` debe cargar el frontend.

> CloudPanel/NGINX ya escucha en 80/443 y termina el HTTPS; nosotros no tocamos esos puertos.
> Si el sitio existe como sitio PHP, recréalo como **Reverse Proxy** (o edita su Vhost para
> `proxy_pass http://127.0.0.1:3000;`).

## 5. Moodle del cliente (una vez)
La app usa el **Moodle existente** por Web Services. Verificar con su admin que:
- El **servicio externo de WS** está habilitado con las **9 funciones** de `REQUISITOS-PD.md`
  y hay un **token** (va en `MOODLE_TOKEN`).
- Los **cursos/certificaciones** tienen la estructura para validar *completado/certificado*.
  Si falta, se coordina provisionar.
- El **role id de estudiante** (`MOODLE_ROLE_ID`, por defecto 5) es correcto.

## 6. Stripe (una vez)
Webhook en Stripe (modo live) → `https://vouchers.certjoin.com/webhook/stripe`; su **signing
secret** va en `STRIPE_WEBHOOK_SECRET` (el wizard ya lo pidió; Stripe lo entrega al crear el
endpoint aunque la URL no esté viva aún).

## 7. Verificación end-to-end
- Login **admin** (temporal) → fuerza cambio de contraseña → catálogo con cursos de Moodle.
- Login **soporte** (temporal) → fuerza cambio → verifica que NO ve gestión de usuarios/roles.
- Compra de prueba (Stripe) → voucher → activación → matrícula en Moodle + correo.

---

## Actualizaciones (despliegues siguientes)
```bash
cd ~/app
./deploy.sh          # git pull + rebuild; NO toca los .env
```

## Respaldo de la base de datos
```bash
docker exec proyecto-db pg_dump -U admin voucherdb > backup_$(date +%F).sql
```

## Notas
- **No** se usa `docker-compose.tls.yml` en PD (CloudPanel hace el TLS).
- **No** se levanta el Moodle dockerizado (`COMPOSE_PROFILES=` vacío).
- Puertos internos (gateway 3000, Postgres 5432, API 8081) quedan en **localhost**; el único
  acceso público es el subdominio vía CloudPanel.
- El wizard **no** se puede re-ejecutar sobre un `.env` existente (protege los secretos y la
  BD ya inicializada). Para reconfigurar, editar el `.env` a mano y `./deploy.sh`.
