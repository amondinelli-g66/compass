#!/bin/sh
# Genera config.json en el arranque del contenedor.
#
# El frontend lee de ahi donde vive la API (ver app.js). Se escribe al arrancar y no se
# hornea en la imagen para que la MISMA imagen sirva en local, staging y produccion:
# lo unico que cambia es una variable de entorno.
#
# Por defecto va vacio, que el frontend interpreta como "mismo origen". Es lo correcto
# cuando nginx hace de proxy hacia el backend (el caso normal de esta imagen): asi no
# hay CORS de por medio. Solo hace falta darle valor a COMPASS_API_PUBLICA si el
# frontend se sirve desde un dominio distinto del de la API.
set -e

DESTINO=/usr/share/nginx/html/config.json

cat > "$DESTINO" <<EOF
{"backend": "${COMPASS_API_PUBLICA:-}"}
EOF

echo "config.json generado: backend='${COMPASS_API_PUBLICA:-(mismo origen)}'"
