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
    PermissionFlagsBits
} = require('discord.js');

const DATA_DIR = '/app/data';
const DB_FILE = path.join(DATA_DIR, 'compras_v2.json');
const CSV_FILE = path.join(__dirname, 'historial.csv');

// ====== IDs de roles ======
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

// ====== GANADORES ======
function contarGanador(ganadores, jugador) {
    for (const g of ganadores) {
        const match = g.match(/^(.+?)(?:\s+x(\d+))?$/);
        if (match && match[1].trim().toLowerCase() === jugador.toLowerCase()) {
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
function convertirFecha(fecha) {
    if (!fecha) return null;
    if (fecha.toLowerCase() === 'hoy') return new Date().toISOString().split('T')[0];
    const partes = fecha.split('/');
    if (partes.length !== 3) return null;
    const [dia, mes, anio] = partes;
    const anioCompleto = anio.length === 2 ? '20' + anio : anio;
    return `${anioCompleto}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
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

// Pesos: PESOS[categoriaEvaluada][categoriaCompra] = peso
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

function calcularPrioridad(jugador, categoria, compras) {
    const pesosCategoria = PESOS[categoria] || {};
    let impacto = 0;
    let unidades7d = 0;
    let historico = 0;
    const desglose = {};

    for (const c of compras) {
        const n = contarGanador(c.ganadores, jugador);
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
        historico += contarGanador(c.ganadores, jugador);
    }

    const historicoTotal = {};
    for (const cat of CATEGORIAS) historicoTotal[cat] = 0;
    for (const c of compras) {
        const n = contarGanador(c.ganadores, jugador);
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

        const commandsData = [
            new SlashCommandBuilder()
                .setName('sub')
                .setDescription('Registrar compra de hoy')
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
                .addStringOption(o => o.setName('categoria').setDescription('Categoría').setRequired(true).addChoices(...catChoices))
                .addStringOption(o => o.setName('objeto').setDescription('Nombre del ítem').setRequired(true))
                .addIntegerOption(o => o.setName('cantidad').setDescription('Cantidad').setRequired(true))
                .addStringOption(o => o.setName('ganadores').setDescription('Ganadores separados por coma').setRequired(true))
                .addStringOption(o => o.setName('perdedores').setDescription('Perdedores separados por coma').setRequired(false)),

            new SlashCommandBuilder()
                .setName('subf')
                .setDescription('Registrar compra con fecha específica')
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
                .addStringOption(o => o.setName('fecha').setDescription('DD/MM/YY o "hoy"').setRequired(true))
                .addStringOption(o => o.setName('categoria').setDescription('Categoría').setRequired(true).addChoices(...catChoices))
                .addStringOption(o => o.setName('objeto').setDescription('Nombre del ítem').setRequired(true))
                .addIntegerOption(o => o.setName('cantidad').setDescription('Cantidad').setRequired(true))
                .addStringOption(o => o.setName('ganadores').setDescription('Ganadores separados por coma').setRequired(true))
                .addStringOption(o => o.setName('perdedores').setDescription('Perdedores separados por coma').setRequired(false)),

            new SlashCommandBuilder()
                .setName('historial')
                .setDescription('Historial de compras de uno o varios jugadores')
                .addStringOption(o => o.setName('jugadores').setDescription('Nombres separados por coma').setRequired(true))
                .addStringOption(o => o.setName('categoria').setDescription('Filtrar por categoría').setRequired(false).addChoices(...catChoicesTodo))
                .addStringOption(o => o.setName('formato').setDescription('Tipo de salida').setRequired(false)
                    .addChoices({ name: 'Resumen', value: 'Resumen' }, { name: 'Detallado', value: 'Detallado' })),

            new SlashCommandBuilder()
                .setName('historial2')
                .setDescription('Últimas 5 compras de un jugador (público)')
                .addStringOption(o => o.setName('jugador').setDescription('Nombre del jugador').setRequired(true))
                .addStringOption(o => o.setName('categoria').setDescription('Filtrar por categoría').setRequired(false).addChoices(...catChoicesTodo)),

            new SlashCommandBuilder()
                .setName('total')
                .setDescription('Totales por categoría de un jugador')
                .addStringOption(o => o.setName('jugador').setDescription('Nombre del jugador').setRequired(true)),

            new SlashCommandBuilder()
                .setName('ranking')
                .setDescription('Tabla general de todos los jugadores'),

            new SlashCommandBuilder()
                .setName('prioridad')
                .setDescription('Calcular prioridad para una categoría')
                .addStringOption(o => o.setName('categoria').setDescription('Categoría a evaluar').setRequired(true).addChoices(...catChoices))
                .addStringOption(o => o.setName('jugadores').setDescription('Nombres separados por coma').setRequired(true)),

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
    if (!interaction.isChatInputCommand()) return;
    const db = cargarDB();

    // Chequeo de permisos para comandos restringidos
    const comandosLider = ['borrar'];
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
        // ---------- /sub y /subf ----------
        if (interaction.commandName === 'sub' || interaction.commandName === 'subf') {
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
                fecha = new Date().toISOString().split('T')[0];
            }

            const ganadores = ganadoresStr.split(',').map(s => s.trim()).filter(Boolean);
            const perdedores = perdedoresStr.split(',').map(s => s.trim()).filter(Boolean);

            const entrada = {
                id: db.nextId++,
                fecha,
                evento: interaction.commandName === 'subf' ? 'Manual' : 'Hoy',
                categoria, objeto, cantidad, ganadores, perdedores,
                notas: ''
            };
            db.compras.push(entrada);
            guardarDB(db);

            return interaction.reply({
                content: `✅ #${entrada.id} · 📅 ${formatearFecha(fecha)}\n📦 ${cantidad}x ${objeto} (${categoria})\n🏆 ${ganadores.join(', ') || 'nadie'}${perdedores.length ? `\n💔 Perdieron: ${perdedores.join(', ')}` : ''}`
            });
        }

        // ---------- /historial ----------
        if (interaction.commandName === 'historial') {
            const jugadores = interaction.options.getString('jugadores').split(',').map(s => s.trim()).filter(Boolean);
            const categoria = interaction.options.getString('categoria') || 'Todas';
            const formato = interaction.options.getString('formato') || 'Resumen';
            const esDetallado = formato === 'Detallado';

            if (!esDetallado) {
                let out = '📜 **Historial rápido**\n\n';
                for (const j of jugadores) {
                    const comprasJ = db.compras.filter(c => contarGanador(c.ganadores, j) > 0);
                    const porCat = {};
                    let totalUnidades = 0;
                    for (const c of comprasJ) {
                        const n = contarGanador(c.ganadores, j);
                        totalUnidades += n;
                        porCat[c.categoria] = (porCat[c.categoria] || 0) + n;
                    }
                    const desglose = CATEGORIAS.map(cat => porCat[cat] ? `${porCat[cat]} ${cat}` : null).filter(Boolean).join(', ');
                    out += `**${j}**: ${totalUnidades} unidades${desglose ? ` | ${desglose}` : ''}\n`;
                }
                return interaction.reply({ content: out });
            }

            const bloques = [];
            for (const j of jugadores) {
                let comprasJ = db.compras.filter(c => contarGanador(c.ganadores, j) > 0);
                if (categoria !== 'Todas') comprasJ = comprasJ.filter(c => c.categoria === categoria);
                comprasJ.sort((a, b) => b.fecha.localeCompare(a.fecha));

                const categoriasMostrar = categoria === 'Todas' ? CATEGORIAS : [categoria];
                let bloque = `📜 **${j}**${categoria !== 'Todas' ? ` — ${categoria}` : ''}\n`;

                for (const cat of categoriasMostrar) {
                    const filtradas = comprasJ.filter(c => c.categoria === cat).slice(0, 5);
                    if (filtradas.length === 0) continue;
                    bloque += `\n**${cat}** (últimas ${filtradas.length}):\n`;
                    for (const c of filtradas) {
                        const n = contarGanador(c.ganadores, j);
                        bloque += `#${c.id} · ${formatearFecha(c.fecha)} · ${n}x ${c.objeto}\n`;
                    }
                }
                bloques.push(bloque);
            }

            const chunks = [];
            let current = '';
            for (const b of bloques) {
                if (current.length + b.length > 1900) { chunks.push(current); current = b; }
                else { current += '\n' + b; }
            }
            if (current) chunks.push(current);

            await interaction.reply({ content: chunks[0], ephemeral: true });
            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp({ content: chunks[i], ephemeral: true });
            }
            return;
        }

        // ---------- /historial2 ----------
        if (interaction.commandName === 'historial2') {
            const jugador = interaction.options.getString('jugador');
            const categoria = interaction.options.getString('categoria') || 'Todas';
            let comprasJ = db.compras.filter(c => contarGanador(c.ganadores, jugador) > 0);
            if (categoria !== 'Todas') comprasJ = comprasJ.filter(c => c.categoria === categoria);
            comprasJ.sort((a, b) => b.fecha.localeCompare(a.fecha));

            const categoriasMostrar = categoria === 'Todas' ? CATEGORIAS : [categoria];
            let out = `📜 **${jugador}**${categoria !== 'Todas' ? ` — ${categoria}` : ''} (últimas 5)\n`;

            for (const cat of categoriasMostrar) {
                const filtradas = comprasJ.filter(c => c.categoria === cat).slice(0, 5);
                if (filtradas.length === 0) continue;
                out += `\n**${cat}**:\n`;
                for (const c of filtradas) {
                    const n = contarGanador(c.ganadores, jugador);
                    out += `#${c.id} · ${formatearFecha(c.fecha)} · ${n}x ${c.objeto}\n`;
                }
            }

            const chunks = [];
            let current = '';
            for (const linea of out.split('\n')) {
                if (current.length + linea.length + 1 > 1900) {
                    chunks.push(current);
                    current = linea;
                } else {
                    current += (current ? '\n' : '') + linea;
                }
            }
            if (current) chunks.push(current);

            await interaction.reply({ content: chunks[0] });
            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp({ content: chunks[i] });
            }
            return;
        }

        // ---------- /total ----------
        if (interaction.commandName === 'total') {
            const jugador = interaction.options.getString('jugador');
            const totales = {};
            for (const cat of CATEGORIAS) totales[cat] = 0;
            for (const c of db.compras) {
                const n = contarGanador(c.ganadores, jugador);
                if (n > 0 && totales[c.categoria] !== undefined) totales[c.categoria] += n;
            }
            const total = Object.values(totales).reduce((a, b) => a + b, 0);
            const lineas = Object.entries(totales).map(([cat, n]) => `${cat}: ${n}`).join('\n');
            return interaction.reply({
                content: `📊 **Total de ${jugador}**\n${lineas}\n────────────\n**TOTAL:** ${total}`
            });
        }

        // ---------- /ranking ----------
        if (interaction.commandName === 'ranking') {
            const ranking = {};
            for (const c of db.compras) {
                for (const g of c.ganadores) {
                    const { nombre, cantidad } = parsearGanador(g);
                    if (!ranking[nombre]) {
                        ranking[nombre] = { total: 0 };
                        for (const cat of CATEGORIAS) ranking[nombre][cat] = 0;
                    }
                    if (ranking[nombre][c.categoria] !== undefined) {
                        ranking[nombre][c.categoria] += cantidad;
                        ranking[nombre].total += cantidad;
                    }
                }
            }
            const ordenado = Object.entries(ranking).sort((a, b) => b[1].total - a[1].total).slice(0, 30);
            const lineas = ordenado.map(([jug, d], i) =>
                `${i + 1}. **${jug}** · Total: ${d.total} | 20k: ${d['Cajas 20k']} | Únicos: ${d['Emblemas Únicos']} | Equipo: ${d['Equipo']} | Acc: ${d['Accesorios']}`
            ).join('\n');
            return interaction.reply({ content: `🏆 **Ranking general**\n${lineas}` });
        }

        // ---------- /prioridad ----------
        if (interaction.commandName === 'prioridad') {
            const categoria = interaction.options.getString('categoria');
            const jugadores = interaction.options.getString('jugadores').split(',').map(s => s.trim()).filter(Boolean);

            const resultados = jugadores.map(j => ({
                jugador: j,
                ...calcularPrioridad(j, categoria, db.compras)
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

                out += `**${i + 1}. ${r.jugador}**\n`;
                out += `   Impacto reciente: ${r.impacto.toFixed(2)}\n`;
                out += `   Unidades 7d: ${r.unidades7d}${desgloseStr}\n`;
                out += `   Histórico en categoría: ${r.historico}\n`;
                out += `   ${histTotalStr}\n`;
            });
            out += `\n**Recomendación:** ${resultados[0].jugador}`;

            const chunks = [];
            let current = '';
            for (const linea of out.split('\n')) {
                if (current.length + linea.length + 1 > 1900) {
                    chunks.push(current);
                    current = linea;
                } else {
                    current += (current ? '\n' : '') + linea;
                }
            }
            if (current) chunks.push(current);

            await interaction.reply({ content: chunks[0] });
            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp({ content: chunks[i] });
            }
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
                content: `**Comandos:**\n\`/sub\` · registrar compra de hoy\n\`/subf\` · registrar con fecha\n\`/historial\` · historial (soporta varios jugadores)\n\`/historial2\` · últimas 5 de un jugador (público)\n\`/total\` · totales por categoría\n\`/ranking\` · tabla general\n\`/prioridad\` · calcular prioridad\n\`/borrar\` · borrar por ID\n\`/ayuda\` · este mensaje`,
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
