/* ==========================================================================
 * Compass — frontend
 *
 * Vive en GitHub Pages (origen distinto al backend), por lo que la sesion NO
 * puede viajar en cookies de terceros: el backend devuelve un token de sesion
 * firmado y aqui se envia en la cabecera `Authorization: Bearer`.
 *
 * La URL del backend se lee de config.json para poder cambiarla sin recompilar
 * (el backend corre en la maquina del analista y se expone por tunel).
 * ========================================================================== */

'use strict';

const CLAVE_SESION = 'compass_sesion';
const CABECERA_SESION = 'X-Session-Token';
const SONDEO_VPN_MS = 20000;    // cada cuanto se consulta el estado de VPN/BD
const REVISION_IDLE_MS = 5000;  // cada cuanto se comprueba la inactividad
// Cada cuanto se le avisa al BACKEND que hubo actividad, si la hubo. Bastante menor
// que idleSeg (600s de por defecto) para que siempre llegue con margen de sobra.
const RENOVACION_SESION_MS = 60000;

const estado = {
  backend: '',
  token: sessionStorage.getItem(CLAVE_SESION) || '',
  usuario: null,
  idleSeg: 600,
  ultimaActividad: 0,
  ultimaRenovacion: 0,
  segmento: null,
  archivos: [],
  vpnOk: false,
  enviando: false,
  nonceRenovado: false,
  informe: null,
  nombrePdf: '',
  // Los `id` de los bloques que el analista dejo marcados para el PDF. Los pone el
  // backend (ver `core/informe.py: filtrar`); aca solo se recuerda cuales estan
  // tildados y se manda la lista al pedir el PDF.
  incluirEnPdf: new Set(),
};

let timerSesion = null;
let timerVpn = null;

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
 * Marca actividad REAL del usuario. No la disparan el sondeo de VPN ni los
 * temporizadores: la ventana de inactividad tiene que reflejar que hay alguien
 * trabajando, no que la pestana esta abierta.
 */
function registrarActividad() {
  estado.ultimaActividad = Date.now();
}

function cerrarPorInactividad() {
  clearInterval(timerSesion);
  clearInterval(timerVpn);
  guardarToken('');
  estado.usuario = null;
  mostrar($('pantalla-app'), false);
  mostrar($('pantalla-login'), false);
  mostrar($('modal-sesion'), true);
}

