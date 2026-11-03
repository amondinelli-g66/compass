/* ==========================================================================
 * Compass — frontend
 *
 * En produccion lo sirve nginx en el mismo origen que la API
 * (compass.global66.com). La sesion viaja como token firmado en la cabecera
 * `Authorization: Bearer`, que sirve igual si algun dia la API vive en otro origen.
 *
 * La URL del backend se lee de config.json (vacia = mismo origen).
 * ========================================================================== */

'use strict';

const CLAVE_SESION = 'compass_sesion';
const CABECERA_SESION = 'X-Session-Token';
const SONDEO_CONEXION_MS = 20000;    // cada cuanto se consulta el estado del cluster / BD
const REVISION_IDLE_MS = 5000;  // cada cuanto se comprueba la inactividad
// Cada cuanto se pregunta por un analisis en curso. El backend lo encola y puede
// tardar minutos; sondear ademas mantiene viva la sesion mientras el analista espera.
const SONDEO_ANALISIS_MS = 1500;
// Cada cuanto se le avisa al BACKEND que hubo actividad, si la hubo. Bastante menor
// que idleSeg (600s de por defecto) para que siempre llegue con margen de sobra.
const RENOVACION_SESION_MS = 60000;
// B2B todavia no tiene consulta definida en el backend (ver `api.main._construir_informe`:
// devuelve un informe vacio con el aviso), asi que hoy el unico segmento real es B2C: se
// deja marcado de entrada y B2B en gris, sin clic. Cuando exista el SQL, esto vuelve a
// true y el selector funciona como antes; no hay nada mas que deshacer.
const B2B_HABILITADO = false;

const estado = {
  backend: '',
  token: sessionStorage.getItem(CLAVE_SESION) || '',
  usuario: null,
  idleSeg: 600,
  ultimaActividad: 0,
  ultimaRenovacion: 0,
  segmento: null,
  archivos: [],
  conexionOk: false,
  enviando: false,
  // Que mostrar mientras se espera: el puesto en la cola o el avance del analisis.
  // Lo pinta `actualizarBoton`.
  avance: '',
  nonceRenovado: false,
  informe: null,
  nombrePdf: '',
  // Los `id` de los bloques que el analista dejo marcados para el PDF. Los pone el
  // backend (ver `core/informe.py: filtrar`); aca solo se recuerda cuales estan
  // tildados y se manda la lista al pedir el PDF.
  incluirEnPdf: new Set(),
};

let timerSesion = null;
let timerConexion = null;

/* -------------------------------------------------------------------------- *
 * Utilidades
 * -------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

function mostrar(el, visible) {
  el.classList.toggle('oculto', !visible);
}

function texto(id, valor) {
  $(id).textContent = valor;
}

function pesoLegible(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function extension(nombre) {
  const p = nombre.lastIndexOf('.');
  return p === -1 ? '?' : nombre.slice(p + 1).toUpperCase().slice(0, 4);
}

function mensaje(id, txt) {
  const el = $(id);
  el.textContent = txt || '';
  mostrar(el, Boolean(txt));
}

function limpiarMensajes() {
  mensaje('app-error', '');
  mensaje('app-ok', '');
}

/**
 * Muestra bajo el error los datos que hay que comparar con Google Cloud Console.
 *
 * El fallo mas comun no es el codigo: es que el origen se autorizo en un cliente de
 * OAuth distinto al que usa el backend. Con el client_id a la vista se compara en
 * segundos, sin tener que abrir la consola del navegador.
 */
function mostrarDiagnostico() {
  const cfg = estado.cfgAuth || {};
  const cid = cfg.client_id || '(sin client_id)';
  const el = $('login-diag');
  el.textContent =
    'origen de esta pagina: ' + location.origin + '\n'
    + 'client_id del backend: ' + cid + '\n'
    + 'dominio exigido: @' + (cfg.hosted_domain || '?') + '\n'
    + 'Este origen debe estar en "Origenes autorizados de JavaScript" '
    + 'de ESE client_id.';
  el.style.whiteSpace = 'pre-line';
  mostrar(el, true);
}

/* -------------------------------------------------------------------------- *
 * Llamadas al backend
 * -------------------------------------------------------------------------- */

async function api(ruta, opciones = {}) {
  const cabeceras = new Headers(opciones.headers || {});
  if (estado.token) cabeceras.set('Authorization', 'Bearer ' + estado.token);

  const resp = await fetch(estado.backend + ruta, { ...opciones, headers: cabeceras });

  // El backend devuelve la sesion renovada en cada peticion autenticada. Guardarla
  // es lo que hace que la ventana de inactividad se DESLICE: si no, el token
  // conservaria el `last` del login y la sesion caducaria 10 min despues de entrar
  // aunque el analista estuviera trabajando.
  const renovado = resp.headers.get(CABECERA_SESION);
  if (renovado) guardarToken(renovado);

  // El backend responde 401 cuando la sesion expiro o la firma no es valida.
  if (resp.status === 401) {
    cerrarPorInactividad();
    throw new Error('Sesión expirada.');
  }

  // `crudo` devuelve la Response tal cual: lo usa la descarga del PDF, que no es
  // JSON pero sí necesita el mismo manejo de sesión y de errores.
  if (opciones.crudo) {
    if (!resp.ok) {
      let detalle = 'HTTP ' + resp.status;
      try {
        const j = await resp.json();
        detalle = j.mensaje || j.detail || detalle;
      } catch { /* la respuesta de error no era JSON */ }
      throw new Error(detalle);
    }
    return resp;
  }

  let cuerpo = null;
  try { cuerpo = await resp.json(); } catch { /* respuesta sin JSON */ }

  if (!resp.ok) {
    const detalle = (cuerpo && (cuerpo.mensaje || cuerpo.detail)) || ('HTTP ' + resp.status);
    throw new Error(detalle);
  }
  return cuerpo;
}

/* -------------------------------------------------------------------------- *
 * Sesion
 * -------------------------------------------------------------------------- */

function guardarToken(token) {
  estado.token = token || '';
  if (token) sessionStorage.setItem(CLAVE_SESION, token);
  else sessionStorage.removeItem(CLAVE_SESION);
}

/**
 * Vigila la inactividad comparando RELOJ DE PARED, no restando segundos.
 *
 * Un contador que decrementa cada segundo no sirve: el navegador limita los
 * temporizadores de las pestanas en segundo plano (y los congela al suspender el
 * equipo), asi que el contador se atrasa y la sesion sobreviviria mucho mas de 10
 * minutos. Comparar contra `Date.now()` es exacto pase lo que pase.
 *
 * Ademas de cerrar la sesion en PANTALLA cuando el frontend detecta inactividad,
 * este mismo timer le avisa al BACKEND que hubo actividad (ver `RENOVACION_SESION_MS`
 * mas abajo): sin eso, alguien podia estar activamente trabajando en la pagina sin
 * que eso llamara nunca a la API, y el reloj de inactividad del backend (que solo se
 * renueva con peticiones HTTP) expiraba igual. Al presionar por fin "Iniciar
 * analisis" el backend rechazaba con 401 aunque el frontend nunca lo hubiera marcado
 * inactivo.
 */
function arrancarVigilanciaSesion() {
  clearInterval(timerSesion);
  registrarActividad();
  estado.ultimaRenovacion = Date.now();
  timerSesion = setInterval(() => {
    if (!estado.token) return;

    if (Date.now() - estado.ultimaActividad >= estado.idleSeg * 1000) {
      cerrarPorInactividad();
      return;
    }

    // Hubo actividad desde la ultima vez que se le aviso al backend, y ya paso el
    // intervalo minimo entre avisos: se le avisa con una peticion liviana. Si no
    // hubo actividad, no se hace nada, y la sesion expira en el backend por
    // inactividad real, que es lo correcto.
    if (estado.ultimaActividad > estado.ultimaRenovacion &&
        Date.now() - estado.ultimaRenovacion >= RENOVACION_SESION_MS) {
      estado.ultimaRenovacion = Date.now();
      // El 401, si llegara, ya lo maneja `api()` cerrando la sesion; un error de red
      // no debe romper el timer.
      api('/auth/ping').catch(() => {});
    }
  }, REVISION_IDLE_MS);
}

