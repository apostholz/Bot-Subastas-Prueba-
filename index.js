require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const {
    Client,
    GatewayIntentBits,
    Events,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const DATA_DIR = '/app/data';
const DB_FILE = path.join(DATA_DIR, 'compras_v2.json');
const MIEMBROS_FILE = path.join(DATA_DIR, 'miembros.json');
const BACKUP_FILE = path.join(DATA_DIR, 'backup.csv');
const CSV_FILE = path.join(__dirname, 'historial.csv');

const ROL_LIDER = '1547712440593031249';
const ROL_HELPER = '1560311703118545007';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ====== PENDIENTES (registro rápido) ======
const pendingRegistros = new Map();
function guardarPendiente(datos) {
    const id = Math.random().toString(36).slice(2, 10);
    pendingRegistros.set(id, { ...datos, expira: Date.now() + 5 * 60 * 1000 });
    for (const [k, v] of pendingRegistros.entries()) {
        if (v.expira < Date.now()) pendingRegistros.delete(k);
    }
    return id;
}

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

// ====== NORMALIZAR ======
function normalizar(s) {
    return (s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
function normalizarNombre(s) {
    return normalizar(s);
}

// ====== CLAVE DE JUGADOR ======
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
function esExcluido(nombre, miembros) {
    if (!nombre || !miembros.excluidos) return false;
    const key = claveJugador(nombre, miembros);
    return miembros.excluidos.some(e => claveJugador(e, miembros) === key);
}

// ====== GANADORES ======
function contarGanador(ganadores, jugador, miembros) {
    const jk = claveJugador(jugador, miembros);
    for (const g of ganadores) {
        const match = g.match(/^(.+?)(?:\s+x(\d+))?$/);
        if (match && claveJugador(match[1], miembros) === jk) {
            return match[2] ? parseInt(match[2]) : 1;
        }
    }
    return 0;
}
function parsearGanador(g) {
    const match = g.match(/^(.+?)(?:\s+x(\d+))?$/);
    if (!match) return { nombre: g, cantidad: 1 };
    return { nombre: match[1].trim(), cantidad: match[2] ? parseInt(match[2]) : 1 };
}
function buscarJugadorEnLista(lista, nombre, miembros) {
    const jk = claveJugador(nombre, miembros);
    return lista.findIndex(g => {
        const match = g.match(/^(.+?)(?:\s+x(\d+))?$/);
        return match && claveJugador(match[1], miembros) === jk;
    });
}

// ====== HUELLA PARA DEDUPLICAR ======
function huella(c) {
    return [
        c.fecha || '',
        c.evento || '',
        c.categoria || '',
        c.objeto || '',
        c.cantidad || 0,
        (c.ganadores || []).join(','),
        (c.perdedores || []).join(',')
    ].join('|');
}

// ====== CSV INICIAL ======
function leerCSVInicial() {
    if (!fs.existsSync(CSV_FILE)) return;
    if (fs.existsSync(DB_FILE)) {
        const dbActual = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (dbActual.compras && dbActual.compras.length > 0) return;
    }
    console.log('Cargando CSV inicial...');
    const contenido = fs.readFileSync(CSV_FILE, 'utf8');
    const filas = parse(contenido, { columns: true, skip_empty_lines: true, trim: true });
    const db = { compras: [], nextId: 1 };
    for (const fila of filas) {
        const ganadores = fila.ganadores ? fila.ganadores.split(',').map(s => s.trim()).filter(Boolean) : [];
        const perdedores = fila.perdedores ? fila.perdedores.split(',').map(s => s.trim()).filter(Boolean) : [];
        db.compras.push({
            id: db.nextId++,
            fecha: convertirFecha(fila.fecha),
            evento: fila.evento || '',
            categoria: fila.categoria || '',
            objeto: fila.objeto || '',
            cantidad: parseInt(fila.cantidad) || 1,
            ganadores,
            perdedores,
            notas: fila.notas || ''
        });
    }
    guardarDB(db);
    console.log(`Cargadas ${db.compras.length} entradas del CSV.`);
}

// ====== FECHAS ======
function fechaArgentina(offsetDias = 0) {
    const ahora = new Date();
    const fechaStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(ahora);
    const [y, m, d] = fechaStr.split('-').map(Number);
    const fecha = new Date(Date.UTC(y, m - 1, d + offsetDias));
    return fecha.toISOString().split('T')[0];
}
function fechaHoyArgentina() {
    return fechaArgentina(0);
}
function fechaAyerArgentina() {
    return fechaArgentina(-1);
}
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
    const diff = Date.now() - new Date(iso).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
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
    const limite = periodo === '7d' ? 7 : 30;
    return compras.filter(c => diasDesde(c.fecha) < limite);
}

// ====== RESPUESTA LARGA ======
async function responderLargo(interaction, texto, ephemeral = false) {
    const chunks = [];
    let current = '';
    for (const linea of texto.split('\n')) {
        if (current.length + linea.length + 1 > 1900) {
            chunks.push(current);
            current = linea;
        } else {
            current += (current ? '\n' : '') + linea;
        }
    }
    if (current) chunks.push(current);
    if (chunks.length === 0) chunks.push(' ');

    await interaction.reply({ content: chunks[0], ephemeral });
    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i], ephemeral });
    }
}

// ====== AUTOCOMPLETADO ======
function obtenerNombresUnicos(db, miembros) {
    const map = new Map();
    const agregar = (nombreConSufijo) => {
        if (!nombreConSufijo) return;
        const match = nombreConSufijo.match(/^(.+?)(?:\s+x(\d+))?$/);
        const nombre = match ? match[1].trim() : nombreConSufijo.trim();
        if (!nombre) return;
        const key = claveJugador(nombre, miembros);
        if (!map.has(key)) map.set(key, aplicarCanonico(nombre, miembros));
    };
    for (const c of db.compras) {
        (c.ganadores || []).forEach(agregar);
        (c.perdedores || []).forEach(agregar);
    }
    for (const k of Object.keys(miembros.canonicos || {})) agregar(k);
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
}

function obtenerObjetosUnicos(db) {
    const map = new Map();
    for (const c of db.compras) {
        if (!c.objeto) continue;
        const key = normalizar(c.objeto);
        if (!map.has(key)) map.set(key, c.objeto);
    }
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
}

function sugerirNombresMultiples(valorActual, nombres) {
    const valor = valorActual || '';
    const partes = valor.split(',');
    const prefijo = partes.slice(0, -1).map(s => s.trim()).filter(Boolean);
    const ultima = (partes[partes.length - 1] || '').trim();
    const q = normalizar(ultima);
    const filtrados = nombres.filter(n => normalizar(n).includes(q)).slice(0, 25);
    return filtrados.map(n => {
        const nuevoValor = [...prefijo, n].join(', ');
        return { name: n, value: nuevoValor };
    });
}

// ====== CATEGORÍAS ======
const CATEGORIAS = [
    'Cajas 20k',
    'Caja 10k',
    'Emblemas Generales',
    'Emblemas Únicos',
    'Emblemas Azules',
    'Equipo',
    'Accesorios'
];

const CATEGORIAS_TOTAL = CATEGORIAS.filter(c => c !== 'Caja 10k' && c !== 'Emblemas Azules');

const PESOS = {
    'Emblemas Únicos': { 'Emblemas Únicos': 3 },
    'Cajas 20k': { 'Emblemas Únicos': 3, 'Cajas 20k': 2, 'Emblemas Generales': 0.3 },
    'Emblemas Generales': { 'Emblemas Únicos': 3, 'Cajas 20k': 2, 'Emblemas Generales': 1 },
    'Emblemas Azules': { 'Emblemas Únicos': 3, 'Cajas 20k': 2, 'Emblemas Generales': 1, 'Emblemas Azules': 0.5 },
    'Equipo': { 'Equipo': 1.0, 'Accesorios': 1.5, 'Emblemas Únicos': 3 },
    'Accesorios': { 'Accesorios': 1.5, 'Equipo': 0.5, 'Emblemas Únicos': 3 },
    'Caja 10k': { 'Caja 10k': 0.5 }
};

