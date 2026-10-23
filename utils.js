const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'compras_v2.json');
const MIEMBROS_FILE = path.join(DATA_DIR, 'miembros.json');
const CATALOGO_FILE = path.join(DATA_DIR, 'catalogo.json');
const CSV_FILE = path.join(__dirname, 'historial.csv');
const BACKUP_FILE = path.join(DATA_DIR, 'backup.csv');

const ROL_LIDER = '1547712440593031249';
const ROL_HELPER = '1560311703118545007';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ====== DB ======
function cargarDB() {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { compras: [], nextId: 1 };
}
function guardarDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ====== MIEMBROS ======
function cargarMiembros() {
    if (fs.existsSync(MIEMBROS_FILE)) {
        try {
            const m = JSON.parse(fs.readFileSync(MIEMBROS_FILE, 'utf8'));
            if (!m.excluidos) m.excluidos = [];
            if (!m.canonicos) m.canonicos = {};
            return m;
        } catch (e) { /* ignorar */ }
    }
    return { excluidos: [], canonicos: {} };
}
function guardarMiembros(m) {
    fs.writeFileSync(MIEMBROS_FILE, JSON.stringify(m, null, 2));
}

// ====== CATALOGO ======
function cargarCatalogo() {
    if (fs.existsSync(CATALOGO_FILE)) {
        try { return JSON.parse(fs.readFileSync(CATALOGO_FILE, 'utf8')); }
        catch { return {}; }
    }
    return {};
}
function guardarCatalogo(c) {
    fs.writeFileSync(CATALOGO_FILE, JSON.stringify(c, null, 2));
}