/**
 * Marca actividad REAL del usuario. No la disparan el sondeo del cluster ni los
 * temporizadores: la ventana de inactividad tiene que reflejar que hay alguien
 * trabajando, no que la pestana esta abierta.
 */
function registrarActividad() {
  estado.ultimaActividad = Date.now();
}

function cerrarPorInactividad() {
  clearInterval(timerSesion);
  clearInterval(timerConexion);
  guardarToken('');
  estado.usuario = null;
  mostrar($('pantalla-app'), false);
  mostrar($('pantalla-login'), false);
  mostrar($('modal-sesion'), true);
}

async function salir() {
  clearInterval(timerSesion);
  clearInterval(timerConexion);
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* idempotente */ }
  guardarToken('');
  location.reload();
}

/* -------------------------------------------------------------------------- *
 * Login con Google
 * -------------------------------------------------------------------------- */

async function alRecibirCredencial(respuesta) {
  mensaje('login-error', '');
  try {
    const datos = await api('/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: respuesta.credential }),
    });
    guardarToken(datos.session_token);
    estado.usuario = datos.user;
    entrarALaApp();
  } catch (e) {
    // El nonce dura 5 minutos. Si la pantalla de login quedo abierta mas tiempo,
    // el primer intento falla por nonce vencido: se pide uno nuevo y se reintenta
    // solo, en vez de obligar a recargar.
    if (/nonce/i.test(e.message) && !estado.nonceRenovado) {
      estado.nonceRenovado = true;
      try {
        const fresco = await api('/auth/status');
        if (fresco.nonce) {
          await dibujarBotonGoogle(fresco);
          mensaje('login-error',
            'La pantalla estuvo abierta demasiado tiempo. Vuelve a pulsar el boton.');
          return;
        }
      } catch { /* se cae al mensaje generico */ }
    }
    mensaje('login-error', e.message);
    mostrarDiagnostico();
  }
}

/**
 * Espera a que cargue Google Identity Services.
 *
 * El script va con `async defer`, asi que puede terminar de cargar antes o despues
 * de que este codigo corra (que ademas espera dos fetch). Sondear es lo unico
 * fiable: escuchar el evento `load` falla si ya se disparo durante los await.
 */
function esperarGoogle(msMax = 10000) {
  return new Promise((resolve) => {
    const limite = Date.now() + msMax;
    (function revisar() {
      if (window.google && window.google.accounts && window.google.accounts.id) {
        resolve(true);
      } else if (Date.now() > limite) {
        resolve(false);
      } else {
        setTimeout(revisar, 100);
      }
    })();
  });
}

async function dibujarBotonGoogle(cfg) {
  if (!(await esperarGoogle())) {
    mensaje('login-error',
      'No se pudo cargar el inicio de sesion de Google. Revisa tu conexion '
      + '(o si una extension bloquea accounts.google.com) y recarga.');
    return;
  }

  const contenedor = $('boton-google');

  google.accounts.id.initialize({
    client_id: cfg.client_id,
    callback: alRecibirCredencial,
    nonce: cfg.nonce,
    hd: cfg.hosted_domain,
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  google.accounts.id.renderButton(contenedor, {
    type: 'standard',
    theme: 'outline',          // boton blanco: va sobre el panel claro
    size: 'large',
    shape: 'pill',
    text: 'signin_with',
    locale: 'es',
    width: 280,
  });

  // Google dibuja el boton incluso si el origen no esta autorizado: el rechazo
  // ocurre al hacer clic y queda SOLO en la consola. Sin esto el fallo es invisible.
  if (contenedor.childElementCount === 0) {
    mensaje('login-error',
      'Google no dibujo el boton de inicio de sesion. Revisa la consola del navegador.');
  }
}

/**
 * Lleva los errores de Google Identity Services a la pantalla.
 *
 * GIS no lanza excepciones ni invoca el callback cuando rechaza algo (origen no
 * autorizado, client_id inexistente): escribe una linea `[GSI_LOGGER]` en la consola
 * y no pasa nada mas. Para quien usa la app eso es un boton que "no hace nada", asi
 * que se intercepta y se muestra.
 */
function capturarErroresGoogle() {
  const original = console.error.bind(console);
  console.error = (...args) => {
    original(...args);
    const texto = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
    if (!texto.includes('GSI_LOGGER')) return;

    let detalle = texto.replace(/\[GSI_LOGGER\]:?\s*/g, '').trim();
    if (/origin is not allowed|not allowed for the given client/i.test(detalle)) {
      detalle = 'Google rechazo el origen ' + location.origin
        + '. Casi siempre es que el origen se autorizo en OTRO cliente de OAuth, no '
        + 'en el que usa el backend. Compara los datos de abajo.';
    }
    mensaje('login-error', detalle);
    mostrarDiagnostico();
  };
}

/* -------------------------------------------------------------------------- *
 * Estado del cluster / base de datos
 * -------------------------------------------------------------------------- */

function pintarEstadoConexion(clase, txt) {
  const el = $('estado-conexion');
  el.className = 'estado ' + clase;
  texto('estado-conexion-texto', txt);
}

/*
 * Texto del indicador cuando la conexion NO esta disponible. Con Redshift el
 * problema tipico es que el cluster este apagado (pausado), que es distinto de
 * "responde pero la consulta falla": el backend los distingue en `cluster_estado`
 * (ver `core.vpn._estado_redshift_data`).
 */
function _textoConexionCaida(s) {
  if (s.motor === 'mysql') return 'VPN desconectada';
  if (s.cluster_encendido === false) {
    return s.cluster_estado === 'paused' ? 'Cluster pausado' : 'Cluster apagado';
  }
  return 'Cluster sin responder';
}

async function sondearConexion({ mostrarModal = true } = {}) {
  pintarEstadoConexion('estado--cargando', 'Verificando cluster');
  try {
    // Exige sesion pero NO renueva la ventana de inactividad (ver
    // api.auth.RUTAS_SIN_RENOVAR): es un sondeo, no actividad del analista.
    const s = await api('/salud/detalle');
    estado.conexionOk = Boolean(s.vpn_ok && s.db_ok);

    if (estado.conexionOk) {
      pintarEstadoConexion('estado--ok',
        s.motor === 'mysql' ? 'VPN conectada' : 'Cluster encendido');
      mostrar($('modal-conexion'), false);
    } else {
      pintarEstadoConexion('estado--mal', _textoConexionCaida(s));
      $('modal-conexion-titulo').textContent =
        s.motor === 'mysql' ? 'VPN desconectada' : 'Cluster no disponible';
      $('modal-conexion-detalle').textContent =
        (s.destino ? 'Destino ' + s.destino + '. ' : '') + (s.detalle_bd || '');
      if (mostrarModal) mostrar($('modal-conexion'), true);
    }
  } catch (e) {
    estado.conexionOk = false;
    pintarEstadoConexion('estado--mal', 'Backend inalcanzable');
    $('modal-conexion-detalle').textContent = e.message;
    if (mostrarModal) mostrar($('modal-conexion'), true);
  }
  actualizarBoton();
}

/* -------------------------------------------------------------------------- *
 * Formulario
 * -------------------------------------------------------------------------- */

function elegirSegmento(valor) {
  estado.segmento = valor;
  for (const b of document.querySelectorAll('.segmento')) {
    b.setAttribute('aria-pressed', String(b.dataset.segmento === valor));
  }
  limpiarMensajes();
  // El resultado anterior corresponde a otra consulta: dejarlo a la vista seria
  // enganoso.
  limpiarResultado();
  actualizarBoton();
}

function agregarArchivos(lista) {
  for (const f of lista) {
    // Evita duplicados exactos si el analista vuelve a soltar el mismo archivo.
    const repetido = estado.archivos.some(
      (a) => a.name === f.name && a.size === f.size && a.lastModified === f.lastModified,
    );
    if (!repetido) estado.archivos.push(f);
  }
  pintarArchivos();
}

function quitarArchivo(indice) {
  estado.archivos.splice(indice, 1);
  pintarArchivos();
}

/**
 * Vacía la lista de documentos cargados.
 *
 * Hay que limpiar TAMBIÉN el value del input: si no, el navegador recuerda la
 * selección anterior y volver a elegir el mismo archivo no dispara `change`, así que
 * el analista lo elige y no pasa nada.
 */
function limpiarArchivos() {
  if (!estado.archivos.length) return;
  estado.archivos = [];
  $('archivos').value = '';
  pintarArchivos();
}

function pintarArchivos() {
  const ul = $('lista-archivos');
  ul.innerHTML = '';

  // El botón de vaciar solo tiene sentido si hay algo cargado.
  mostrar($('boton-limpiar-archivos'), estado.archivos.length > 0);

  estado.archivos.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'archivo';

    const icono = document.createElement('span');
    icono.className = 'archivo-icono';
    icono.textContent = extension(f.name);

    const nombre = document.createElement('span');
    nombre.className = 'archivo-nombre';
    nombre.textContent = f.name;          // textContent: nada de HTML del nombre

    const peso = document.createElement('span');
    peso.className = 'archivo-peso';
    peso.textContent = pesoLegible(f.size);

    const quitar = document.createElement('button');
    quitar.className = 'archivo-quitar';
    quitar.type = 'button';
    quitar.title = 'Quitar';
    quitar.setAttribute('aria-label', 'Quitar ' + f.name);
    quitar.textContent = '×';
    quitar.addEventListener('click', () => quitarArchivo(i));

    li.append(icono, nombre, peso, quitar);
    ul.appendChild(li);
  });

  actualizarBoton();
}