function getFactorTemporal(dias) {
    if (dias <= 0) return 1.0;
    if (dias === 1) return 0.8;
    if (dias === 2) return 0.6;
    if (dias === 3) return 0.4;
    if (dias >= 4 && dias <= 6) return 0.2;
    return 0;
}

function calcularPrioridad(jugador, categoria, compras, miembros) {
    const pesosCategoria = PESOS[categoria] || {};
    let impacto = 0;
    let unidades7d = 0;
    let historico = 0;
    const desglose = {};

    for (const c of compras) {
        const n = contarGanador(c.ganadores, jugador, miembros);
        if (n === 0) continue;
        const peso = pesosCategoria[c.categoria];
        if (peso === undefined) continue;
        const dias = diasDesde(c.fecha);
        if (c.categoria === 'Emblemas Únicos' && (categoria === 'Equipo' || categoria === 'Accesorios')) {
            if (dias > 2) continue;
        }
        const factor = getFactorTemporal(dias);
        impacto += n * peso * factor;
        if (dias <= 6) {
            unidades7d += n;
            desglose[c.categoria] = (desglose[c.categoria] || 0) + n;
        }
    }

    for (const c of compras) {
        if (c.categoria !== categoria) continue;
        historico += contarGanador(c.ganadores, jugador, miembros);
    }

    const historicoTotal = {};
    for (const cat of CATEGORIAS) historicoTotal[cat] = 0;
    for (const c of compras) {
        const n = contarGanador(c.ganadores, jugador, miembros);
        if (n === 0) continue;
        if (historicoTotal[c.categoria] !== undefined) historicoTotal[c.categoria] += n;
    }

    return { impacto, unidades7d, historico, desglose, historicoTotal };
}

function compararPrioridad(a, b) {
    if (Math.abs(a.impacto - b.impacto) > 0.001) return a.impacto - b.impacto;
    if (a.unidades7d !== b.unidades7d) return a.unidades7d - b.unidades7d;
    if (a.historico !== b.historico) return a.historico - b.historico;
    return 0;
}

// ====== ORDEN DE EVENTOS Y CATEGORÍAS ======
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
    const orden = esBanquete
        ? ['Equipo', 'Accesorios', 'Emblemas Únicos', 'Emblemas Generales', 'Emblemas Azules', 'Cajas 20k', 'Caja 10k']
        : ['Cajas 20k', 'Caja 10k', 'Emblemas Únicos', 'Emblemas Generales', 'Emblemas Azules', 'Equipo', 'Accesorios'];
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

