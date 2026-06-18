FROM caddy:2-alpine
# Se copia el Caddyfile a la imagen (no se monta como volumen: en Docker Desktop
# sobre Google Drive los bind-mounts de archivos fallan). El CMD por defecto de la
# imagen caddy ejecuta /etc/caddy/Caddyfile.
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