function actualizarBoton() {
  const idCliente = $('id-cliente').value.trim();
  const listo = Boolean(estado.segmento) && Boolean(idCliente) && estado.conexionOk && !estado.enviando;
  $('boton-analizar').disabled = !listo;

  const resumen = $('resumen');
  resumen.textContent = '';

  if (estado.enviando) {
    resumen.textContent = estado.avance || 'Ejecutando analisis...';
    return;
  }
  if (!estado.segmento) {
    resumen.textContent = 'Selecciona un segmento para comenzar.';
    return;
  }
  if (!idCliente) {
    resumen.textContent = 'Ingresa el ID del cliente.';
    return;
  }
  if (!estado.conexionOk) {
    resumen.textContent = 'El cluster de Redshift no esta disponible para consultar la base de datos.';
    return;
  }

  // Resumen listo: se arma con nodos (nada de innerHTML con datos escritos por el usuario).
  const n = estado.archivos.length;
  const docs = n === 0
    ? 'sin documentos'
    : n + (n === 1 ? ' documento' : ' documentos');

  const seg = document.createElement('strong');
  seg.textContent = estado.segmento;
  const cli = document.createElement('strong');
  cli.textContent = idCliente;

  resumen.append('Análisis: ', seg, ' / cliente ', cli, ', ' + docs + '.');
}

/* -------------------------------------------------------------------------- *
 * Presentacion del resultado
 *
 * Todo se arma con nodos del DOM, nunca con innerHTML: los valores vienen de la
 * base de datos y no deben poder interpretarse como HTML.
 * -------------------------------------------------------------------------- */

function crear(tag, clase, contenido) {
  const el = document.createElement(tag);
  if (clase) el.className = clase;
  if (contenido != null) el.textContent = contenido;
  return el;
}

function limpiarResultado() {
  $('resultado').textContent = '';
  cerrarModalResultado();
  mostrar($('boton-reabrir-resultado'), false);
  estado.informe = null;
  // Los ids del analisis anterior ya no existen: si quedaran, el PDF del siguiente
  // cliente pediria bloques de este.
  estado.incluirEnPdf.clear();
}

/**
 * Abre/cierra la ventana emergente del resultado.
 *
 * Cerrarla NO borra nada: el informe sigue armado en el DOM y en `estado`, asi que
 * mientras no se cambie de cliente (eso si pasa por `limpiarResultado`) el boton
 * "Ver resultado del analisis" puede reabrirla tal cual quedo.
 */
function abrirModalResultado() {
  mostrar($('modal-resultado'), true);
  mostrar($('boton-reabrir-resultado'), false);
  // Bloquea el scroll de la pagina de atras: sin esto, al llegar al tope o al fondo
  // del contenido del modal el gesto de scroll seguia moviendo la pagina detras.
  document.body.classList.add('modal-resultado-abierto');
}

function cerrarModalResultado() {
  mostrar($('modal-resultado'), false);
  mostrar($('boton-reabrir-resultado'), Boolean(estado.informe));
  document.body.classList.remove('modal-resultado-abierto');
}

function _identidad(enc) {
  const caja = crear('div', 'identidad');

  // El texto va primero y con flex:1 (`.identidad-textos`), así ocupa todo el
  // espacio que las banderas no usan y las empuja contra el borde derecho de la
  // caja, se llamen una o varias.
  const textos = crear('div', 'identidad-textos');
  textos.append(crear('div', 'identidad-nombre', enc.nombre));
  if (enc.subtitulo) textos.append(crear('div', 'identidad-sub', enc.subtitulo));

  const id = crear('div', 'identidad-id');
  id.append('ID DE CLIENTE', crear('b', null, enc.id));
  textos.append(id);

  caja.append(textos);

  // Una bandera por cada documento APROBADO, de la más antigua a la más nueva: son
  // los países donde la empresa le abrió cuenta al cliente (lo arma el backend, ver
  // `_banderas_de_documentos`). No es el país de origen, que es otro dato y vive en el
  // detalle de la persona.
  //
  // Van en fila de izquierda a derecha, todas del mismo tamaño sin importar cuántas
  // sean (`.identidad-banderas`): nada de apilarlas ni encogerlas.
  const paises = enc.banderas_paises || [];
  if (paises.length) {
    const fila = crear('div', 'identidad-banderas');
    for (const p of paises) {
      const bandera = document.createElement('img');
      bandera.className = 'identidad-bandera';
      bandera.src = 'banderas/' + p.codigo + '.svg';
      bandera.alt = p.pais || p.codigo;
      // Al pasar el mouse, de qué documento salió cada una. Si el documento está
      // PENDIENTE se dice: el país cuenta igual, pero la empresa no lo confirmó.
      bandera.title = [p.pais || p.codigo, p.tipo,
        p.aprobado === false ? 'pendiente de revisión'
          : p.validado && 'validado ' + p.validado]
        .filter(Boolean).join(' · ');
      // Si falta el archivo de esa bandera se quita esa sola, sin romper el resto.
      bandera.addEventListener('error', () => bandera.remove());
      fila.append(bandera);
    }
    caja.append(fila);
  } else {
    // Sin documentos (ni aprobados ni pendientes) no hay bandera: las iniciales.
    caja.append(crear('div', 'identidad-avatar', enc.iniciales));
  }

  return caja;
}

/**
 * Checkbox que decide si un bloque va al PDF.
 *
 * El `id` lo pone el backend y es lo unico que se le manda de vuelta al pedir el PDF:
 * el checkbox no viaja ni se dibuja en el informe descargable, solo elige qué entra.
 *
 * `titulo` describe el bloque para el lector de pantalla, porque visualmente el
 * checkbox va suelto al lado del contenido y sin etiqueta propia.
 */
function _incluir(id, titulo, marcadoPorDefecto = true) {
  if (marcadoPorDefecto) estado.incluirEnPdf.add(id);
  else estado.incluirEnPdf.delete(id);

  const etiqueta = crear('label', 'incluir');
  const casilla = document.createElement('input');
  casilla.type = 'checkbox';
  casilla.checked = marcadoPorDefecto;
  // Sin texto visible: solo el cuadrado. El proposito va en `title` (al pasar el mouse)
  // y en `aria-label` (para lector de pantalla), que es lo que lo mantiene accesible
  // sin ensuciar el bloque con una palabra repetida una vez por seccion.
  const proposito = 'Incluir "' + titulo + '" en el PDF';
  casilla.setAttribute('aria-label', proposito);
  etiqueta.title = proposito;
  casilla.addEventListener('change', () => {
    if (casilla.checked) estado.incluirEnPdf.add(id);
    else estado.incluirEnPdf.delete(id);
  });
  etiqueta.append(casilla);
  return etiqueta;
}