// ====== CLIENTE ======
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.once(Events.ClientReady, async (c) => {
    console.log(`Bot listo como ${c.user.tag}`);
    leerCSVInicial();

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        const catChoices = CATEGORIAS.map(cat => ({ name: cat, value: cat }));
        const catChoicesTodo = [...catChoices, { name: 'Todas', value: 'Todas' }];
        const visibilidadChoices = [
            { name: 'Privado', value: 'Privado' },
            { name: 'Visible', value: 'Visible' }
        ];
        const periodoChoices = [
            { name: '7 días', value: '7d' },
            { name: '30 días', value: '30d' },
            { name: 'Total', value: 'Total' }
        ];
        const eventoChoices = [
            { name: 'Invasión diurna', value: 'Invasión diurna' },
            { name: 'Invasión nocturna', value: 'Invasión nocturna' },
            { name: 'Banquete', value: 'Banquete' }
        ];

        const commandsData = [
            new SlashCommandBuilder()
                .setName('sub')
                .setDescription('Registrar compra de hoy')
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
                .addStringOption(o => o.setName('evento').setDescription('Evento al que pertenece').setRequired(true).addChoices(...eventoChoices))
                .addStringOption(o => o.setName('categoria').setDescription('Categoría').setRequired(true).addChoices(...catChoices))
                .addStringOption(o => o.setName('objeto').setDescription('Nombre del ítem').setRequired(true).setAutocomplete(true))
                .addIntegerOption(o => o.setName('cantidad').setDescription('Cantidad').setRequired(true))
                .addStringOption(o => o.setName('ganadores').setDescription('Ganadores separados por coma').setRequired(true).setAutocomplete(true))
                .addStringOption(o => o.setName('perdedores').setDescription('Perdedores separados por coma').setRequired(false).setAutocomplete(true)),

            new SlashCommandBuilder()
                .setName('subf')
                .setDescription('Registrar compra con fecha específica')
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
                .addStringOption(o => o.setName('fecha').setDescription('DD/MM/YY o "hoy"').setRequired(true))
                .addStringOption(o => o.setName('evento').setDescription('Evento al que pertenece').setRequired(true).addChoices(...eventoChoices))
                .addStringOption(o => o.setName('categoria').setDescription('Categoría').setRequired(true).addChoices(...catChoices))
                .addStringOption(o => o.setName('objeto').setDescription('Nombre del ítem').setRequired(true).setAutocomplete(true))
                .addIntegerOption(o => o.setName('cantidad').setDescription('Cantidad').setRequired(true))
                .addStringOption(o => o.setName('ganadores').setDescription('Ganadores separados por coma').setRequired(true).setAutocomplete(true))
                .addStringOption(o => o.setName('perdedores').setDescription('Perdedores separados por coma').setRequired(false).setAutocomplete(true)),

            new SlashCommandBuilder()
                .setName('registro-rapido')
                .setDescription('Registrar varias entradas pegando texto CSV')
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
                .addStringOption(o => o.setName('texto').setDescription('Líneas CSV: fecha,evento,categoria,objeto,cantidad,ganadores,perdedores,notas').setRequired(true)),

            new SlashCommandBuilder()
                .setName('historial')
                .setDescription('Historial privado de compras de uno o varios jugadores')
                .addStringOption(o => o.setName('jugadores').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true))
                .addStringOption(o => o.setName('categoria').setDescription('Filtrar por categoría').setRequired(false).addChoices(...catChoicesTodo))
                .addStringOption(o => o.setName('formato').setDescription('Tipo de salida').setRequired(false)
                    .addChoices(
                        { name: 'Detallado', value: 'Detallado' },
                        { name: 'Recientes', value: 'Recientes' }
                    )),

            new SlashCommandBuilder()
                .setName('historial2')
                .setDescription('Historial público de compras de uno o varios jugadores')
                .addStringOption(o => o.setName('jugadores').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true))
                .addStringOption(o => o.setName('categoria').setDescription('Filtrar por categoría').setRequired(false).addChoices(...catChoicesTodo))
                .addStringOption(o => o.setName('formato').setDescription('Tipo de salida').setRequired(false)
                    .addChoices(
                        { name: 'Detallado', value: 'Detallado' },
                        { name: 'Recientes', value: 'Recientes' }
                    )),

            new SlashCommandBuilder()
                .setName('dia')
                .setDescription('Ver todas las compras de un día específico')
                .addStringOption(o => o.setName('fecha').setDescription('DD/MM/YY, "hoy" o "ayer"').setRequired(true))
                .addStringOption(o => o.setName('visibilidad').setDescription('Visibilidad del mensaje').setRequired(false).addChoices(...visibilidadChoices)),

            new SlashCommandBuilder()
                .setName('total')
                .setDescription('Totales por categoría de uno o varios jugadores')
                .addStringOption(o => o.setName('jugadores').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true))
                .addStringOption(o => o.setName('periodo').setDescription('Periodo a considerar').setRequired(false).addChoices(...periodoChoices))
                .addStringOption(o => o.setName('visibilidad').setDescription('Visibilidad del mensaje').setRequired(false).addChoices(...visibilidadChoices)),

            new SlashCommandBuilder()
                .setName('ranking')
                .setDescription('Tabla general de todos los jugadores')
                .addStringOption(o => o.setName('periodo').setDescription('Periodo a considerar').setRequired(false).addChoices(...periodoChoices))
                .addStringOption(o => o.setName('categoria').setDescription('Ordenar por categoría específica').setRequired(false).addChoices(...catChoicesTodo))
                .addStringOption(o => o.setName('visibilidad').setDescription('Visibilidad del mensaje').setRequired(false).addChoices(...visibilidadChoices)),

            new SlashCommandBuilder()
                .setName('prioridad')
                .setDescription('Calcular prioridad para una categoría')
                .addStringOption(o => o.setName('categoria').setDescription('Categoría a evaluar').setRequired(true).addChoices(...catChoices))
                .addStringOption(o => o.setName('jugadores').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true)),

            new SlashCommandBuilder()
                .setName('alertas')
                .setDescription('Jugadores que superan umbrales de acaparamiento en 7 días')
                .addStringOption(o => o.setName('visibilidad').setDescription('Visibilidad del mensaje').setRequired(false).addChoices(...visibilidadChoices)),

            new SlashCommandBuilder()
                .setName('objeto')
                .setDescription('Ver apariciones de un objeto específico')
                .addStringOption(o => o.setName('nombre').setDescription('Nombre del objeto').setRequired(true).setAutocomplete(true))
                .addStringOption(o => o.setName('periodo').setDescription('Periodo a considerar').setRequired(false).addChoices(...periodoChoices))
                .addStringOption(o => o.setName('formato').setDescription('Tipo de salida').setRequired(false)
                    .addChoices(
                        { name: 'Clasificación', value: 'Clasificación' },
                        { name: 'Lista', value: 'Lista' }
                    ))
                .addStringOption(o => o.setName('visibilidad').setDescription('Visibilidad del mensaje').setRequired(false).addChoices(...visibilidadChoices)),

            new SlashCommandBuilder()
                .setName('backup')
                .setDescription('Exportar todas las compras a un CSV ordenado por fecha')
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

            new SlashCommandBuilder()
                .setName('miembro')
                .setDescription('Gestionar nombres y exclusiones del ranking')
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
                .addSubcommand(sub => sub
                    .setName('excluir')
                    .setDescription('Excluir un nombre del ranking')
                    .addStringOption(o => o.setName('nombre').setDescription('Nombre a excluir').setRequired(true).setAutocomplete(true)))
                .addSubcommand(sub => sub
                    .setName('incluir')
                    .setDescription('Reincluir un nombre excluido')
                    .addStringOption(o => o.setName('nombre').setDescription('Nombre a reincluir').setRequired(true).setAutocomplete(true)))
                .addSubcommand(sub => sub
                    .setName('canonico')
                    .setDescription('Definir cómo se muestran uno o varios nombres (separados por coma)')
                    .addStringOption(o => o.setName('nombre').setDescription('Nombres separados por coma, ej: Zorkerk,Zorkk,zork').setRequired(true).setAutocomplete(true))
                    .addStringOption(o => o.setName('como').setDescription('Forma correcta a mostrar').setRequired(true)))
                .addSubcommand(sub => sub
                    .setName('quitar-canonico')
                    .setDescription('Eliminar la corrección de un nombre')
                    .addStringOption(o => o.setName('nombre').setDescription('Nombre con canónico definido').setRequired(true).setAutocomplete(true)))
                .addSubcommand(sub => sub
                    .setName('lista')
                    .setDescription('Listar excluidos y canónicos')),

            new SlashCommandBuilder()
                .setName('editar')
                .setDescription('Editar una entrada existente (ganadores, perdedores, nota, evento, cantidad)')
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
                .addSubcommand(sub => sub
                    .setName('agregar-ganador')
                    .setDescription('Agregar un ganador a una entrada')
                    .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))
                    .addStringOption(o => o.setName('jugador').setDescription('Nombre del jugador').setRequired(true).setAutocomplete(true)))
                .addSubcommand(sub => sub
                    .setName('quitar-ganador')
                    .setDescription('Quitar un ganador de una entrada')
                    .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))
                    .addStringOption(o => o.setName('jugador').setDescription('Nombre del jugador').setRequired(true).setAutocomplete(true)))
                .addSubcommand(sub => sub
                    .setName('agregar-perdedor')
                    .setDescription('Agregar un perdedor a una entrada')
                    .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))
                    .addStringOption(o => o.setName('jugador').setDescription('Nombre del jugador').setRequired(true).setAutocomplete(true)))
                .addSubcommand(sub => sub
                    .setName('quitar-perdedor')
                    .setDescription('Quitar un perdedor de una entrada')
                    .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))
                    .addStringOption(o => o.setName('jugador').setDescription('Nombre del jugador').setRequired(true).setAutocomplete(true)))
                .addSubcommand(sub => sub
                    .setName('set-nota')
                    .setDescription('Establecer la nota de una entrada')
                    .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))
                    .addStringOption(o => o.setName('nota').setDescription('Texto de la nota').setRequired(true)))
                .addSubcommand(sub => sub
                    .setName('borrar-nota')
                    .setDescription('Borrar la nota de una entrada')
                    .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true)))
                .addSubcommand(sub => sub
                    .setName('set-evento')
                    .setDescription('Reemplazar el evento de una entrada')
                    .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))
                    .addStringOption(o => o.setName('evento').setDescription('Evento').setRequired(true).addChoices(...eventoChoices)))
                .addSubcommand(sub => sub
                    .setName('set-cantidad')
                    .setDescription('Reemplazar la cantidad disponible de una entrada')
                    .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))
                    .addIntegerOption(o => o.setName('cantidad').setDescription('Nueva cantidad').setRequired(true))),

            new SlashCommandBuilder()
                .setName('importar')
                .setDescription('Importar entradas nuevas desde historial.csv con validación')
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

            new SlashCommandBuilder()
                .setName('borrar')
                .setDescription('Borrar una entrada por ID')
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
                .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true)),

            new SlashCommandBuilder()
                .setName('ayuda')
                .setDescription('Lista los comandos')
        ];

        await rest.put(
            Routes.applicationCommands(process.env.DISCORD_APP_ID),
            { body: commandsData.map(cmd => cmd.toJSON()) }
        );
        console.log('✅ Comandos registrados automáticamente.');
    } catch (err) {
        console.error('❌ Error registrando comandos:', err);
    }
});