// ====== NORMALIZAR Y CANÓNICOS ======
function normalizar(s) {
    return (s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
function normalizarNombre(s) { return normalizar(s); }

function claveJugador(nombre, miembros) {
    if (!nombre) return '';
    const norm = normalizarNombre(nombre);
    if (miembros && miembros.canonicos && miembros.canonicos[norm]) {
        return normalizarNombre(miembros.canonicos[norm]);
    }
    return norm;
}
function aplicarCanonico(nombre, miembros) {
    if (!nombre) return nombre;
    const key = claveJugador(nombre, miembros);
    for (const v of Object.values(miembros.canonicos || {})) {
        if (normalizarNombre(v) === key) return v;
    }
    const direct = miembros.canonicos && miembros.canonicos[normalizarNombre(nombre)];
    if (direct) return direct;
    return nombre;
}
function formatearNombreConCantidad(g, miembros) {
    if (!g) return g;
    const match = g.match(/^(.+?)(?:\s+[xX](\d+))?$/);
    if (!match) return aplicarCanonico(g, miembros);
    const base = match[1].trim();
    const cantidad = match[2];
    const nombreCanonico = aplicarCanonico(base, miembros);
    return cantidad ? `${nombreCanonico} x${cantidad}` : nombreCanonico;
}
function esExcluido(nombre, miembros) {
    if (!nombre || !miembros.excluidos) return false;
    const key = claveJugador(nombre, miembros);
    return miembros.excluidos.some(e => claveJugador(e, miembros) === key);
}

// ====== GANADORES ======
function contarGanador(ganadores, jugador, miembros) {
    const jk = claveJugador(jugador, miembros);
    for (const g of ganadores) {
        const match = g.match(/^(.+?)(?:\s+[xX](\d+))?$/);
        if (match && claveJugador(match[1], miembros) === jk) {
            return match[2] ? parseInt(match[2]) : 1;
        }
    }
    return 0;
}
function parsearGanador(g) {
    const match = g.match(/^(.+?)(?:\s+[xX](\d+))?$/);
    if (!match) return { nombre: g, cantidad: 1 };
    return { nombre: match[1].trim(), cantidad: match[2] ? parseInt(match[2]) : 1 };
}
function buscarJugadorEnLista(lista, nombre, miembros) {
    const jk = claveJugador(nombre, miembros);
    return lista.findIndex(g => {
        const match = g.match(/^(.+?)(?:\s+[xX](\d+))?$/);
        return match && claveJugador(match[1], miembros) === jk;
    });
}

// ====== FECHAS ======
function fechaArgentina(offsetDias = 0) {
    const ahora = new Date();
    const fechaStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(ahora);
    const [y, m, d] = fechaStr.split('-').map(Number);
    const fecha = new Date(Date.UTC(y, m - 1, d + offsetDias));
    return fecha.toISOString().split('T')[0];
}
function fechaHoyArgentina() { return fechaArgentina(0); }
function fechaAyerArgentina() { return fechaArgentina(-1); }
function convertirFecha(fecha) {
    if (!fecha) return null;
    if (fecha.toLowerCase() === 'hoy') return fechaHoyArgentina();
    const partes = fecha.split('/');
    if (partes.length !== 3) return null;
    const [dia, mes, anio] = partes;
    const anioCompleto = anio.length === 2 ? '20' + anio : anio;
    return `${anioCompleto}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
}
function convertirFechaDia(fecha) {
    if (!fecha) return null;
    const f = fecha.toLowerCase().trim();
    if (f === 'hoy') return fechaHoyArgentina();
    if (f === 'ayer') return fechaAyerArgentina();
    return convertirFecha(fecha);
}
function formatearFecha(iso) {
    if (!iso) return '?';
    const [anio, mes, dia] = iso.split('-');
    return `${dia}/${mes}/${anio.slice(2)}`;
}
function diasDesde(iso) {
    if (!iso) return 999;
    const hoy = fechaHoyArgentina();
    const d1 = new Date(hoy + 'T00:00:00Z');
    const d2 = new Date(iso + 'T00:00:00Z');
    return Math.floor((d1 - d2) / (1000 * 60 * 60 * 24));
}
function etiquetaDias(iso) {
    const d = diasDesde(iso);
    if (d === 999) return '(?)';
    if (d <= 0) return '(hoy)';
    if (d === 1) return '(ayer)';
    return `(${d} días)`;
}
function filtrarPorPeriodo(compras, periodo) {
    if (periodo === 'Total') return compras;
    return compras.filter(c => diasDesde(c.fecha) < 7);
}

// ====== CATEGORÍAS Y EVENTOS ======
const CATEGORIAS = ['Cajas 20k', 'Emblemas Generales', 'Emblemas Únicos', 'Equipo', 'Accesorios'];
const CATEGORIAS_TOTAL = CATEGORIAS;
const ABREVIATURAS = { 'Cajas 20k': '20k', 'Emblemas Generales': 'Gen', 'Emblemas Únicos': 'Únicos', 'Equipo': 'Eq', 'Accesorios': 'Acc' };
const OBJETOS_PROHIBIDOS = ['Combatiente', 'Arquero gnoll'];

const PESOS = {
    'Emblemas Únicos': { 'Emblemas Únicos': 3, 'Cajas 20k': 0.3, 'Emblemas Generales': 0.1 },
    'Cajas 20k': { 'Emblemas Únicos': 3, 'Cajas 20k': 2, 'Emblemas Generales': 0.4 },
    'Emblemas Generales': { 'Emblemas Únicos': 3, 'Cajas 20k': 2, 'Emblemas Generales': 1 },
    'Equipo': { 'Equipo': 1.0, 'Accesorios': 1.5, 'Emblemas Únicos': 1.5 },
    'Accesorios': { 'Accesorios': 1.5, 'Equipo': 0.5, 'Emblemas Únicos': 1.5 }
};

function getFactorTemporal(dias) {
    if (dias <= 0) return 1.0;
    if (dias === 1) return 0.8;
    if (dias === 2) return 0.6;
    if (dias === 3) return 0.4;
    if (dias >= 4 && dias <= 6) return 0.2;
    return 0;
}

const ORDEN_EVENTOS = ['invasion diurna', 'invasion nocturna', 'banquete'];
function nombreBonitoEvento(evento) {
    const n = normalizar(evento);
    if (!evento || n === 'manual' || n === 'hoy') return 'Sin evento';
    if (n.includes('diurna')) return 'Invasión diurna';
    if (n.includes('nocturna')) return 'Invasión nocturna';
    if (n.includes('banquete')) return 'Banquete';
    return evento;
}
function ordenEvento(evento) {
    const idx = ORDEN_EVENTOS.indexOf(normalizar(evento));
    return idx === -1 ? 999 : idx;
}
function ordenCategoria(evento, categoria) {
    const esBanquete = normalizar(evento).includes('banquete');
    const orden = esBanquete ? ['Equipo', 'Accesorios', 'Emblemas Únicos', 'Emblemas Generales'] : ['Cajas 20k', 'Emblemas Únicos', 'Emblemas Generales', 'Equipo', 'Accesorios'];
    const idx = orden.indexOf(categoria);
    return idx === -1 ? 999 : idx;
}
function bloqueDeCategoria(evento, categoria) {
    const esBanquete = normalizar(evento).includes('banquete');
    if (!esBanquete) return null;
    if (categoria === 'Equipo') return 'Equipo';
    if (categoria === 'Accesorios') return 'Accesorios';
    if ((categoria || '').startsWith('Emblemas')) return 'Emblemas';
    return null;
}

// ====== ORDEN CRONOLÓGICO DESCENDENTE ======
function ordenarComprasDesc(a, b) {
    const f = (b.fecha || '').localeCompare(a.fecha || '');
    if (f !== 0) return f;
    const ea = ordenEvento(a.evento);
    const eb = ordenEvento(b.evento);
    if (ea !== eb) return eb - ea;
    return (b.id || 0) - (a.id || 0);
}

module.exports = {
    cargarDB, guardarDB, cargarMiembros, guardarMiembros, cargarCatalogo, guardarCatalogo,
    normalizar, normalizarNombre, claveJugador, aplicarCanonico, formatearNombreConCantidad, esExcluido,
    contarGanador, parsearGanador, buscarJugadorEnLista,
    fechaHoyArgentina, convertirFecha, convertirFechaDia, formatearFecha, diasDesde, etiquetaDias, filtrarPorPeriodo,
    CATEGORIAS, CATEGORIAS_TOTAL, ABREVIATURAS, OBJETOS_PROHIBIDOS, PESOS, getFactorTemporal,
    nombreBonitoEvento, ordenEvento, ordenCategoria, bloqueDeCategoria, ordenarComprasDesc,
    ROL_LIDER, ROL_HELPER, CSV_FILE, BACKUP_FILE, DATA_DIR
};