function _banderas(banderas) {
  const caja = crear('div', 'banderas');
  for (const b of banderas) {
    const item = crear('div', 'bandera bandera--' + (b.tono || 'neutro'));
    item.append(crear('span', 'bandera-etiqueta', b.etiqueta));
    item.append(crear('span', 'bandera-valor', b.valor));
    // El estado inicial lo decide el backend (`pdf`): riesgo y compliance arrancan
    // desmarcados porque historicamente no iban al descargable.
    if (b.id) item.append(_incluir(b.id, b.etiqueta, b.pdf !== false));
    caja.append(item);
  }
  return caja;
}

function _dato(campo) {
  const esLista = Array.isArray(campo.valor);
  const vacio = esLista ? campo.valor.length === 0 : !campo.valor;

  const caja = crear('div', 'dato' + (esLista || campo.tipo === 'lista' ? ' dato--ancho' : ''));
  caja.append(crear('span', 'dato-etiqueta', campo.etiqueta));

  if (vacio) {
    caja.append(crear('span', 'dato-valor dato-valor--vacio', 'Sin dato'));
  } else if (esLista) {
    const fichas = crear('div', 'fichas');
    for (const item of campo.valor) fichas.append(crear('span', 'ficha', item));
    caja.append(fichas);
  } else {
    caja.append(crear('span', 'dato-valor', campo.valor));
  }
  return caja;
}

function _secciones(secciones) {
  const caja = crear('div', 'datos');
  for (const s of secciones) {
    const grupo = crear('section', 'datos-grupo');
    const cabecera = crear('div', 'datos-cabecera');
    cabecera.append(crear('h2', 'datos-titulo', s.titulo));
    if (s.id) cabecera.append(_incluir(s.id, s.titulo));
    grupo.append(cabecera);
    const rejilla = crear('div', 'datos-rejilla');
    for (const campo of s.campos) rejilla.append(_dato(campo));
    grupo.append(rejilla);
    caja.append(grupo);
  }
  return caja;
}

/**
 * Datos leídos de un documento con esquema: un formulario KYC de la empresa o un
 * documento de identidad. Los dos se dibujan igual porque el backend (`core/campos.py`)
 * les da la misma forma.
 *
 * Las casillas se muestran como texto: solo lo marcado, nunca la lista completa.
 *
 * Un campo vacío dice "En blanco" y no "Sin dato": el campo existe en el papel y el
 * cliente decidió no completarlo, que es información en sí misma.
 *
 * Si el documento vence, arriba va una franja con cuántos días quedan (o cuántos lleva
 * vencido, en rojo). Ese cálculo lo hace el backend, para que la pantalla y el PDF
 * digan exactamente lo mismo.
 */
function _extraido(extraido, titulo, unidad) {
  const caja = crear('div', 'form');

  const enc = crear('div', 'form-encabezado');
  const izq = crear('div', 'form-encabezado-txt');
  izq.append(crear('span', 'form-titulo', titulo));
  // De quién es el documento, para no tener que buscarlo entre los campos.
  if (extraido.titular) izq.append(crear('span', 'form-titular', extraido.titular));
  enc.append(izq);
  const comp = extraido.completitud || {};
  enc.append(crear('span', 'form-completitud',
    `${comp.completados || 0} de ${comp.total || 0} ${unidad || 'campos completados'}`));
  caja.append(enc);

  // El vencimiento va arriba de los campos: es lo que hay que ver primero.
  // `antiguedad` es el equivalente de un comprobante de domicilio (cuánto hace que se
  // emitió): misma franja, porque responde la misma pregunta de "sigue sirviendo".
  const banda = extraido.vigencia || extraido.antiguedad;
  if (banda) {
    caja.append(crear('div', 'form-vigencia form-vigencia--' + banda.estado,
      banda.texto));
  }

  // Y debajo, si el documento traía MRZ, si concuerda con lo impreso.
  if (extraido.validacion) caja.append(_validacion(extraido.validacion));

  // Después el contraste contra la base: primero el documento contra sí mismo, después
  // contra lo que la empresa tiene registrado.
  if (extraido.contraste) caja.append(_contraste(extraido.contraste));

  if (extraido.error) {
    caja.append(crear('div', 'doc-motivo',
      'No se pudieron leer los datos: ' + extraido.error));
    return caja;
  }

  for (const seccion of extraido.secciones || []) {
    const grupo = crear('div', 'form-seccion');
    grupo.append(crear('h3', 'form-seccion-titulo', seccion.titulo));

    const campos = crear('div', 'form-campos');
    for (const campo of seccion.campos || []) {
      // Un campo sangrado (el detalle de "Otros") va corrido a la derecha para que se
      // lea como parte del campo de arriba y no como un campo suelto.
      const fila = crear('div', 'form-campo' + (campo.sangria ? ' form-campo--sangria' : ''));
      fila.append(crear('span', 'form-etiqueta', campo.etiqueta));
      fila.append(_valorFormulario(campo));
      campos.append(fila);
    }
    grupo.append(campos);
    caja.append(grupo);
  }

  return caja;
}

/**
 * Texto de una carta explicativa de origen de fondos.
 *
 * No tiene campos que mostrar en una grilla (a diferencia de un formulario): es un
 * escrito libre, así que se presenta como texto corrido, un párrafo por cada salto
 * de línea doble que trajo la respuesta ya ordenada por el backend. No hay
 * contraste: no hay nada campo a campo que comparar contra la base.
 */
function _carta(carta) {
  const caja = crear('div', 'form');

  const enc = crear('div', 'form-encabezado');
  enc.append(crear('span', 'form-titulo', carta.titulo || 'Carta explicativa'));
  caja.append(enc);

  if (carta.error) {
    caja.append(crear('div', 'doc-motivo',
      'No se pudo leer el texto: ' + carta.error));
    return caja;
  }

  if (!carta.texto) {
    caja.append(crear('div', 'form-valor form-valor--vacio',
      'No se pudo leer texto en este documento.'));
    return caja;
  }

  const cuerpo = crear('div', 'carta-texto');
  for (const parrafo of carta.texto.split('\n\n')) {
    if (parrafo.trim()) cuerpo.append(crear('p', null, parrafo.trim()));
  }
  caja.append(cuerpo);

  return caja;
}

/**
 * Resultado de verificar los datos impresos contra la MRZ del reverso.
 *
 * La MRZ no se muestra (no le dice nada al analista): se usa para comprobar el resto
 * del documento contra sí mismo. Una discrepancia es lo único que pide ir a mirar el
 * documento; que no se pueda verificar es información, no alarma.
 */
function _validacion(validacion) {
  const caja = crear('div', 'form-validacion form-validacion--' + validacion.estado);
  caja.append(crear('span', 'form-validacion-txt', validacion.texto));
  for (const d of validacion.discrepancias || []) {
    const linea = crear('div', 'form-validacion-dif');
    linea.append(crear('b', null, d.campo), ': el documento dice ');
    linea.append(crear('b', null, `"${d.documento}"`), ' y la MRZ ');
    linea.append(crear('b', null, `"${d.mrz}"`));
    caja.append(linea);
  }
  return caja;
}

/**
 * Contraste del documento contra la base de datos.
 *
 * Misma franja que la verificación con la MRZ, para no inventar un lenguaje visual
 * nuevo: lo verde concuerda, lo rojo hay que mirarlo, lo neutro es informativo.
 *
 * Si el documento NO es del cliente en análisis, el backend no compara campo por campo
 * (serían discrepancias garantizadas entre dos personas distintas), así que acá solo
 * hay una línea diciendo de quién es.
 *
 * Sirve igual para un documento de identidad y para un formulario. En el formulario hay
 * DOS fuentes contra las que se compara (la base y el documento de identidad que vino
 * en el mismo envío), y por eso cada discrepancia dice de dónde sale el otro valor.
 */
