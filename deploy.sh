#!/usr/bin/env bash
#
# Despliegue para PRODUCCIÓN (VPS del cliente).
#
# Filosofía: la configuración (los .env) vive SOLO en el servidor y la gestiona
# el cliente. Este script NUNCA crea ni sobrescribe los .env: solo actualiza el
# código y reconstruye los contenedores. Así el cliente es el único dueño de sus
# credenciales (a diferencia de QA, donde el .env se genera desde GitHub).
#
# Primer arranque: ver DEPLOY-PD.md
# Uso normal:      ./deploy.sh
#
set -euo pipefail
cd "$(dirname "$0")"

ROOT_ENV=".env"
SVC_ENV="servicios/servicio-usuarios/.env"

echo "==> Validando configuración interna (.env)"
missing=0
if [ ! -f "$ROOT_ENV" ]; then
  echo "   ✗ Falta $ROOT_ENV — cópialo de .env.production.example y complétalo."
  missing=1
fi
if [ ! -f "$SVC_ENV" ]; then
  echo "   ✗ Falta $SVC_ENV — cópialo de servicios/servicio-usuarios/.env.production.example y complétalo."
  missing=1
fi
if [ "$missing" -ne 0 ]; then
  echo "Abortado: faltan archivos de configuración. (Este script NO los genera por diseño.)"
  exit 1
fi
echo "   ✓ .env presentes (no se tocan)"

# Actualizar código (omitible con SKIP_GIT_PULL=1). No falla el deploy si no hay git/remote.
if [ "${SKIP_GIT_PULL:-0}" != "1" ] && [ -d .git ]; then
  echo "==> git pull"
  git pull --ff-only || echo "   (git pull omitido o sin cambios; continúo con el código actual)"
fi

# Directorio de logs que montan los contenedores (bind-mount ./logs/usuarios).
mkdir -p logs/usuarios

# Levantar / reconstruir. Los perfiles (p.ej. local-moodle) se activan vía
# COMPOSE_PROFILES dentro del .env raíz, así que aquí no hace falta pasarlos.
# En PD (detrás de CloudPanel) NO se usa el override TLS: CloudPanel termina el HTTPS.
echo "==> docker compose up -d --build"
docker compose up -d --build

echo "==> Estado de los contenedores:"
docker compose ps

echo ""
echo "✓ Despliegue completado. Los .env del servidor no fueron modificados."