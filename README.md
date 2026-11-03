# Compass — frontend

Interfaz de Compass: revision documental y de datos de clientes para cumplimiento.

Sitio estatico (HTML, CSS y JavaScript sin dependencias ni build). En produccion lo
sirve nginx en su contenedor (ECS), en el mismo origen que la API:
`https://compass.global66.com`. El backend vive en `compass-backend`.

Antes se publicaba en GitHub Pages, apuntando a un tunel de Cloudflare hacia el
equipo del desarrollador. Ese despliegue se retiro (ver
`compass-backend/deploy/README.md`): Pages debe quedar desactivado y este repo,
privado.

## Archivos

```
compass/
├── index.html    # estructura: login, aplicacion y modales
├── styles.css    # sistema visual Global66 (Montserrat, navy/verde, cards)
├── app.js        # sesion, sondeo del estado de la base, formulario y envio
├── logo.svg      # marca (aguja de compas); tambien es el favicon
├── banderas/     # 265 banderas circulares por codigo ISO-2 (ver su LICENSE.txt)
├── config.json   # URL del backend (vacio = mismo origen)
└── docker-config-json.sh  # genera config.json al arrancar el contenedor
```

## Configuracion

`config.json` apunta al backend. Una cadena vacia (`"backend": ""`) significa
**mismo origen**, que es el caso de AWS (nginx y la API detras del mismo
balanceador) y el de local (el backend sirve esta carpeta). En el contenedor lo
genera `docker-config-json.sh` desde `COMPASS_API_PUBLICA`.

## Prueba en local

Dejar que el backend sirva esta carpeta: asi pagina y API comparten origen, que es lo
que exige el cliente de OAuth de Google. Doble clic en
`compass-backend\deploy\Compass-local.cmd` y se abre `http://127.0.0.1:8011`.

## Como funciona

1. Al cargar, lee `config.json` y consulta `GET /auth/status`.
2. Si no hay sesion, muestra el boton de Google con el `nonce` que emitio el
   backend. Solo se aceptan cuentas del dominio corporativo.
3. El backend verifica el ID token y devuelve un token de sesion firmado, que se
   guarda en `sessionStorage` y viaja en `Authorization: Bearer`.
4. Un reloj visible cuenta los **10 minutos de inactividad**. Cualquier accion real
   del usuario lo reinicia; al llegar a cero se cierra la sesion. El backend aplica
   la misma regla, asi que un reloj manipulado en el navegador no sirve de nada.
5. Cada 20s se consulta `GET /salud/detalle` (exige sesion, pero no cuenta como
   actividad). Si la base no esta disponible aparece un modal que bloquea el analisis.
   La conexion se revalida ademas justo antes de ejecutar.
6. El analista elige segmento (B2C o B2B), ingresa el ID de cliente y adjunta los
   documentos (opcionales: se puede ejecutar solo la consulta).

Los documentos se envian, se analizan y se descartan. No se almacenan en ningun
repositorio.