function _contraste(contraste) {
  const caja = crear('div', 'form-validacion form-validacion--' + contraste.estado);
  caja.append(crear('span', 'form-validacion-txt', contraste.texto));

  const sujeto = contraste.sujeto || 'el documento';
  for (const d of contraste.discrepancias || []) {
    const linea = crear('div', 'form-validacion-dif');
    linea.append(crear('b', null, d.campo), `: ${sujeto} dice `);
    linea.append(crear('b', null, `"${d.documento}"`), ` y ${d.fuente || 'la base'} `);
    linea.append(crear('b', null, `"${d.base}"`));
    caja.append(linea);
  }

  // Qué se pudo confirmar: sin esto, "concuerda" no dice contra qué.
  if (contraste.coincidencias && contraste.coincidencias.length) {
    caja.append(crear('div', 'form-validacion-dif',
      'Coinciden: ' + contraste.coincidencias.join(' · ')));
  }
  return caja;
}

function _valorFormulario(campo) {
  const valor = campo.valor;

  // Pares suelto/valor: cada fila trae su PROPIO nombre de dato ("Nombre del Padre",
  // "Código de verificación"), a diferencia de una tabla de columnas fijas. Se muestra
  // el dato con su valor y nada más: sin las etiquetas de columna "Dato"/"Valor", que
  // no dicen nada por sí solas.
  if (campo.tipo === 'pares') {
    const pares = (valor || []).filter((p) => p.valor);
    if (!pares.length) return crear('span', 'form-valor form-valor--vacio', 'En blanco');
    const caja = crear('div', 'form-filas');
    for (const par of pares) {
      const linea = crear('div', 'form-fila');
      const celda = crear('span', 'form-celda');
      celda.append(crear('span', 'form-celda-etiqueta', par.etiqueta));
      celda.append(crear('span', null, par.valor));
      linea.append(celda);
      caja.append(linea);
    }
    return caja;
  }

  if (campo.tipo === 'tabla') {
    const filas = (valor || []).filter((f) => f.some((c) => c.valor));
    if (!filas.length) return crear('span', 'form-valor form-valor--vacio', 'En blanco');
    const caja = crear('div', 'form-filas');
    for (const fila of filas) {
      const linea = crear('div', 'form-fila');
      for (const celda of fila) {
        if (!celda.valor) continue;
        const par = crear('span', 'form-celda');
        par.append(crear('span', 'form-celda-etiqueta', celda.etiqueta));
        par.append(crear('span', null, celda.valor));
        linea.append(par);
      }
      caja.append(linea);
    }
    return caja;
  }

  if (Array.isArray(valor)) {
    if (!valor.length) return crear('span', 'form-valor form-valor--vacio', 'En blanco');
    const fichas = crear('div', 'form-fichas');
    for (const item of valor) fichas.append(crear('span', 'form-ficha', item));
    return fichas;
  }

  if (!valor) return crear('span', 'form-valor form-valor--vacio', 'En blanco');
  return crear('span', 'form-valor', valor);
}

/**
 * Resumen de lo que varios documentos de identidad tienen en común.
 *
 * Solo aparece con dos o más (el backend devuelve `null` con uno solo, donde el resumen
 * sería una copia). Un dato que no coincide entre ellos se marca con las dos versiones
 * enfrentadas: no es necesariamente un problema (una doble nacionalidad es legítima),
 * pero es lo primero que el analista quiere ver.
 */
function _resumenIdentidades(resumen) {
  const caja = crear('article', 'doc');
  const bloque = crear('div', 'form');

  const enc = crear('div', 'form-encabezado');
  const izq = crear('div', 'form-encabezado-txt');
  izq.append(crear('span', 'form-titulo', resumen.titulo));
  izq.append(crear('span', 'form-titular', resumen.documentos + ' documentos'));
  enc.append(izq);
  if (resumen.id) enc.append(_incluir(resumen.id, resumen.titulo));
  bloque.append(enc);

  bloque.append(crear('div', 'form-validacion form-validacion--' + resumen.estado,
    resumen.texto));

  const seccion = crear('div', 'form-seccion');
  const campos = crear('div', 'form-campos');
  for (const campo of resumen.campos || []) {
    const fila = crear('div', 'form-campo');
    fila.append(crear('span', 'form-etiqueta', campo.etiqueta));
    if (campo.coincide) {
      fila.append(crear('span', 'form-valor', campo.valor));
    } else {
      // Las versiones distintas, una ficha por cada una, para que se lea cuál dice qué.
      const fichas = crear('div', 'form-fichas');
      for (const v of campo.valores) {
        fichas.append(crear('span', 'form-ficha form-ficha--dispar', v));
      }
      fila.append(fichas);
    }
    campos.append(fila);
  }
  seccion.append(campos);
  bloque.append(seccion);

  caja.append(bloque);
  return caja;
}

/**
 * Personas relacionadas con el cliente, UNA vez cada una.
 *
 * No es una tarjeta por documento: si tres documentos acreditan el mismo vínculo, la
 * persona aparece una sola vez y los tres se citan abajo como respaldo (lo consolida
 * el backend, `core/beneficiarios.py`). El cliente no se lista: la sección responde
 * quiénes son los OTROS y qué son de él.
 *
 * Si dos documentos se contradicen, las dos versiones quedan enfrentadas en ámbar,
 * igual que un dato dispar en el resumen de identidades. Y si el vínculo solo lo
 * sostiene un escrito del propio cliente, va el aviso de que describe la relación
 * pero no la acredita.
 */
function _beneficiarios(rel) {
  const caja = crear('article', 'doc');
  const bloque = crear('div', 'form');

  const enc = crear('div', 'form-encabezado');
  const izq = crear('div', 'form-encabezado-txt');
  izq.append(crear('span', 'form-titulo', rel.titulo));
  const n = (rel.personas || []).length;
  const d = rel.documentos || 0;
  izq.append(crear('span', 'form-titular',
    `${n === 1 ? '1 persona' : n + ' personas'} · `
    + `${d === 1 ? '1 documento' : d + ' documentos'}`));
  enc.append(izq);
  if (rel.id) enc.append(_incluir(rel.id, rel.titulo));
  bloque.append(enc);

  bloque.append(crear('div', 'form-validacion form-validacion--' + rel.estado,
    rel.texto));

  for (const persona of rel.personas || []) {
    const seccion = crear('div', 'form-seccion');
    seccion.append(crear('h3', 'form-seccion-titulo', persona.nombre));

    const campos = crear('div', 'form-campos');

    // La relación es el dato que se vino a buscar, así que va primera.
    const filaRel = crear('div', 'form-campo');
    filaRel.append(crear('span', 'form-etiqueta', 'Relación con el cliente'));
    if (persona.relacion) {
      filaRel.append(crear('span', 'form-valor', persona.relacion));
    } else if (persona.relacion_dispar) {
      const fichas = crear('div', 'form-fichas');
      for (const r of persona.relaciones) {
        fichas.append(crear('span', 'form-ficha form-ficha--dispar', r));
      }
      filaRel.append(fichas);
    } else {
      const motivos = persona.sin_relacion_motivos || [];
      const detalle = motivos[0] ? ` (${motivos[0]})` : '';
      filaRel.append(crear('span', 'form-valor form-valor--vacio',
        'No determinada' + detalle));
    }
    campos.append(filaRel);

    if ((persona.numeros || []).length) {
      const fila = crear('div', 'form-campo');
      fila.append(crear('span', 'form-etiqueta', 'Número de documento'));
      fila.append(crear('span', 'form-valor', persona.numeros.join(' · ')));
      campos.append(fila);
    }

    if ((persona.roles || []).length) {
      const fila = crear('div', 'form-campo');
      fila.append(crear('span', 'form-etiqueta', 'Figura como'));
      fila.append(crear('span', 'form-valor', persona.roles.join(' · ')));
      campos.append(fila);
    }

    // Los documentos que respaldan la relación: es lo que la vuelve verificable, y lo
    // que deja ver que el mismo vínculo está acreditado más de una vez.
    const filaEv = crear('div', 'form-campo');
    filaEv.append(crear('span', 'form-etiqueta', 'Acreditada por'));
    const lista = crear('div', 'form-filas');
    for (const ev of persona.evidencias || []) {
      const linea = crear('div', 'form-fila');
      const celda = crear('span', 'form-celda');
      celda.append(crear('span', 'form-celda-etiqueta',
        ev.tipo_documento || 'Documento'));
      const partes = [];
      if (ev.fecha) partes.push(ev.fecha);
      if (ev.archivo) partes.push(ev.archivo);
      celda.append(crear('span', 'form-valor', partes.join(' · ') || '—'));
      if (!ev.formal) celda.append(crear('span', 'doc-nueva', 'No formal'));
      linea.append(celda);
      lista.append(linea);
    }
    filaEv.append(lista);
    campos.append(filaEv);

    seccion.append(campos);

    // El aviso va al final del bloque de la persona, para que se lea después de ver
    // de qué documentos depende la relación.
    if (persona.aviso) seccion.append(crear('div', 'doc-motivo', persona.aviso));

    bloque.append(seccion);
  }

  caja.append(bloque);
  return caja;
}