async function salir() {
  clearInterval(timerSesion);
  clearInterval(timerVpn);
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
 * Estado de VPN / base de datos
 * -------------------------------------------------------------------------- */

function pintarEstadoVpn(clase, txt) {
  const el = $('estado-vpn');
  el.className = 'estado ' + clase;
  texto('estado-vpn-texto', txt);
}

async function sondearVpn({ mostrarModal = true } = {}) {
  pintarEstadoVpn('estado--cargando', 'Verificando VPN');
  try {
    // /salud es publica: sondearla no renueva la ventana de inactividad.
    const s = await api('/salud');
    estado.vpnOk = Boolean(s.vpn_ok && s.db_ok);

    if (estado.vpnOk) {
      pintarEstadoVpn('estado--ok', 'VPN conectada');
      mostrar($('modal-vpn'), false);
    } else {
      pintarEstadoVpn('estado--mal', 'VPN desconectada');
      $('modal-vpn-detalle').textContent =
        (s.destino ? 'Destino ' + s.destino + '. ' : '') + (s.detalle_bd || '');
      if (mostrarModal) mostrar($('modal-vpn'), true);
    }
  } catch (e) {
    estado.vpnOk = false;
    pintarEstadoVpn('estado--mal', 'Backend inalcanzable');
    $('modal-vpn-detalle').textContent = e.message;
    if (mostrarModal) mostrar($('modal-vpn'), true);
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

function pintarArchivos() {
  const ul = $('lista-archivos');
  ul.innerHTML = '';

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
  const listo = Boolean(estado.segmento) && Boolean(idCliente) && estado.vpnOk && !estado.enviando;
  $('boton-analizar').disabled = !listo;

  const resumen = $('resumen');
  resumen.textContent = '';

  if (estado.enviando) {
    resumen.textContent = 'Ejecutando analisis...';
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
  if (!estado.vpnOk) {
    resumen.textContent = 'Conecta la VPN para poder consultar la base de datos.';
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
  const caja = $('resultado');
  caja.textContent = '';
  mostrar(caja, false);
  estado.informe = null;
  // Los ids del analisis anterior ya no existen: si quedaran, el PDF del siguiente
  // cliente pediria bloques de este.
  estado.incluirEnPdf.clear();
}

function _identidad(enc) {
  const caja = crear('div', 'identidad');

  // Bandera circular del país de origen. Si no hay archivo para ese código (o el
  // país viene vacío), se cae a las iniciales.
  if (enc.pais_codigo) {
    const bandera = document.createElement('img');
    bandera.className = 'identidad-bandera';
    bandera.src = 'banderas/' + enc.pais_codigo + '.svg';
    bandera.alt = enc.pais || enc.pais_codigo;
    bandera.title = enc.pais || '';
    bandera.width = 62;
    bandera.height = 62;
    bandera.addEventListener('error', () => {
      bandera.replaceWith(crear('div', 'identidad-avatar', enc.iniciales));
    });
    caja.append(bandera);
  } else {
    caja.append(crear('div', 'identidad-avatar', enc.iniciales));
  }

  const textos = crear('div', 'identidad-textos');
  textos.append(crear('div', 'identidad-nombre', enc.nombre));
  if (enc.subtitulo) textos.append(crear('div', 'identidad-sub', enc.subtitulo));

  const id = crear('div', 'identidad-id');
  id.append('ID DE CLIENTE', crear('b', null, enc.id));
  textos.append(id);

  caja.append(textos);
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
  casilla.setAttribute('aria-label', 'Incluir "' + titulo + '" en el PDF');
  casilla.addEventListener('change', () => {
    if (casilla.checked) estado.incluirEnPdf.add(id);
    else estado.incluirEnPdf.delete(id);
  });
  etiqueta.append(casilla);
  etiqueta.append(crear('span', 'incluir-texto', 'PDF'));
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
  if (extraido.vigencia) {
    caja.append(crear('div', 'form-vigencia form-vigencia--' + extraido.vigencia.estado,
      extraido.vigencia.texto));
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
 */
function _contraste(contraste) {
  const caja = crear('div', 'form-validacion form-validacion--' + contraste.estado);
  caja.append(crear('span', 'form-validacion-txt', contraste.texto));

  for (const d of contraste.discrepancias || []) {
    const linea = crear('div', 'form-validacion-dif');
    linea.append(crear('b', null, d.campo), ': el documento dice ');
    linea.append(crear('b', null, `"${d.documento}"`), ' y la base ');
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
  if (r.identidades) recuento.push(`${r.identidades} documento(s) de identidad`);
  recuento.push(`${r.a_revision || 0} a revisión`);
  enc.append(crear('span', 'docs-resumen', recuento.join(' · ')));
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

  for (const archivo of analisis.archivos || []) {
    const tarjeta = crear('article', 'doc');

    const cabecera = crear('div', 'doc-archivo');
    cabecera.append(crear('span', 'doc-archivo-icono', extension(archivo.archivo || '')));
    cabecera.append(crear('span', null, archivo.archivo || '—'));
    if (archivo.id) cabecera.append(_incluir(archivo.id, archivo.archivo || 'documento'));
    tarjeta.append(cabecera);

    for (const c of archivo.clasificaciones || []) {
      const bloque = crear('div',
        'doc-clasificacion' + (c.revision ? ' doc-clasificacion--revision' : ''));

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

      tarjeta.append(bloque);
    }


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

function _barraDescarga(informe, nombrePdf) {
  const caja = crear('div', 'descarga');

  const texto = crear('div', 'descarga-texto');
  const comp = informe.completitud;
  texto.append('Informe listo');
  if (comp) texto.append(` · ${comp.con_dato} de ${comp.total} campos con dato`);
  texto.append(' · archivo ');
  texto.append(crear('strong', null, nombrePdf));
  caja.append(texto);

  const boton = crear('button', 'btn btn--sec', 'Descargar PDF');
  boton.type = 'button';
  boton.id = 'boton-pdf';
  boton.addEventListener('click', () => descargarPdf(boton));
  caja.append(boton);

  return caja;
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
  caja.append(crear('h2', 'resultado-titulo', 'Información del cliente'));

  if (!informe.encontrado) {
    caja.append(_sinDatos(informe));
    mostrar(caja, true);
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

  caja.append(_barraDescarga(informe, estado.nombrePdf));

  // A proposito NO se hace scroll: el resultado aparece abajo y el analista baja
  // cuando quiere, sin que la pagina se le mueva sola.
  mostrar(caja, true);
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

async function analizar() {
  limpiarMensajes();
  limpiarResultado();

  // La VPN se revalida justo antes de ejecutar: pudo caerse desde el ultimo sondeo.
  await sondearVpn();
  if (!estado.vpnOk) return;

  estado.enviando = true;
  actualizarBoton();

  const cuerpo = new FormData();
  cuerpo.append('segmento', estado.segmento);
  cuerpo.append('id_cliente', $('id-cliente').value.trim());
  for (const f of estado.archivos) cuerpo.append('documentos', f, f.name);

  try {
    pintarResultado(await api('/analizar', { method: 'POST', body: cuerpo }));
  } catch (e) {
    mensaje('app-error', e.message);
  } finally {
    estado.enviando = false;
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
  sondearVpn();
  clearInterval(timerVpn);
  timerVpn = setInterval(() => sondearVpn({ mostrarModal: false }), SONDEO_VPN_MS);
}

function conectarEventos() {
  $('seg-b2c').addEventListener('click', () => elegirSegmento('B2C'));
  $('seg-b2b').addEventListener('click', () => elegirSegmento('B2B'));

  $('id-cliente').addEventListener('input', () => {
    if (estado.informe) limpiarResultado();
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

  $('boton-analizar').addEventListener('click', analizar);
  $('boton-salir').addEventListener('click', salir);
  $('boton-reintentar-vpn').addEventListener('click', () => sondearVpn());
  $('boton-reiniciar-sesion').addEventListener('click', () => location.reload());

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
