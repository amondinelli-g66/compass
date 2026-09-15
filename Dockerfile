# Compass - frontend (estatico, servido por nginx)
#
# El frontend es HTML + JS + CSS sin build: no hay bundler ni node, asi que la imagen
# es solo nginx con los archivos dentro.
#
# En AWS, lo natural para esto es S3 + CloudFront (mas barato y sin contenedor que
# mantener). Esta imagen existe para el caso de querer los dos servicios en ECS con el
# mismo pipeline, y tiene una ventaja concreta: nginx hace de proxy hacia la API, asi
# el navegador ve un solo origen y CORS deja de existir como problema.

FROM nginx:1.27-alpine

# Los estaticos. Se listan uno a uno en vez de copiar el directorio entero para no
# meter en la imagen el README ni el config.json del repo (que trae la URL del tunel
# viejo y aqui se genera en el arranque).
COPY index.html app.js styles.css logo.svg /usr/share/nginx/html/
COPY global66-logo.webp global66-logo-blanco.png /usr/share/nginx/html/
COPY banderas/ /usr/share/nginx/html/banderas/

# La plantilla de nginx: el entrypoint oficial le sustituye las variables COMPASS_* y
# la deja en /etc/nginx/conf.d/. El filtro evita que toque las variables propias de
# nginx ($host, $uri, ...), que se escriben igual.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV NGINX_ENVSUBST_FILTER=COMPASS_

# A donde manda nginx las llamadas a la API. En docker compose es el nombre del
# servicio; en ECS, el DNS interno del backend.
ENV COMPASS_BACKEND=http://backend:8000

# config.json le dice al frontend donde vive la API. Se genera en el ARRANQUE y no se
# hornea en la imagen, para que la MISMA imagen sirva en local, staging y produccion.
COPY docker-config-json.sh /docker-entrypoint.d/40-config-json.sh

# nginx:alpine ya corre los workers como usuario `nginx`; el master necesita root para
# escribir en /docker-entrypoint.d y abrir el puerto.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --spider -q http://127.0.0.1:8080/index.html || exit 1