/**
 * Análisis de documentos, una entrada por documento.
 *
 * Va después de la información de la persona. Cada bloque lleva un checkbox que decide
 * si va al PDF; el checkbox NO se dibuja en el informe descargable.
 */
function _documentos(analisis) {
  const caja = crear('section', 'docs');

  const enc = crear('div', 'docs-encabezado');
  enc.append(crear('h2', null, 'Análisis de documentos'));
  const r = analisis.resumen || {};
  const recuento = [`${r.archivos || 0} archivo(s)`, `${r.documentos || 0} documento(s)`];
  if (r.formularios) recuento.push(`${r.formularios} formulario(s)`);
  if (r.cartas) recuento.push(`${r.cartas} carta(s) explicativa(s)`);
  if (r.domicilios) recuento.push(`${r.domicilios} comprobante(s) de domicilio`);
  if (r.soportes) recuento.push(`${r.soportes} comprobante(s) de soporte`);
  if (r.beneficiarios) recuento.push(`${r.beneficiarios} persona(s) relacionada(s)`);
  if (r.identidades) recuento.push(`${r.identidades} documento(s) de identidad`);
  recuento.push(`${r.a_revision || 0} a revisión`);
  enc.append(crear('span', 'docs-resumen', recuento.join(' · ')));
  // Cuanto acreditan los comprobantes de soporte, sumado POR MONEDA. Va acá arriba y
  // no dentro de cada tarjeta porque es la lectura del CONJUNTO: el promedio de esta
  // categoría es de casi cuatro comprobantes por petición, y una serie de doce
  // liquidaciones del mismo empleo se lee como un total, no como doce tarjetas.
  //
  // No se convierte de moneda a propósito (ver core/soportes.py): "USD 27.000 + CLP
  // 8.400.000" es exacto, y una sola cifra sería una estimación disfrazada de dato.
  const totales = analisis.totales_soporte || [];
  if (totales.length) {
    const linea = crear('div', 'docs-totales');
    linea.append(crear('span', 'docs-totales-titulo', 'Acreditado como ingreso'));
    for (const t of totales) {
      const ficha = crear('span', 'docs-total');
      ficha.append(crear('b', null, `${t.moneda} ${t.total_legible}`));
      ficha.append(crear('span', null,
        t.documentos === 1
          ? `1 ${t.naturaleza.toLowerCase()}`
          : `${t.documentos} \u00d7 ${t.naturaleza.toLowerCase()}`));
      linea.append(ficha);
    }
    // Un monto que no se pudo interpretar como número no entra en la suma, y hay que
    // decirlo: un total que parece completo cuando no lo está es peor que no darlo.
    const sin = totales[0].sin_interpretar || 0;
    if (sin) {
      linea.append(crear('span', 'docs-total-aviso',
        sin === 1
          ? '1 comprobante con un monto que no se pudo sumar'
          : `${sin} comprobantes con montos que no se pudieron sumar`));
    }
    enc.append(linea);
  }

  // Lo que los comprobantes ACREDITAN contra lo que el cliente DECLARÓ en su
  // formulario KYC. Es la conclusión del análisis de esta categoría, así que va arriba
  // del listado y no dentro de una tarjeta: cruza dos categorías que llegan en
  // archivos distintos (ver `comparar_respaldo` en core/contraste.py).
  //
  // Informativo, sin alertas: que falte respaldo de algo declarado puede ser
  // simplemente que el cliente todavía no lo mandó.
  const respaldo = analisis.respaldo_declarado;
  if (respaldo) {
    const franja = crear('div', 'docs-respaldo docs-respaldo--' + respaldo.estado);
    franja.append(crear('span', 'docs-respaldo-titulo', 'Respaldo de lo declarado'));
    // El texto trae saltos de línea (lo que falta y lo que sobra van en líneas
    // aparte): cada uno es su propio párrafo, igual que en el contraste de domicilio.
    for (const parrafo of (respaldo.texto || '').split('\n')) {
      if (parrafo) franja.append(crear('div', 'docs-respaldo-txt', parrafo));
    }
    // Con qué se respalda cada origen declarado: sin esto, "tiene respaldo" no dice
    // contra qué comprobante.
    for (const r of respaldo.respaldados || []) {
      const linea = crear('div', 'docs-respaldo-par');
      linea.append(crear('b', null, r.declarado));
      linea.append(r.con && r.con !== r.declarado
        ? ` ← respaldado con: ${r.con}`
        : ' ← respaldado');
      franja.append(linea);
    }
    enc.append(franja);
  }
  // Un documento de identidad vencido se avisa acá arriba y no solo dentro de su
  // tarjeta: es lo que hace que el analista no siga adelante sin verlo.
  if (r.identidades_vencidas) {
    enc.append(crear('span', 'docs-vencidos',
      r.identidades_vencidas === 1
        ? '1 documento de identidad vencido'
        : `${r.identidades_vencidas} documentos de identidad vencidos`));
  }
  // Un documento que es de otro cliente se avisa acá arriba, igual que un vencido: es
  // lo que hace que el analista no siga adelante sin verlo.
  if (r.identidades_ajenas) {
    enc.append(crear('span', 'docs-vencidos',
      r.identidades_ajenas === 1
        ? '1 documento no corresponde al cliente'
        : `${r.identidades_ajenas} documentos no corresponden al cliente`));
  }
  caja.append(enc);

  // Con varios documentos de identidad, primero el resumen de lo que tienen en común:
  // ahorra comparar dos fichas campo por campo.
  if (analisis.resumen_identidades) {
    caja.append(_resumenIdentidades(analisis.resumen_identidades));
  }

  // El documento de identidad va PRIMERO y sin nombre de archivo: es una sola cosa
  // (frente y reverso unificados) y responde de quién son los demás documentos.
  // Una persona puede tener VARIOS: cada uno es su propia entrada, con su checkbox.
  for (const documento of analisis.identidades || []) {
    const tarjeta = crear('article', 'doc');
    const titulo = documento.titular
      ? 'Documento de identidad de ' + documento.titular
      : 'Documento de identidad';
    if (documento.id) {
      const barra = crear('div', 'doc-barra');
      barra.append(_incluir(documento.id, titulo));
      tarjeta.append(barra);
    }
    tarjeta.append(_extraido(documento, 'Documento de identidad', 'datos leídos'));
    caja.append(tarjeta);
  }

  // Las personas relacionadas van después de la identidad del cliente: primero quién
  // es él, después quiénes son los otros y qué son de él.
  if (analisis.relacion_beneficiarios) {
    caja.append(_beneficiarios(analisis.relacion_beneficiarios));
  }

  // Una tarjeta por DOCUMENTO, no por archivo: un archivo con una boleta y una factura
  // sale como DOS tarjetas, cada una repitiendo el nombre del archivo y con UN solo
  // checkbox. Antes las dos compartían tarjeta y la boleta parecía pertenecer a la
  // factura (ver `agregar_documentos` en core/informe.py).
  for (const doc of analisis.documentos || []) {
    const c = doc.clasificacion || {};
    const tarjeta = crear('article', 'doc');

    const cabecera = crear('div', 'doc-archivo');
    cabecera.append(crear('span', 'doc-archivo-icono', extension(doc.archivo || '')));
    cabecera.append(crear('span', null, doc.archivo || '—'));
    // El único checkbox del documento va acá, en la cabecera: es la unidad que el
    // analista marca o desmarca, y así queda claro que manda sobre TODO lo de abajo.
    if (doc.id) {
      const nombreDoc = c.subcategoria_legible
        ? `${c.categoria_legible} › ${c.subcategoria_legible}`
        : (c.categoria_legible || doc.archivo || 'documento');
      cabecera.append(_incluir(doc.id, nombreDoc));
    }
    tarjeta.append(cabecera);

    // Un documento sin clasificación es un comprobante que la extracción leyó y el
    // clasificador no listó aparte: se muestra igual, pero sin la línea de
    // categoría/confianza, que no le corresponde.
    const bloque = crear('div',
      'doc-clasificacion' + (c.revision ? ' doc-clasificacion--revision' : ''));

    if (doc.clasificacion) {
      const titulo = crear('div', 'doc-titulo');
      titulo.append(crear('span', null, c.categoria_legible));
      if (c.subcategoria_legible) {
        titulo.append(crear('span', 'doc-flecha', '›'));
        titulo.append(crear('span', 'doc-sub', c.subcategoria_legible));
      }
      if (c.subcategoria_nueva) {
        titulo.append(crear('span', 'doc-nueva', 'Subcategoría nueva'));
      }
      bloque.append(titulo);

      const meta = crear('div', 'doc-meta');
      if (c.confianza_pct) {
        const conf = crear('span');
        conf.append('confianza ', crear('b', null, c.confianza_pct));
        meta.append(conf);
      }
      if (c.idioma) {
        const idi = crear('span');
        idi.append('idioma ', crear('b', null, c.idioma));
        meta.append(idi);
      }
      if (c.subtipo_legible) meta.append(crear('span', null, c.subtipo_legible));
      if (c.ruta) meta.append(crear('span', 'doc-ruta', c.ruta));
      if (meta.childElementCount) bloque.append(meta);

      if (c.motivo) bloque.append(crear('div', 'doc-motivo', c.motivo));

      // Si el documento era uno de los formularios KYC, lo que completó el cliente.
      if (c.formulario) {
        bloque.append(_extraido(c.formulario, 'Datos declarados en el formulario'));
      }

      // Si era una carta explicativa de origen de fondos, su texto.
      if (c.carta) bloque.append(_carta(c.carta));
    }

    // Si es un comprobante de domicilio, su dirección y a nombre de quién viene.
    if (doc.domicilio) {
      bloque.append(_extraido(doc.domicilio, 'Comprobante de domicilio', 'datos leídos'));
    }

    // Si es un comprobante de soporte, qué acredita, por cuánto y entre quiénes. Usa el
    // mismo renderizador genérico: el esquema de `core.soportes` esconde por su cuenta
    // los campos que no corresponden al tipo de documento (ver `depende_de`), así que
    // acá no hay nada que decidir.
    if (doc.soporte) {
      bloque.append(_extraido(doc.soporte, 'Comprobante de soporte', 'datos leídos'));
    }

    tarjeta.append(bloque);
    caja.append(tarjeta);
  }

  const aprendidas = analisis.aprendidas || [];
  if (aprendidas.length) {
    const aviso = crear('div', 'docs-aprendidas');
    aviso.append(`Se aprendieron ${aprendidas.length} subcategoría`
      + (aprendidas.length === 1 ? '' : 's') + ' nueva'
      + (aprendidas.length === 1 ? '' : 's') + ': ');
    aviso.append(crear('b', null,
      aprendidas.map((a) => `${a.categoria}/${a.subcategoria}`).join(', ')));
    aviso.append('. Quedan disponibles para los próximos análisis.');
    caja.append(aviso);
  }

  return caja;
}