// ====== COMANDOS ======
client.on(Events.InteractionCreate, async (interaction) => {
    // Autocompletado
    if (interaction.isAutocomplete()) {
        const db = cargarDB();
        const miembros = cargarMiembros();
        const focused = interaction.options.getFocused(true);
        const cmd = interaction.commandName;

        if (cmd === 'objeto' && focused.name === 'nombre') {
            const objetos = obtenerObjetosUnicos(db);
            const q = normalizar(focused.value);
            const filtrados = objetos.filter(n => normalizar(n).includes(q)).slice(0, 25);
            return interaction.respond(filtrados.map(n => ({ name: n, value: n })));
        }

        if ((cmd === 'sub' || cmd === 'subf') && focused.name === 'objeto') {
            const objetos = obtenerObjetosUnicos(db);
            const q = normalizar(focused.value);
            const filtrados = objetos.filter(n => normalizar(n).includes(q)).slice(0, 25);
            return interaction.respond(filtrados.map(n => ({ name: n, value: n })));
        }

        if (['jugadores', 'ganadores', 'perdedores'].includes(focused.name)) {
            const nombres = obtenerNombresUnicos(db, miembros);
            return interaction.respond(sugerirNombresMultiples(focused.value, nombres));
        }

        if (focused.name === 'jugador' || (cmd === 'miembro' && focused.name === 'nombre')) {
            if (cmd === 'miembro' && focused.name === 'nombre') {
                const nombres = obtenerNombresUnicos(db, miembros);
                return interaction.respond(sugerirNombresMultiples(focused.value, nombres));
            }
            const nombres = obtenerNombresUnicos(db, miembros);
            const q = normalizar(focused.value);
            const filtrados = nombres.filter(n => normalizar(n).includes(q)).slice(0, 25);
            return interaction.respond(filtrados.map(n => ({ name: n, value: n })));
        }

        return;
    }

    // Botones
    if (interaction.isButton()) {
        const customId = interaction.customId;
        if (customId.startsWith('reg_confirm_') || customId.startsWith('reg_cancel_')) {
            const esConfirm = customId.startsWith('reg_confirm_');
            const id = customId.replace('reg_confirm_', '').replace('reg_cancel_', '');
            const pendiente = pendingRegistros.get(id);
            if (!pendiente) {
                return interaction.update({ content: '❌ La sesión expiró. Volvé a ejecutar el comando.', components: [] });
            }
            if (pendiente.userId !== interaction.user.id) {
                return interaction.reply({ content: '❌ Solo quien ejecutó el comando puede usar estos botones.', ephemeral: true });
            }
            if (!esConfirm) {
                pendingRegistros.delete(id);
                return interaction.update({ content: '❌ Registro cancelado.', components: [] });
            }
            const db = cargarDB();
            const existentes = new Set(db.compras.map(huella));
            let agregadas = 0;
            let duplicados = 0;
            for (const entrada of pendiente.entradas) {
                const nueva = { id: db.nextId, ...entrada };
                const fp = huella(nueva);
                if (existentes.has(fp)) {
                    duplicados++;
                    continue;
                }
                db.compras.push(nueva);
                existentes.add(fp);
                db.nextId++;
                agregadas++;
            }
            guardarDB(db);
            pendingRegistros.delete(id);
            let msg = `✅ **${agregadas}** entradas registradas.`;
            if (duplicados > 0) msg += `\n⚠️ ${duplicados} duplicadas ignoradas.`;
            msg += `\nTotal en la base: **${db.compras.length}**.`;
            return interaction.update({ content: msg, components: [] });
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    const db = cargarDB();
    const miembros = cargarMiembros();

    const comandosLider = ['borrar', 'importar', 'editar', 'miembro', 'backup', 'registro-rapido'];
    const comandosEscritura = ['sub', 'subf'];

    if (comandosLider.includes(interaction.commandName) || comandosEscritura.includes(interaction.commandName)) {
        const esDueño = interaction.guild && interaction.guild.ownerId === interaction.user.id;
        const tieneLider = interaction.member && interaction.member.roles.cache.has(ROL_LIDER);
        const tieneHelper = interaction.member && interaction.member.roles.cache.has(ROL_HELPER);
        const esAdmin = interaction.member && interaction.member.permissions.has(PermissionFlagsBits.Administrator);

        if (comandosLider.includes(interaction.commandName)) {
            if (!esDueño && !tieneLider && !esAdmin) {
                return interaction.reply({ content: '❌ No tienes permiso para usar este comando.', ephemeral: true });
            }
        }
        if (comandosEscritura.includes(interaction.commandName)) {
            if (!esDueño && !tieneLider && !tieneHelper && !esAdmin) {
                return interaction.reply({ content: '❌ No tienes permiso para usar este comando.', ephemeral: true });
            }
        }
    }

    try {
        // ---------- /registro-rapido ----------
        if (interaction.commandName === 'registro-rapido') {
            const texto = interaction.options.getString('texto') || '';
            if (!texto.trim()) {
                return interaction.reply({ content: '❌ No hay texto para procesar.', ephemeral: true });
            }

            // Detectar si falta el header y agregarlo
            let textoConHeader = texto.trim();
            const primeraLinea = (textoConHeader.split('\n')[0] || '').toLowerCase();
            if (!primeraLinea.startsWith('fecha') && !primeraLinea.includes('fecha,evento')) {
                textoConHeader = 'fecha,evento,categoria,objeto,cantidad,ganadores,perdedores,notas\n' + textoConHeader;
            }

            let filas;
            try {
                filas = parse(textoConHeader, { columns: true, skip_empty_lines: true, trim: true });
            } catch (e) {
                return interaction.reply({ content: `❌ Error parseando CSV: ${e.message}`, ephemeral: true });
            }

            if (filas.length === 0) {
                return interaction.reply({ content: '❌ No se encontraron filas válidas. Verificá el formato.', ephemeral: true });
            }

            const validas = [];
            const errores = [];

            for (let i = 0; i < filas.length; i++) {
                const fila = filas[i];
                const fechaConv = convertirFecha(fila.fecha);
                if (!fechaConv) {
                    errores.push(`Fila ${i + 2}: fecha inválida "${fila.fecha}"`);
                    continue;
                }
                if (fila.categoria && !CATEGORIAS.includes(fila.categoria)) {
                    errores.push(`Fila ${i + 2}: categoría desconocida "${fila.categoria}"`);
                }

                const ganadores = fila.ganadores ? fila.ganadores.split(',').map(s => s.trim()).filter(Boolean) : [];
                const perdedores = fila.perdedores ? fila.perdedores.split(',').map(s => s.trim()).filter(Boolean) : [];

                validas.push({
                    fecha: fechaConv,
                    evento: fila.evento || '',
                    categoria: fila.categoria || '',
                    objeto: fila.objeto || '',
                    cantidad: parseInt(fila.cantidad) || 1,
                    ganadores,
                    perdedores,
                    notas: fila.notas || ''
                });
            }

            if (validas.length === 0) {
                let msg = '❌ Ninguna fila es válida.\n';
                if (errores.length > 0) msg += errores.slice(0, 5).join('\n');
                return interaction.reply({ content: msg, ephemeral: true });
            }

            const id = guardarPendiente({ entradas: validas, userId: interaction.user.id });

            let preview = `📋 **Preview — ${validas.length} entrada(s) a registrar**\n\n`;
            const MAX_MOSTRAR = 5;
            for (let i = 0; i < Math.min(validas.length, MAX_MOSTRAR); i++) {
                const v = validas[i];
                preview += `**${i + 1}.** ${formatearFecha(v.fecha)} · ${nombreBonitoEvento(v.evento)} · ${v.cantidad}x ${v.objeto} (${v.categoria})\n`;
                preview += `   🏆 ${v.ganadores.join(', ') || 'nadie'}\n`;
                if (v.perdedores.length > 0) preview += `   💔 ${v.perdedores.join(', ')}\n`;
                preview += `\n`;
            }
            if (validas.length > MAX_MOSTRAR) {
                preview += `... y **${validas.length - MAX_MOSTRAR}** más.\n\n`;
            }
            if (errores.length > 0) {
                preview += `⚠️ **${errores.length} fila(s) con problemas (ignoradas):**\n`;
                preview += errores.slice(0, 5).join('\n');
                if (errores.length > 5) preview += `\n... y ${errores.length - 5} más.`;
                preview += `\n\n`;
            }
            preview += `¿Confirmás el registro?`;

            if (preview.length > 1900) {
                preview = preview.slice(0, 1890) + '...';
            }

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`reg_confirm_${id}`)
                    .setLabel('Confirmar')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`reg_cancel_${id}`)
                    .setLabel('Cancelar')
                    .setStyle(ButtonStyle.Danger)
            );

            return interaction.reply({ content: preview, components: [row], ephemeral: true });
        }

        // ---------- /backup ----------
        if (interaction.commandName === 'backup') {
            const comprasOrdenadas = [...db.compras].sort((a, b) => {
                if (!a.fecha) return 1;
                if (!b.fecha) return -1;
                return a.fecha.localeCompare(b.fecha);
            });

            const lineas = ['fecha,evento,categoria,objeto,cantidad,ganadores,perdedores,notas'];
            for (const c of comprasOrdenadas) {
                const esc = (s) => `"${(s || '').replace(/"/g, '""')}"`;
                lineas.push([
                    formatearFecha(c.fecha),
                    c.evento || '',
                    c.categoria || '',
                    esc(c.objeto || ''),
                    c.cantidad || 1,
                    esc((c.ganadores || []).join(',')),
                    esc((c.perdedores || []).join(',')),
                    esc(c.notas || '')
                ].join(','));
            }
            const contenido = lineas.join('\n');
            fs.writeFileSync(BACKUP_FILE, contenido);
            const adjunto = new AttachmentBuilder(Buffer.from(contenido, 'utf8'), { name: 'backup.csv' });
            return interaction.reply({
                content: `✅ Respaldo guardado en \`${BACKUP_FILE}\` ordenado por fecha.\nTotal de entradas: **${db.compras.length}**.`,
                files: [adjunto]
            });
        }

        // ---------- /objeto ----------
        if (interaction.commandName === 'objeto') {
            const nombreBuscado = interaction.options.getString('nombre').trim();
            const periodo = interaction.options.getString('periodo') || '7d';
            const formato = interaction.options.getString('formato') || 'Clasificación';
            const visibilidad = interaction.options.getString('visibilidad') || 'Privado';

            if (visibilidad === 'Visible' && (periodo === '30d' || periodo === 'Total')) {
                return interaction.reply({
                    content: '❌ Con periodo 30d o Total solo se permite Privado. Cambiá la visibilidad o usá 7d.',
                    ephemeral: true
                });
            }
            const ephemeral = visibilidad === 'Privado';

            const keyBuscado = normalizar(nombreBuscado);
            const comprasFiltradas = filtrarPorPeriodo(db.compras, periodo);
            const apariciones = comprasFiltradas
                .filter(c => c.objeto && normalizar(c.objeto) === keyBuscado && (c.ganadores || []).length > 0)
                .sort((a, b) => b.fecha.localeCompare(a.fecha));

            if (apariciones.length === 0) {
                return interaction.reply({ content: `❌ No hay apariciones compradas de **${nombreBuscado}** en el periodo ${periodo}.`, ephemeral });
            }

            const nombreDisplay = apariciones[0].objeto;

            if (formato === 'Clasificación') {
                const conteos = {};
                let totalUnidades = 0;
                for (const c of apariciones) {
                    for (const g of c.ganadores) {
                        const { nombre, cantidad } = parsearGanador(g);
                        const key = claveJugador(nombre, miembros);
                        if (!conteos[key]) conteos[key] = { nombre: aplicarCanonico(nombre, miembros), total: 0 };
                        conteos[key].total += cantidad;
                        totalUnidades += cantidad;
                    }
                }
                const ordenado = Object.values(conteos).sort((a, b) => b.total - a.total);
                let out = `📦 **${nombreDisplay}** — Clasificación (${periodo})\n`;
                out += `Apariciones: ${apariciones.length} · Unidades ganadas: ${totalUnidades}\n\n`;
                ordenado.forEach((d, i) => {
                    out += `${i + 1}. **${d.nombre}** · ${d.total}\n`;
                });
                await responderLargo(interaction, out, ephemeral);
                return;
            }

            let out = `📦 **${nombreDisplay}** — Lista (${periodo})\nApariciones: ${apariciones.length}\n`;
            for (const c of apariciones) {
                out += `\n#${c.id} · ${formatearFecha(c.fecha)} ${etiquetaDias(c.fecha)} · ${nombreBonitoEvento(c.evento)} · ${c.cantidad}x (${c.categoria})\n`;
                out += `   🏆 ${c.ganadores.map(g => aplicarCanonico(g, miembros)).join(', ')}\n`;
                if (c.perdedores && c.perdedores.length > 0) {
                    out += `   💔 ${c.perdedores.map(g => aplicarCanonico(g, miembros)).join(', ')}\n`;
                }
            }
            await responderLargo(interaction, out, ephemeral);
            return;
        }

        // ---------- /alertas ----------
        if (interaction.commandName === 'alertas') {
            const visibilidad = interaction.options.getString('visibilidad') || 'Privado';
            const ephemeral = visibilidad === 'Privado';

            const recientes = filtrarPorPeriodo(db.compras, '7d');
            const conteos = {};

            for (const c of recientes) {
                for (const g of c.ganadores) {
                    const { nombre, cantidad } = parsearGanador(g);
                    if (esExcluido(nombre, miembros)) continue;
                    const key = claveJugador(nombre, miembros);
                    if (!conteos[key]) {
                        conteos[key] = { nombre: aplicarCanonico(nombre, miembros) };
                        for (const cat of CATEGORIAS) conteos[key][cat] = 0;
                    }
                    if (conteos[key][c.categoria] !== undefined) {
                        conteos[key][c.categoria] += cantidad;
                    }
                }
            }

            const UMBRALES = {
                'Emblemas Únicos': 3,
                'Emblemas Generales': 5,
                'Cajas 20k': 4,
                'Accesorios': 3,
                'Equipo': 3
            };

            let out = `🚨 **Alertas de acaparamiento (últimos 7 días)**\n`;
            let total = 0;
            for (const [cat, umbral] of Object.entries(UMBRALES)) {
                const superan = Object.values(conteos)
                    .filter(v => (v[cat] || 0) >= umbral)
                    .sort((a, b) => b[cat] - a[cat]);
                if (superan.length === 0) continue;
                total += superan.length;
                out += `\n**${cat}** (umbral ${umbral}):\n`;
                for (const v of superan) {
                    out += `   ${v.nombre}: ${v[cat]}\n`;
                }
            }
            if (total === 0) {
                out += `\n✅ Nadie supera los umbrales en los últimos 7 días.`;
            }

            await responderLargo(interaction, out, ephemeral);
            return;
        }

        // ---------- /miembro ----------
        if (interaction.commandName === 'miembro') {
            const sub = interaction.options.getSubcommand();

            if (sub === 'lista') {
                const ex = miembros.excluidos.length ? miembros.excluidos.join(', ') : '(ninguno)';
                const can = Object.entries(miembros.canonicos || {}).map(([k, v]) => `\`${k}\` → **${v}**`).join('\n') || '(ninguno)';
                return interaction.reply({
                    content: `**Excluidos del ranking:** ${ex}\n\n**Canónicos:**\n${can}`,
                    ephemeral: true
                });
            }

            const nombre = interaction.options.getString('nombre');

            if (sub === 'excluir') {
                if (esExcluido(nombre, miembros)) {
                    return interaction.reply({ content: `ℹ️ **${nombre}** ya está excluido del ranking.`, ephemeral: true });
                }
                miembros.excluidos.push(nombre);
                guardarMiembros(miembros);
                return interaction.reply({ content: `✅ **${nombre}** excluido del ranking.` });
            }
            if (sub === 'incluir') {
                const key = claveJugador(nombre, miembros);
                const idx = miembros.excluidos.findIndex(e => claveJugador(e, miembros) === key);
                if (idx === -1) {
                    return interaction.reply({ content: `ℹ️ **${nombre}** no estaba excluido.`, ephemeral: true });
                }
                miembros.excluidos.splice(idx, 1);
                guardarMiembros(miembros);
                return interaction.reply({ content: `✅ **${nombre}** reincluido en el ranking.` });
            }
            if (sub === 'canonico') {
                const como = interaction.options.getString('como');
                const nombresRaw = interaction.options.getString('nombre') || '';
                const nombres = nombresRaw.split(',').map(s => s.trim()).filter(Boolean);
                if (nombres.length === 0) {
                    return interaction.reply({ content: '❌ Debes indicar al menos un nombre.', ephemeral: true });
                }
                for (const n of nombres) {
                    miembros.canonicos[normalizarNombre(n)] = como;
                }
                guardarMiembros(miembros);
                return interaction.reply({ content: `✅ ${nombres.map(n => `**${n}**`).join(', ')} se mostrarán como **${como}**.` });
            }
            if (sub === 'quitar-canonico') {
                const key = normalizarNombre(nombre);
                if (!miembros.canonicos[key]) {
                    return interaction.reply({ content: `ℹ️ No hay canónico para **${nombre}**.`, ephemeral: true });
                }
                delete miembros.canonicos[key];
                guardarMiembros(miembros);
                return interaction.reply({ content: `✅ Canónico eliminado para **${nombre}**.` });
            }
        }

        // ---------- /editar ----------
        if (interaction.commandName === 'editar') {
            const sub = interaction.options.getSubcommand();
            const id = interaction.options.getInteger('id');
            const idx = db.compras.findIndex(c => c.id === id);
            if (idx === -1) {
                return interaction.reply({ content: `❌ No existe entrada #${id}.`, ephemeral: true });
            }
            const e = db.compras[idx];
            let mensaje = '';

            if (sub === 'agregar-ganador') {
                const jugador = interaction.options.getString('jugador').trim();
                if (buscarJugadorEnLista(e.ganadores, jugador, miembros) !== -1) {
                    return interaction.reply({ content: `ℹ️ **${jugador}** ya está en ganadores de #${id}.`, ephemeral: true });
                }
                e.ganadores.push(jugador);
                mensaje = `✅ Agregado **${jugador}** a ganadores de #${id}.`;
            }
            else if (sub === 'quitar-ganador') {
                const jugador = interaction.options.getString('jugador').trim();
                const pos = buscarJugadorEnLista(e.ganadores, jugador, miembros);
                if (pos === -1) {
                    return interaction.reply({ content: `ℹ️ **${jugador}** no está en ganadores de #${id}.`, ephemeral: true });
                }
                e.ganadores.splice(pos, 1);
                mensaje = `🗑️ Quitado **${jugador}** de ganadores de #${id}.`;
            }
            else if (sub === 'agregar-perdedor') {
                const jugador = interaction.options.getString('jugador').trim();
                if (buscarJugadorEnLista(e.perdedores, jugador, miembros) !== -1) {
                    return interaction.reply({ content: `ℹ️ **${jugador}** ya está en perdedores de #${id}.`, ephemeral: true });
                }
                e.perdedores.push(jugador);
                mensaje = `✅ Agregado **${jugador}** a perdedores de #${id}.`;
            }
            else if (sub === 'quitar-perdedor') {
                const jugador = interaction.options.getString('jugador').trim();
                const pos = buscarJugadorEnLista(e.perdedores, jugador, miembros);
                if (pos === -1) {
                    return interaction.reply({ content: `ℹ️ **${jugador}** no está en perdedores de #${id}.`, ephemeral: true });
                }
                e.perdedores.splice(pos, 1);
                mensaje = `🗑️ Quitado **${jugador}** de perdedores de #${id}.`;
            }
            else if (sub === 'set-nota') {
                const nota = interaction.options.getString('nota');
                e.notas = nota;
                mensaje = `📝 Nota actualizada en #${id}.`;
            }
            else if (sub === 'borrar-nota') {
                e.notas = '';
                mensaje = `📝 Nota borrada en #${id}.`;
            }
            else if (sub === 'set-evento') {
                const nuevoEvento = interaction.options.getString('evento');
                e.evento = nuevoEvento;
                mensaje = `📅 Evento de #${id} cambiado a **${nuevoEvento}**.`;
            }
            else if (sub === 'set-cantidad') {
                const nuevaCantidad = interaction.options.getInteger('cantidad');
                if (nuevaCantidad < 0) {
                    return interaction.reply({ content: '❌ La cantidad debe ser un número positivo.', ephemeral: true });
                }
                e.cantidad = nuevaCantidad;
                mensaje = `🔢 Cantidad de #${id} cambiada a **${nuevaCantidad}**.`;
            }
            else {
                return interaction.reply({ content: '❌ Subcomando desconocido.', ephemeral: true });
            }

            guardarDB(db);
            let respuesta = `${mensaje}\n\n`;
            respuesta += `#${e.id} · ${formatearFecha(e.fecha)} ${etiquetaDias(e.fecha)} · ${nombreBonitoEvento(e.evento)} · ${e.cantidad}x ${e.objeto} (${e.categoria})\n`;
            respuesta += `🏆 ${e.ganadores.map(g => aplicarCanonico(g, miembros)).join(', ') || 'nadie'}\n`;
            if (e.perdedores && e.perdedores.length > 0) {
                respuesta += `💔 ${e.perdedores.map(g => aplicarCanonico(g, miembros)).join(', ')}\n`;
            }
            if (e.notas) {
                respuesta += `📝 ${e.notas}`;
            }
            return interaction.reply({ content: respuesta });
        }

        // ---------- /importar ----------
        if (interaction.commandName === 'importar') {
            if (!fs.existsSync(CSV_FILE)) {
                return interaction.reply({ content: '❌ No existe historial.csv en el servidor.', ephemeral: true });
            }
            const contenido = fs.readFileSync(CSV_FILE, 'utf8');
            const filas = parse(contenido, { columns: true, skip_empty_lines: true, trim: true });

            const existentes = new Set(db.compras.map(huella));
            let agregadas = 0;
            const errores = {
                fechasInvalidas: [],
                categoriasDesconocidas: [],
                nombresSinCanonico: new Set(),
                duplicados: 0
            };

            for (let i = 0; i < filas.length; i++) {
                const fila = filas[i];
                const fechaConv = convertirFecha(fila.fecha);
                if (!fechaConv) {
                    errores.fechasInvalidas.push(`Fila ${i + 2}: "${fila.fecha}"`);
                    continue;
                }
                if (fila.categoria && !CATEGORIAS.includes(fila.categoria)) {
                    errores.categoriasDesconocidas.push(`Fila ${i + 2}: "${fila.categoria}"`);
                }

                const ganadores = fila.ganadores ? fila.ganadores.split(',').map(s => s.trim()).filter(Boolean) : [];
                const perdedores = fila.perdedores ? fila.perdedores.split(',').map(s => s.trim()).filter(Boolean) : [];

                const todos = [...ganadores, ...perdedores];
                for (const n of todos) {
                    const m = n.match(/^(.+?)(?:\s+x(\d+))?$/);
                    const soloNombre = m ? m[1].trim() : n;
                    if (!soloNombre) continue;
                    const norm = normalizarNombre(soloNombre);
                    if (!miembros.canonicos[norm]) {
                        errores.nombresSinCanonico.add(soloNombre);
                    }
                }

                const nueva = {
                    id: db.nextId,
                    fecha: fechaConv,
                    evento: fila.evento || '',
                    categoria: fila.categoria || '',
                    objeto: fila.objeto || '',
                    cantidad: parseInt(fila.cantidad) || 1,
                    ganadores,
                    perdedores,
                    notas: fila.notas || ''
                };
                const fp = huella(nueva);
                if (existentes.has(fp)) {
                    errores.duplicados++;
                    continue;
                }
                db.compras.push(nueva);
                existentes.add(fp);
                db.nextId++;
                agregadas++;
            }

            guardarDB(db);

            let reporte = `✅ Importadas **${agregadas}** entradas nuevas.\nTotal en la base: **${db.compras.length}**.\n`;
            if (errores.duplicados > 0) reporte += `\n⚠️ Duplicados ignorados: **${errores.duplicados}**.`;
            if (errores.fechasInvalidas.length > 0) {
                reporte += `\n\n❌ **Fechas inválidas** (${errores.fechasInvalidas.length}):\n${errores.fechasInvalidas.slice(0, 5).join('\n')}`;
                if (errores.fechasInvalidas.length > 5) reporte += `\n... y ${errores.fechasInvalidas.length - 5} más.`;
            }
            if (errores.categoriasDesconocidas.length > 0) {
                reporte += `\n\n⚠️ **Categorías desconocidas** (${errores.categoriasDesconocidas.length}):\n${errores.categoriasDesconocidas.slice(0, 5).join('\n')}`;
                if (errores.categoriasDesconocidas.length > 5) reporte += `\n... y ${errores.categoriasDesconocidas.length - 5} más.`;
            }
            if (errores.nombresSinCanonico.size > 0) {
                const lista = Array.from(errores.nombresSinCanonico).slice(0, 15);
                reporte += `\n\nℹ️ **Nombres sin canónico** (${errores.nombresSinCanonico.size}):\n${lista.join(', ')}`;
                if (errores.nombresSinCanonico.size > 15) reporte += `\n... y ${errores.nombresSinCanonico.size - 15} más.`;
            }

            return interaction.reply({ content: reporte, ephemeral: true });
        }

        // ---------- /sub y /subf ----------
        if (interaction.commandName === 'sub' || interaction.commandName === 'subf') {
            const evento = interaction.options.getString('evento') || '';
            const categoria = interaction.options.getString('categoria');
            const objeto = interaction.options.getString('objeto');
            const cantidad = interaction.options.getInteger('cantidad') || 1;
            const ganadoresStr = interaction.options.getString('ganadores') || '';
            const perdedoresStr = interaction.options.getString('perdedores') || '';
            let fecha;

            if (interaction.commandName === 'subf') {
                const fechaStr = interaction.options.getString('fecha');
                fecha = convertirFecha(fechaStr);
                if (!fecha) return interaction.reply({ content: '❌ Fecha inválida. Usa DD/MM/YY o "hoy".', ephemeral: true });
            } else {
                fecha = fechaHoyArgentina();
            }

            const ganadores = ganadoresStr.split(',').map(s => s.trim()).filter(Boolean);
            const perdedores = perdedoresStr.split(',').map(s => s.trim()).filter(Boolean);

            const entrada = {
                id: db.nextId++,
                fecha,
                evento,
                categoria, objeto, cantidad, ganadores, perdedores,
                notas: ''
            };
            db.compras.push(entrada);
            guardarDB(db);

            return interaction.reply({
                content: `✅ #${entrada.id} · 📅 ${formatearFecha(fecha)} · ${nombreBonitoEvento(evento)}\n📦 ${cantidad}x ${objeto} (${categoria})\n🏆 ${ganadores.map(g => aplicarCanonico(g, miembros)).join(', ') || 'nadie'}${perdedores.length ? `\n💔 Perdieron: ${perdedores.map(g => aplicarCanonico(g, miembros)).join(', ')}` : ''}`
            });
        }

        // ---------- /dia ----------
        if (interaction.commandName === 'dia') {
            const fechaStr = interaction.options.getString('fecha');
            const fecha = convertirFechaDia(fechaStr);
            const visibilidad = interaction.options.getString('visibilidad') || 'Privado';
            const ephemeral = visibilidad === 'Privado';

            if (!fecha) {
                return interaction.reply({ content: '❌ Fecha inválida. Usa DD/MM/YY, "hoy" o "ayer".', ephemeral: true });
            }

            const comprasDia = db.compras.filter(c => c.fecha === fecha);
            if (comprasDia.length === 0) {
                return interaction.reply({ content: `📅 No hay compras registradas para el ${formatearFecha(fecha)}.`, ephemeral });
            }

            const grupos = {};
            for (const c of comprasDia) {
                const ev = c.evento || 'Sin evento';
                const key = normalizar(ev);
                if (!grupos[key]) grupos[key] = { nombre: nombreBonitoEvento(ev), items: [] };
                grupos[key].items.push(c);
            }

            const eventosOrdenados = Object.keys(grupos).sort((a, b) => {
                const oa = ordenEvento(a);
                const ob = ordenEvento(b);
                if (oa !== ob) return oa - ob;
                return a.localeCompare(b);
            });

            let out = `📅 **Compras del ${formatearFecha(fecha)}**\n`;
            for (const key of eventosOrdenados) {
                const grupo = grupos[key];
                out += `\n**__${grupo.nombre}__**\n`;
                const lista = grupo.items.sort((a, b) => {
                    const oa = ordenCategoria(key, a.categoria);
                    const ob = ordenCategoria(key, b.categoria);
                    if (oa !== ob) return oa - ob;
                    return a.id - b.id;
                });
                let bloqueActual = null;
                for (const c of lista) {
                    const bloque = bloqueDeCategoria(key, c.categoria);
                    if (bloque && bloque !== bloqueActual) {
                        out += `\n**${bloque}**\n`;
                        bloqueActual = bloque;
                    }
                    out += `\n#${c.id} · ${c.cantidad}x ${c.objeto} (${c.categoria})\n`;
                    out += `   🏆 ${c.ganadores.map(g => aplicarCanonico(g, miembros)).join(', ') || 'nadie'}\n`;
                    if (c.perdedores && c.perdedores.length > 0) {
                        out += `   💔 ${c.perdedores.map(g => aplicarCanonico(g, miembros)).join(', ')}\n`;
                    }
                    if (c.notas) {
                        out += `   📝 ${c.notas}\n`;
                    }
                }
            }

            await responderLargo(interaction, out, ephemeral);
            return;
        }

        // ---------- /historial (privado) ----------
        if (interaction.commandName === 'historial') {
            const jugadores = interaction.options.getString('jugadores').split(',').map(s => s.trim()).filter(Boolean);
            const categoria = interaction.options.getString('categoria') || 'Todas';
            const formato = interaction.options.getString('formato') || 'Recientes';

            if (formato === 'Detallado' && categoria !== 'Todas') {
                return interaction.reply({ content: '❌ El formato Detallado solo está disponible cuando Categoría = Todas. Usa Recientes para una categoría específica.', ephemeral: true });
            }

            let out = '';
            if (formato === 'Recientes') {
                const bloques = [];
                for (const j of jugadores) {
                    let comprasJ = db.compras.filter(c => contarGanador(c.ganadores, j, miembros) > 0);
                    if (categoria !== 'Todas') comprasJ = comprasJ.filter(c => c.categoria === categoria);
                    comprasJ.sort((a, b) => b.fecha.localeCompare(a.fecha));
                    const ultimas = comprasJ.slice(0, 5);
                    let bloque = `📜 **${aplicarCanonico(j, miembros)}** (últimas ${ultimas.length} compras)\n`;
                    for (const c of ultimas) {
                        const n = contarGanador(c.ganadores, j, miembros);
                        bloque += `#${c.id} · ${formatearFecha(c.fecha)} ${etiquetaDias(c.fecha)} · ${n}x ${c.objeto} (${c.categoria})\n`;
                    }
                    bloques.push(bloque);
                }
                out = bloques.join('\n');
            } else {
                const bloques = [];
                for (const j of jugadores) {
                    let comprasJ = db.compras.filter(c => contarGanador(c.ganadores, j, miembros) > 0);
                    comprasJ.sort((a, b) => b.fecha.localeCompare(a.fecha));

                    let bloque = `📜 **${aplicarCanonico(j, miembros)}** (por categoría)\n`;
                    for (const cat of CATEGORIAS) {
                        const filtradas = comprasJ.filter(c => c.categoria === cat).slice(0, 5);
                        if (filtradas.length === 0) continue;
                        bloque += `\n**${cat}** (últimas ${filtradas.length}):\n`;
                        for (const c of filtradas) {
                            const n = contarGanador(c.ganadores, j, miembros);
                            bloque += `#${c.id} · ${formatearFecha(c.fecha)} ${etiquetaDias(c.fecha)} · ${n}x ${c.objeto}\n`;
                        }
                    }
                    bloques.push(bloque);
                }
                out = bloques.join('\n');
            }

            await responderLargo(interaction, out, true);
            return;
        }

        // ---------- /historial2 (público) ----------
        if (interaction.commandName === 'historial2') {
            const jugadores = interaction.options.getString('jugadores').split(',').map(s => s.trim()).filter(Boolean);
            const categoria = interaction.options.getString('categoria') || 'Todas';
            const formato = interaction.options.getString('formato') || 'Recientes';

            if (formato === 'Detallado' && categoria !== 'Todas') {
                return interaction.reply({ content: '❌ El formato Detallado solo está disponible cuando Categoría = Todas. Usa Recientes para una categoría específica.', ephemeral: false });
            }

            let out = '';
            if (formato === 'Recientes') {
                const bloques = [];
                for (const j of jugadores) {
                    let comprasJ = db.compras.filter(c => contarGanador(c.ganadores, j, miembros) > 0);
                    if (categoria !== 'Todas') comprasJ = comprasJ.filter(c => c.categoria === categoria);
                    comprasJ.sort((a, b) => b.fecha.localeCompare(a.fecha));
                    const ultimas = comprasJ.slice(0, 5);
                    let bloque = `📜 **${aplicarCanonico(j, miembros)}** (últimas ${ultimas.length} compras)\n`;
                    for (const c of ultimas) {
                        const n = contarGanador(c.ganadores, j, miembros);
                        bloque += `#${c.id} · ${formatearFecha(c.fecha)} ${etiquetaDias(c.fecha)} · ${n}x ${c.objeto} (${c.categoria})\n`;
                    }
                    bloques.push(bloque);
                }
                out = bloques.join('\n');
            } else {
                const bloques = [];
                for (const j of jugadores) {
                    let comprasJ = db.compras.filter(c => contarGanador(c.ganadores, j, miembros) > 0);
                    comprasJ.sort((a, b) => b.fecha.localeCompare(a.fecha));

                    let bloque = `📜 **${aplicarCanonico(j, miembros)}** (por categoría)\n`;
                    for (const cat of CATEGORIAS) {
                        const filtradas = comprasJ.filter(c => c.categoria === cat).slice(0, 5);
                        if (filtradas.length === 0) continue;
                        bloque += `\n**${cat}** (últimas ${filtradas.length}):\n`;
                        for (const c of filtradas) {
                            const n = contarGanador(c.ganadores, j, miembros);
                            bloque += `#${c.id} · ${formatearFecha(c.fecha)} ${etiquetaDias(c.fecha)} · ${n}x ${c.objeto}\n`;
                        }
                    }
                    bloques.push(bloque);
                }
                out = bloques.join('\n');
            }

            await responderLargo(interaction, out, false);
            return;
        }

        // ---------- /total ----------
        if (interaction.commandName === 'total') {
            const jugadores = interaction.options.getString('jugadores').split(',').map(s => s.trim()).filter(Boolean);
            const visibilidad = interaction.options.getString('visibilidad') || 'Visible';
            const periodo = interaction.options.getString('periodo') || 'Total';
            const ephemeral = visibilidad === 'Privado';

            const comprasFiltradas = filtrarPorPeriodo(db.compras, periodo);

            let out = '';
            for (const j of jugadores) {
                const totales = {};
                for (const cat of CATEGORIAS) totales[cat] = 0;
                for (const c of comprasFiltradas) {
                    const n = contarGanador(c.ganadores, j, miembros);
                    if (n > 0 && totales[c.categoria] !== undefined) totales[c.categoria] += n;
                }
                const total = Object.values(totales).reduce((a, b) => a + b, 0);
                const lineas = CATEGORIAS_TOTAL.map(cat => `${cat}: ${totales[cat] || 0}`).join('\n');
                out += `📊 **Total de ${aplicarCanonico(j, miembros)}** (${periodo})\n${lineas}\n────────────\n**TOTAL:** ${total}\n\n`;
            }
            await responderLargo(interaction, out.trimEnd(), ephemeral);
            return;
        }

        // ---------- /ranking ----------
        if (interaction.commandName === 'ranking') {
            const visibilidad = interaction.options.getString('visibilidad') || 'Privado';
            const periodo = interaction.options.getString('periodo') || '7d';
            const categoriaFiltro = interaction.options.getString('categoria') || 'Todas';

            if (visibilidad === 'Visible' && (periodo === '30d' || periodo === 'Total')) {
                return interaction.reply({
                    content: '❌ Con periodo 30d o Total solo se permite Privado. Cambiá la visibilidad o usá 7d.',
                    ephemeral: true
                });
            }
            const ephemeral = visibilidad === 'Privado';

            const comprasFiltradas = filtrarPorPeriodo(db.compras, periodo);

            const ranking = {};
            for (const c of comprasFiltradas) {
                for (const g of c.ganadores) {
                    const { nombre, cantidad } = parsearGanador(g);
                    if (esExcluido(nombre, miembros)) continue;
                    const key = claveJugador(nombre, miembros);
                    if (!ranking[key]) {
                        ranking[key] = { nombre: aplicarCanonico(nombre, miembros), total: 0 };
                        for (const cat of CATEGORIAS) ranking[key][cat] = 0;
                    }
                    if (ranking[key][c.categoria] !== undefined) {
                        ranking[key][c.categoria] += cantidad;
                        ranking[key].total += cantidad;
                    }
                }
            }

            let ordenado;
            let titulo;
            if (categoriaFiltro === 'Todas') {
                ordenado = Object.values(ranking).sort((a, b) => b.total - a.total).slice(0, 50);
                titulo = `🏆 **Ranking general** (${periodo})`;
            } else {
                ordenado = Object.values(ranking)
                    .filter(d => (d[categoriaFiltro] || 0) > 0)
                    .sort((a, b) => b[categoriaFiltro] - a[categoriaFiltro])
                    .slice(0, 50);
                titulo = `🏆 **Ranking — ${categoriaFiltro}** (${periodo})`;
            }

            const lineas = ordenado.map((d, i) => {
                if (categoriaFiltro === 'Todas') {
                    return `${i + 1}. **${d.nombre}** · ${d.total} | 20k: ${d['Cajas 20k']} | Ún: ${d['Emblemas Únicos']} | Gen: ${d['Emblemas Generales']} | Eq: ${d['Equipo']} | Acc: ${d['Accesorios']}`;
                }
                return `${i + 1}. **${d.nombre}** · ${d[categoriaFiltro]}`;
            }).join('\n');

            await responderLargo(interaction, `${titulo}\n${lineas}`, ephemeral);
            return;
        }

        // ---------- /prioridad ----------
        if (interaction.commandName === 'prioridad') {
            const categoria = interaction.options.getString('categoria');
            const jugadores = interaction.options.getString('jugadores').split(',').map(s => s.trim()).filter(Boolean);

            const resultados = jugadores.map(j => ({
                jugador: j,
                ...calcularPrioridad(j, categoria, db.compras, miembros)
            }));
            resultados.sort(compararPrioridad);

            let out = `🏆 **Prioridad — ${categoria}**\n\n`;
            resultados.forEach((r, i) => {
                let desgloseStr = '';
                if (r.unidades7d > 0) {
                    const partes = Object.entries(r.desglose)
                        .filter(([_, n]) => n > 0)
                        .map(([cat, n]) => {
                            const nombreCorto = cat.replace('Emblemas ', '').replace('Cajas 20k', '20k').replace('Caja 10k', '10k');
                            return `${nombreCorto}: ${n}`;
                        });
                    if (partes.length > 0) desgloseStr = ` (${partes.join(', ')})`;
                }

                const abreviaturas = {
                    'Cajas 20k': '20k',
                    'Caja 10k': '10k',
                    'Emblemas Generales': 'Gen',
                    'Emblemas Únicos': 'Únicos',
                    'Emblemas Azules': 'Az',
                    'Equipo': 'Eq',
                    'Accesorios': 'Acc'
                };
                const histPartes = Object.entries(r.historicoTotal)
                    .filter(([_, n]) => n > 0)
                    .map(([cat, n]) => `${abreviaturas[cat] || cat}: ${n}`);
                const histTotalStr = histPartes.length > 0 ? `Histórico total: ${histPartes.join(', ')}` : 'Histórico total: —';

                out += `**${i + 1}. ${aplicarCanonico(r.jugador, miembros)}**\n`;
                out += `   Impacto reciente: ${r.impacto.toFixed(2)}\n`;
                out += `   Unidades 7d: ${r.unidades7d}${desgloseStr}\n`;
                out += `   Histórico en categoría: ${r.historico}\n`;
                out += `   ${histTotalStr}\n`;
            });
            out += `\n**Recomendación:** ${aplicarCanonico(resultados[0].jugador, miembros)}`;

            await responderLargo(interaction, out);
            return;
        }

        // ---------- /borrar ----------
        if (interaction.commandName === 'borrar') {
            const id = interaction.options.getInteger('id');
            const idx = db.compras.findIndex(c => c.id === id);
            if (idx === -1) return interaction.reply({ content: `❌ No existe entrada #${id}.`, ephemeral: true });
            const eliminada = db.compras.splice(idx, 1)[0];
            guardarDB(db);
            return interaction.reply({ content: `🗑️ Borrada #${id}: ${eliminada.cantidad}x ${eliminada.objeto}` });
        }

        // ---------- /ayuda ----------
        if (interaction.commandName === 'ayuda') {
            return interaction.reply({
                content: `**Comandos:**\n\`/sub\` · registrar compra de hoy\n\`/subf\` · registrar con fecha\n\`/registro-rapido\` · registrar varias entradas con texto CSV\n\`/historial\` · historial privado (varios jugadores)\n\`/historial2\` · historial público (varios jugadores)\n\`/dia\` · compras de un día específico\n\`/total\` · totales por categoría (varios jugadores)\n\`/ranking\` · tabla general con filtros\n\`/prioridad\` · calcular prioridad\n\`/alertas\` · alertas de acaparamiento (7d)\n\`/objeto\` · apariciones de un objeto\n\`/backup\` · exportar CSV ordenado por fecha\n\`/miembro\` · gestionar nombres y exclusiones\n\`/editar\` · editar entrada (ganadores, perdedores, nota, evento, cantidad)\n\`/importar\` · importar filas con validación\n\`/borrar\` · borrar por ID\n\`/ayuda\` · este mensaje`,
                ephemeral: true
            });
        }
    } catch (err) {
        console.error(err);
        if (!interaction.replied) {
            interaction.reply({ content: '❌ Error. Revisa los logs.', ephemeral: true });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
