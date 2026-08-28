#!/usr/bin/env bash
#
# Asistente de PRIMER ARRANQUE (wizard) para PRODUCCIÓN — CertJoin Vouchers.
#
# Qué hace:
#   1. Genera los secretos de infra (DB_PASSWORD, JWT_SECRET, INTERNAL_API_TOKEN).
#   2. Pregunta la configuración del cliente (subdominio, Moodle, Stripe, SMTP).
#   3. Crea contraseñas TEMPORALES para el admin (del cliente) y el soporte (nuestro),
#      ambas con "cambio obligatorio al primer login" (SEED_FORCE_PASSWORD_CHANGE).
#   4. Escribe los dos .env con permisos 600.
#   5. Levanta el stack (./deploy.sh) y muestra un resumen con las credenciales
#      temporales, separando lo que se entrega al cliente de lo nuestro.
#
# Filosofía: nadie conoce la contraseña "real" del otro. Nosotros vemos temporales
# que se cambian en el primer acceso. Los .env quedan SOLO en el servidor.
#
# Uso:  bash setup.sh          (ejecutar en la carpeta del proyecto, en el VPS)
#
set -euo pipefail
cd "$(dirname "$0")"

ROOT_ENV=".env"
SVC_ENV="servicios/servicio-usuarios/.env"

c_bold=$(tput bold 2>/dev/null || true); c_off=$(tput sgr0 2>/dev/null || true)
say()  { echo -e "$c_bold$*$c_off"; }
warn() { echo "  ⚠ $*"; }

# ── Prerrequisitos ────────────────────────────────────────────────────────────
command -v docker >/dev/null || { echo "✗ Falta Docker. Instálalo antes (ver DEPLOY-PD.md)."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "✗ Falta Docker Compose v2."; exit 1; }
command -v openssl >/dev/null || { echo "✗ Falta openssl."; exit 1; }

if [ -f "$ROOT_ENV" ] || [ -f "$SVC_ENV" ]; then
  echo "✗ Ya existe un .env. Este wizard es solo para el PRIMER arranque."
  echo "  Si de verdad quieres regenerar la configuración, borra a mano $ROOT_ENV y $SVC_ENV"
  echo "  (OJO: cambiar DB_PASSWORD con la BD ya inicializada la rompe)."
  exit 1
fi

# ── Helpers de entrada ────────────────────────────────────────────────────────
ask() {  # ask VAR "Prompt" ["default"]
  local __var=$1 __prompt=$2 __default=${3:-} __in
  if [ -n "$__default" ]; then read -r -p "  $__prompt [$__default]: " __in; __in=${__in:-$__default}
  else read -r -p "  $__prompt: " __in; fi
  printf -v "$__var" '%s' "$__in"
}
ask_req() { ask "$@"; local v=${!1}; while [ -z "$v" ]; do warn "obligatorio"; ask "$@"; v=${!1}; done; }
ask_secret() { local __var=$1 __prompt=$2 __in; read -r -s -p "  $__prompt: " __in; echo; printf -v "$__var" '%s' "$__in"; }
gen_secret() { openssl rand -hex "${1:-32}"; }
gen_pass()   { tr -dc 'A-Za-z0-9' </dev/urandom | head -c "${1:-16}" || true; }

# ── Secretos de infra (automáticos) ───────────────────────────────────────────
DB_PASSWORD=$(gen_secret 24)
JWT_SECRET=$(gen_secret 32)
INTERNAL_API_TOKEN=$(gen_secret 32)

say "\n════ Configuración del cliente ════"
echo "  (Deja en blanco lo que aún no tengas; puedes completarlo luego editando el .env y reiniciando.)"

say "\n— App / dominio —"
ask_req SUBDOMAIN "Subdominio público de la app (ej. vouchers.certjoin.com)"
FRONTEND_URL="https://${SUBDOMAIN}"

say "\n— Moodle del cliente —"
ask     MOODLE_URL        "URL base del Moodle (https://...)"
ask     MOODLE_TOKEN      "Token de Web Services de Moodle"
ask     MOODLE_ROLE_ID    "Role id de estudiante" "5"
MOODLE_PUBLIC_URL_DEFAULT="${MOODLE_URL}"
ask     MOODLE_PUBLIC_URL "URL pública del Moodle" "${MOODLE_PUBLIC_URL_DEFAULT}"
CAMPUS_DEFAULT="${MOODLE_URL:+${MOODLE_URL%/}/login/index.php}"
ask     CAMPUS_URL        "URL de login del Campus (botón del correo)" "${CAMPUS_DEFAULT}"

say "\n— Stripe (modo live) — OBLIGATORIO (la app no arranca en prod sin esto)"
echo    "  Nota: crea el webhook en Stripe apuntando a ${FRONTEND_URL}/webhook/stripe;"
echo    "        Stripe te da el signing secret de inmediato (no necesita que la URL esté viva aún)."
ask_req STRIPE_PUBLISHABLE_KEY "Publishable key (pk_live_...)"
ask_req STRIPE_SECRET_KEY      "Secret key (sk_live_...)"
ask_req STRIPE_WEBHOOK_SECRET  "Webhook signing secret (whsec_...)"

say "\n— Correo / SMTP —"
ask     MAIL_ENABLED "¿Enviar correos? (true/false)" "true"
ask     SMTP_HOST    "SMTP host"
ask     SMTP_PORT    "SMTP port" "465"
ask     SMTP_SECURE  "SMTP secure (true=465 SSL, false=587 STARTTLS)" "true"
ask     SMTP_USER    "SMTP usuario"
ask_secret SMTP_PASS "SMTP contraseña"
ask     MAIL_FROM      "Remitente (MAIL_FROM)"
ask     MAIL_REPLY_TO  "Reply-To" "${MAIL_FROM}"
ask     MAIL_LOGO_URL  "URL pública del logo (opcional)"