/**
 * Texto del pie fijo del modal ("Informe listo · N de M campos · archivo X.pdf").
 *
 * El boton "Descargar PDF" ya esta en el HTML (fijo, siempre a la vista): aca solo
 * se actualiza el texto que lo acompaña.
 */
function _pieResultado(informe, nombrePdf) {
  const el = $('resultado-pie-texto');
  el.textContent = '';
  const comp = informe.completitud;
  el.append('Informe listo');
  if (comp) el.append(` · ${comp.con_dato} de ${comp.total} campos con dato`);
  el.append(' · archivo ');
  el.append(crear('strong', null, nombrePdf));
}

function _sinDatos(informe) {
  const caja = crear('div', 'sin-datos');
  const icono = crear('div', 'sin-datos-icono');
  icono.innerHTML =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/>'
    + '<path d="M20 20l-4.5-4.5"/></svg>';
  caja.append(icono);
  caja.append(crear('h2', null, 'Sin resultados'));
  for (const a of informe.avisos || []) caja.append(crear('p', null, a));
  return caja;
}

function pintarResultado(respuesta) {
  const informe = respuesta.informe || {};
  estado.informe = informe;
  estado.nombrePdf = respuesta.nombre_pdf || 'analisis_rfis.pdf';

  const caja = $('resultado');
  caja.textContent = '';

  if (!informe.encontrado) {
    caja.append(_sinDatos(informe));
    // Nada que descargar: el pie con el boton de PDF no tiene sentido aca.
    mostrar($('modal-resultado-pie'), false);
    abrirModalResultado();
    return;
  }

  caja.append(_identidad(informe.encabezado));
  if (informe.banderas) caja.append(_banderas(informe.banderas));

  for (const a of informe.avisos || []) {
    const aviso = crear('div', 'mensaje mensaje--info', a);
    aviso.style.marginTop = '18px';
    aviso.style.marginBottom = '0';
    caja.append(aviso);
  }

  caja.append(_secciones(informe.secciones || []));

  // El análisis de documentos va después de la información de la persona.
  if (informe.analisis_documentos) {
    caja.append(_documentos(informe.analisis_documentos));
  }

  _pieResultado(informe, estado.nombrePdf);
  mostrar($('modal-resultado-pie'), true);
  abrirModalResultado();
}

async function descargarPdf(boton) {
  const etiqueta = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Generando...';
  limpiarMensajes();

  const cuerpo = new FormData();
  cuerpo.append('segmento', estado.segmento);
  cuerpo.append('id_cliente', $('id-cliente').value.trim());
  // Solo los bloques que el analista dejo marcados. Va la lista de `id`, no el
  // contenido: el backend rearma el informe desde la BD y descarta lo no elegido.
  cuerpo.append('incluir', JSON.stringify([...estado.incluirEnPdf]));

  try {
    const resp = await api('/informe.pdf', { method: 'POST', body: cuerpo, crudo: true });
    const blob = await resp.blob();

    // Descarga desde memoria: el PDF viaja con la cabecera Authorization, asi que
    // no se puede abrir la URL directamente en una pestana nueva.
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = estado.nombrePdf;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    mensaje('app-error', 'No se pudo generar el PDF: ' + e.message);
  } finally {
    boton.disabled = false;
    boton.textContent = etiqueta;
  }
}

/**
 * Frase que se le muestra al analista mientras espera.
 *
 * Distingue los dos motivos por los que puede estar esperando, que para el no son lo
 * mismo: si esta en cola es porque otro analista llego antes, y si esta procesando es
 * su propio analisis avanzando.
 */
