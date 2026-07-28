# Compass — frontend

Interfaz de Compass: revision documental y de datos de clientes para cumplimiento.

Sitio estatico (HTML, CSS y JavaScript sin dependencias ni build) pensado para
GitHub Pages. El backend vive en
[`compass-backend`](https://github.com/amondinelli-g66/compass-backend) y corre en
la maquina del analista, porque la base de datos solo es accesible por VPN.

## Archivos

```
compass/
├── index.html    # estructura: login, aplicacion y modales
├── styles.css    # sistema visual Global66 (Montserrat, navy/verde, cards)
├── app.js        # sesion, sondeo de VPN, formulario y envio
├── logo.svg      # marca (aguja de compas); tambien es el favicon
├── banderas/     # 265 banderas circulares por codigo ISO-2 (ver su LICENSE.txt)
├── config.json   # URL del backend
└── .nojekyll     # evita el procesamiento Jekyll de GitHub Pages
```

## Configuracion

`config.json` apunta al backend:

```json
{
  "backend": "https://mi-tunel.trycloudflare.com"
}
```

**No hace falta editarlo a mano.** El lanzador `Compass-publico.cmd` del backend
escribe la URL del tunel aqui y hace commit + push en cada arranque, asi que Pages
siempre queda apuntando al tunel vigente.

Una cadena vacia (`"backend": ""`) significa **mismo origen**. Es lo que devuelve el
backend cuando sirve el frontend en local, para no tener que configurar nada.

El backend debe autorizar el origen de esta pagina en `CORS_ALLOW_ORIGINS`
(por defecto `https://amondinelli-g66.github.io`).

## Prueba en local (recomendado)

Lo mas simple es dejar que el backend sirva esta carpeta: asi pagina y API
comparten origen, que es lo que exige el cliente de OAuth de Google. Doble clic en
`compass-backend\deploy\Compass-local.cmd` y se abre `http://127.0.0.1:8010`.

## Como funciona

1. Al cargar, lee `config.json` y consulta `GET /auth/status`.
2. Si no hay sesion, muestra el boton de Google con el `nonce` que emitio el
   backend. Solo se aceptan cuentas del dominio corporativo.
3. El backend verifica el ID token y devuelve un token de sesion firmado, que se
   guarda en `sessionStorage` y viaja en `Authorization: Bearer` (el frontend esta
   en otro origen, donde las cookies de terceros no viajan).
4. Un reloj visible cuenta los **10 minutos de inactividad**. Cualquier accion real
   del usuario lo reinicia; al llegar a cero se cierra la sesion. El backend aplica
   la misma regla, asi que un reloj manipulado en el navegador no sirve de nada.
5. Cada 20s se consulta `GET /salud`. Si la VPN esta caida aparece un modal que
   bloquea el analisis hasta que se conecte. La VPN se revalida ademas justo antes
   de ejecutar.
6. El analista elige segmento (B2C o B2B), ingresa el ID de cliente y adjunta los
   documentos (opcionales: se puede ejecutar solo la consulta).

Los documentos se envian, se analizan y se descartan. No se almacenan en ningun
repositorio.

## Prueba en local sirviendo aparte

Solo si se quiere servir esta carpeta por separado (entonces son dos origenes y hay
que autorizar el de la pagina en Google y en `CORS_ALLOW_ORIGINS`):

```bash
python -m http.server 5500
```

## Publicacion en GitHub Pages

En el repositorio: Settings > Pages > Source = rama `main`, carpeta `/ (root)`.