say "\n— Cuentas iniciales —"
ask_req ADMIN_EMAIL   "Correo del ADMIN (del cliente)"
ask_req SUPPORT_EMAIL "Correo de SOPORTE (nuestro, rol soporte)"
ask     PARTNER_EMAIL "Correo del partner demo (opcional)" "partner@${SUBDOMAIN#*.}"

# Contraseñas temporales (se cambian al primer login por force-change)
ADMIN_PASSWORD=$(gen_pass 16)
SUPPORT_PASSWORD=$(gen_pass 16)
PARTNER_PASSWORD=$(gen_pass 16)

# ── Escribir .env raíz (para docker-compose) ─────────────────────────────────
say "\n→ Escribiendo $ROOT_ENV y $SVC_ENV ..."
cat > "$ROOT_ENV" <<EOF
# Generado por setup.sh — $(date -u +%FT%TZ). NO subir a git. chmod 600.
DB_NAME=voucherdb
DB_USER=admin
DB_PASSWORD=${DB_PASSWORD}
COMPOSE_PROFILES=
GATEWAY_PORT=3000
GATEWAY_BIND=127.0.0.1
DB_BIND=127.0.0.1
USUARIOS_BIND=127.0.0.1
INTERNAL_API_TOKEN=${INTERNAL_API_TOKEN}
EOF

# ── Escribir .env de la app ──────────────────────────────────────────────────
cat > "$SVC_ENV" <<EOF
# Generado por setup.sh — $(date -u +%FT%TZ). NO subir a git. chmod 600.
DB_HOST=postgres
DB_PORT=5432
DB_NAME=voucherdb
DB_USER=admin
DB_PASSWORD=${DB_PASSWORD}
JWT_SECRET=${JWT_SECRET}
NODE_ENV=production
PORT=8081
SESSION_TIMEOUT_MINUTES=30
REFRESH_TOKEN_TTL_DAYS=7
REFRESH_IDLE_MINUTES=30
MAX_LOGIN_ATTEMPTS=10
RATE_LIMIT_WINDOW_MINUTES=15
RATE_LIMIT_MAX_REQUESTS=100

# Cuentas semilla + cambio obligatorio de contraseña al primer login
SEED_FORCE_PASSWORD_CHANGE=true
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
SUPPORT_EMAIL=${SUPPORT_EMAIL}
SUPPORT_PASSWORD=${SUPPORT_PASSWORD}
PARTNER_EMAIL=${PARTNER_EMAIL}
PARTNER_PASSWORD=${PARTNER_PASSWORD}

FRONTEND_URL=${FRONTEND_URL}

STRIPE_PUBLISHABLE_KEY=${STRIPE_PUBLISHABLE_KEY}
STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}

MOODLE_MOCK=false
MOODLE_URL=${MOODLE_URL}
MOODLE_TOKEN=${MOODLE_TOKEN}
MOODLE_ROLE_ID=${MOODLE_ROLE_ID}
MOODLE_PUBLIC_URL=${MOODLE_PUBLIC_URL}
CAMPUS_URL=${CAMPUS_URL}

MAIL_ENABLED=${MAIL_ENABLED}
SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
SMTP_SECURE=${SMTP_SECURE}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
MAIL_FROM=${MAIL_FROM}
MAIL_FROM_NAME=CertJoin
MAIL_REPLY_TO=${MAIL_REPLY_TO}
MAIL_LOGO_URL=${MAIL_LOGO_URL}
EOF

chmod 600 "$ROOT_ENV" "$SVC_ENV"
echo "  ✓ .env creados (chmod 600)."

# ── Desplegar ────────────────────────────────────────────────────────────────
say "\n→ Levantando el stack (docker compose up -d --build) ..."
./deploy.sh

# ── Espera de salud del gateway ──────────────────────────────────────────────
say "\n→ Esperando a que el gateway responda en 127.0.0.1:3000 ..."
ok=0
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:3000/health" 2>/dev/null; then ok=1; break; fi
  sleep 3
done
[ "$ok" = 1 ] && echo "  ✓ Gateway respondiendo." || warn "El gateway aún no responde; revisa 'docker compose logs'."

# ── Resumen ──────────────────────────────────────────────────────────────────
cat <<EOF

$c_bold════════════════ RESUMEN DEL DESPLIEGUE ════════════════$c_off

  App (interna):   http://127.0.0.1:3000
  URL pública:     ${FRONTEND_URL}
                   (configura el Reverse Proxy en CloudPanel → http://127.0.0.1:3000
                    y emite el certificado Let's Encrypt)

  $c_bold» ENTREGAR AL CLIENTE (admin) — cambia la clave al primer login:$c_off
      Usuario:     ${ADMIN_EMAIL}
      Contraseña:  ${ADMIN_PASSWORD}   (temporal)

  $c_bold» NUESTRO (soporte) — cambiar al primer login:$c_off
      Usuario:     ${SUPPORT_EMAIL}
      Contraseña:  ${SUPPORT_PASSWORD}   (temporal)   · rol: soporte (sin gestión de usuarios/roles)

  (Partner demo: ${PARTNER_EMAIL} / ${PARTNER_PASSWORD} — opcional, se puede borrar.)

  Los secretos (DB/JWT/token) quedaron en ${ROOT_ENV} y ${SVC_ENV} (solo en el servidor).
  Guarda este resumen; las contraseñas temporales no se vuelven a mostrar.
EOF