function textoAvance(t) {
  if (t.estado === 'en_cola') {
    return t.posicion > 1
      ? `En cola: ${t.posicion}º puesto. Hay otro análisis en curso...`
      : 'En cola, a punto de empezar...';
  }
  if (t.total > 0) {
    return `${t.detalle || 'Analizando'}: ${t.hechos} de ${t.total}...`;
  }
  return 'Consultando la base de datos...';
}

/**
 * Sondea un analisis encolado hasta que termina, y devuelve su resultado.
 *
 * El backend responde al POST con un identificador en vez de dejar la peticion
 * abierta durante minutos: asi ningun proxy la corta por timeout, un despliegue no
 * mata el analisis en curso, y se puede mostrar el avance en vez de un spinner mudo.
 */
async function esperarAnalisis(trabajoId) {
  for (;;) {
    const resp = await api('/analisis/' + encodeURIComponent(trabajoId));
    const t = resp.trabajo || {};

    if (t.estado === 'listo') return t.resultado;
    if (t.estado === 'error') throw new Error(t.mensaje || 'El análisis falló.');

    estado.avance = textoAvance(t);
    actualizarBoton();
    await new Promise((r) => setTimeout(r, SONDEO_ANALISIS_MS));
  }
}

async function analizar() {
  limpiarMensajes();
  limpiarResultado();

  // La conexion se revalida justo antes de ejecutar: el cluster pudo apagarse desde
  // el ultimo sondeo.
  await sondearConexion();
  if (!estado.conexionOk) return;

  estado.enviando = true;
  estado.avance = 'Enviando documentos...';
  actualizarBoton();

  const cuerpo = new FormData();
  cuerpo.append('segmento', estado.segmento);
  cuerpo.append('id_cliente', $('id-cliente').value.trim());
  // Modo encolado: el backend acusa recibo al instante y este cliente sondea. Sin
  // esto el backend esperaria a terminar antes de responder, que es el contrato
  // antiguo y sigue funcionando.
  cuerpo.append('asincrono', '1');
  for (const f of estado.archivos) cuerpo.append('documentos', f, f.name);

  try {
    const acuse = await api('/analizar', { method: 'POST', body: cuerpo });
    estado.avance = 'En cola, a punto de empezar...';
    actualizarBoton();
    pintarResultado(await esperarAnalisis(acuse.trabajo.id));
  } catch (e) {
    mensaje('app-error', e.message);
  } finally {
    estado.enviando = false;
    estado.avance = '';
    actualizarBoton();
  }
}

/* -------------------------------------------------------------------------- *
 * Arranque
 * -------------------------------------------------------------------------- */

function entrarALaApp() {
  mostrar($('pantalla-login'), false);
  mostrar($('modal-sesion'), false);
  mostrar($('pantalla-app'), true);

  const u = estado.usuario || {};
  texto('usuario-nombre', u.name || '');
  texto('usuario-mail', u.email || '');
  const foto = $('usuario-foto');
  if (u.picture) {
    foto.src = u.picture;
    foto.alt = u.name || u.email || '';
  } else {
    mostrar(foto, false);
  }

  arrancarVigilanciaSesion();
  sondearConexion();
  clearInterval(timerConexion);
  timerConexion = setInterval(() => sondearConexion({ mostrarModal: false }), SONDEO_CONEXION_MS);
}

function conectarEventos() {
  $('seg-b2c').addEventListener('click', () => elegirSegmento('B2C'));

  if (B2B_HABILITADO) {
    $('seg-b2b').addEventListener('click', () => elegirSegmento('B2B'));
  } else {
    // Sin B2B no hay nada que elegir: se deja B2C puesto para que el analista no
    // tenga que marcar la unica opcion que existe. El boton de B2B queda
    // deshabilitado en el HTML; aca solo se refuerza por si el flag cambia.
    $('seg-b2b').disabled = true;
    elegirSegmento('B2C');
  }

  $('id-cliente').addEventListener('input', () => {
    // Al cambiar de cliente se limpia TODO lo del anterior: el informe y también los
    // archivos cargados. Dejarlos era peligroso: son los documentos de otra persona y
    // se habrían analizado contra el ID nuevo sin que nada lo advirtiera.
    if (estado.informe) limpiarResultado();
    limpiarArchivos();
    actualizarBoton();
  });

  const zona = $('zona');
  const input = $('archivos');

  zona.addEventListener('click', () => input.click());
  zona.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });

  input.addEventListener('change', () => {
    agregarArchivos(input.files);
    input.value = '';           // permite volver a elegir el mismo archivo
  });

  for (const evt of ['dragenter', 'dragover']) {
    zona.addEventListener(evt, (e) => { e.preventDefault(); zona.classList.add('zona--activa'); });
  }
  for (const evt of ['dragleave', 'drop']) {
    zona.addEventListener(evt, (e) => { e.preventDefault(); zona.classList.remove('zona--activa'); });
  }
  zona.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) agregarArchivos(e.dataTransfer.files);
  });

  $('boton-limpiar-archivos').addEventListener('click', limpiarArchivos);

  $('boton-analizar').addEventListener('click', analizar);
  $('boton-salir').addEventListener('click', salir);
  $('boton-reintentar-conexion').addEventListener('click', () => sondearConexion());
  $('boton-reiniciar-sesion').addEventListener('click', () => location.reload());

  $('boton-pdf').addEventListener('click', () => descargarPdf($('boton-pdf')));
  $('boton-cerrar-resultado').addEventListener('click', cerrarModalResultado);
  $('boton-reabrir-resultado').addEventListener('click', abrirModalResultado);

  // Escape cierra el modal del resultado, tenga informe o el mensaje de "no
  // encontrado": los dos casos son el mismo modal.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('modal-resultado').classList.contains('oculto')) {
      cerrarModalResultado();
    }
  });

  // Actividad real del usuario -> reinicia la ventana de inactividad. `mousemove` y
  // `scroll` cuentan aunque no se llegue a hacer click en nada: alguien que esta
  // leyendo o moviendo el mouse sobre la pagina esta presente, no inactivo.
  for (const evt of ['click', 'keydown', 'input', 'pointerdown', 'mousemove', 'scroll']) {
    document.addEventListener(evt, registrarActividad, { passive: true });
  }
}

async function iniciar() {
  capturarErroresGoogle();
  conectarEventos();

  // 1. URL del backend. Cadena vacia = mismo origen: es lo que devuelve el propio
  // backend cuando sirve el frontend en local, y evita tener que configurar nada.
  try {
    const cfg = await fetch('config.json', { cache: 'no-store' }).then((r) => r.json());
    estado.backend = (cfg.backend || '').replace(/\/+$/, '');
  } catch {
    mensaje('login-error', 'No se pudo leer config.json (falta la URL del backend).');
    return;
  }

  // En GitHub Pages el mismo origen no puede ser el backend: seria la propia pagina
  // estatica. Si config.json quedo sin URL, se avisa en vez de fallar de forma opaca.
  if (!estado.backend && location.hostname.endsWith('github.io')) {
    mensaje('login-error',
      'config.json no define la URL del backend. Arranca el backend para que publique '
      + 'la URL del tunel, o edita config.json a mano.');
    return;
  }

  // 2. Estado de autenticacion + datos para el boton de Google.
  let cfgAuth;
  try {
    cfgAuth = await api('/auth/status');
  } catch (e) {
    mensaje('login-error', 'El backend no responde (' + e.message + ').');
    return;
  }

  estado.cfgAuth = cfgAuth;
  estado.idleSeg = cfgAuth.idle_seconds || 600;

  if (cfgAuth.authenticated) {
    estado.usuario = cfgAuth.user;
    entrarALaApp();
    return;
  }

  // Sesion invalida o inexistente: se descarta el token viejo y se pide login.
  guardarToken('');

  if (cfgAuth.auth_enabled && !cfgAuth.ready) {
    mensaje('login-error',
      'El backend no tiene configurada la autenticacion (faltan GOOGLE_CLIENT_ID y/o SESSION_SECRET).');
    return;
  }

  dibujarBotonGoogle(cfgAuth);
}

iniciar();
