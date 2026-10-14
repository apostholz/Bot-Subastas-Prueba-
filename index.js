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
    SlashCommandBuilder
} = require('discord.js');

const DATA_DIR = '/app/data';
const DB_FILE = path.join(DATA_DIR, 'compras.json');
const CSV_FILE = path.join(DATA_DIR, 'historial.csv');

// Asegurar que la carpeta existe
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// --- Base de datos ---
function cargarDB() {
    if (fs.existsSync(DB_FILE)) {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
    return { compras: [], nextId: 1 };
}

function guardarDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function leerCSVInicial() {
    if (!fs.existsSync(CSV_FILE)) return;
    if (fs.existsSync(DB_FILE)) return; // ya fue cargado antes

    console.log('Cargando CSV inicial...');
    const contenido = fs.readFileSync(CSV_FILE, 'utf8');
    const filas = parse(contenido, {
        columns: true,
        skip_empty_lines: true,
        trim: true
    });

    const db = { compras: [], nextId: 1 };
    for (const fila of filas) {
        const ganadores = fila.ganadores
            ? fila.ganadores.split(',').map(s => s.trim()).filter(Boolean)
            : [];
        const perdedores = fila.perdedores
            ? fila.perdedores.split(',').map(s => s.trim()).filter(Boolean)
            : [];

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

// --- Fechas ---
function convertirFecha(fecha) {
    if (!fecha) return null;
    if (fecha.toLowerCase() === 'hoy') {
        return new Date().toISOString().split('T')[0];
    }
    // DD/MM/YY -> YYYY-MM-DD
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
    if (!iso) return '?';
    const diff = Date.now() - new Date(iso).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// --- Lógica de categorías ---
const CATEGORIAS = [
    'Cajas 20k',
    'Caja 10k',
    'Emblemas Generales',
    'Emblemas Únicos',
    'Emblemas Azules',
    'Equipo',
    'Accesorios'
];

// --- Cliente ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

client.once(Events.ClientReady, async (c) => {
    console.log(`Bot listo como ${c.user.tag}`);
    leerCSVInicial();

    // Registrar comandos automáticamente
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        const commandsData = [
            new SlashCommandBuilder()
                .setName('sub')
                .setDescription('Registrar compra de hoy')
                .addStringOption(o => o.setName('categoria').setDescription('Categoría').setRequired(true)
                    .addChoices(...CATEGORIAS.map(c => ({ name: c, value: c }))))
                .addStringOption(o => o.setName('objeto').setDescription('Nombre del ítem').setRequired(true))
                .addIntegerOption(o => o.setName('cantidad').setDescription('Cantidad').setRequired(true))
                .addStringOption(o => o.setName('ganadores').setDescription('Ganadores separados por coma').setRequired(true))
                .addStringOption(o => o.setName('perdedores').setDescription('Perdedores separados por coma (opcional)').setRequired(false)),

            new SlashCommandBuilder()
                .setName('subf')
                .setDescription('Registrar compra con fecha específica')
                .addStringOption(o => o.setName('fecha').setDescription('DD/MM/YY o "hoy"').setRequired(true))
                .addStringOption(o => o.setName('categoria').setDescription('Categoría').setRequired(true)
                    .addChoices(...CATEGORIAS.map(c => ({ name: c, value: c }))))
                .addStringOption(o => o.setName('objeto').setDescription('Nombre del ítem').setRequired(true))
                .addIntegerOption(o => o.setName('cantidad').setDescription('Cantidad').setRequired(true))
                .addStringOption(o => o.setName('ganadores').setDescription('Ganadores separados por coma').setRequired(true))
                .addStringOption(o => o.setName('perdedores').setDescription('Perdedores separados por coma (opcional)').setRequired(false)),

            new SlashCommandBuilder()
                .setName('historial')
                .setDescription('Ver últimas 10 compras de un jugador')
                .addStringOption(o => o.setName('jugador').setDescription('Nombre del jugador').setRequired(true)),

            new SlashCommandBuilder()
                .setName('total')
                .setDescription('Totales por categoría de un jugador')
                .addStringOption(o => o.setName('jugador').setDescription('Nombre del jugador').setRequired(true)),

            new SlashCommandBuilder()
                .setName('ranking')
                .setDescription('Tabla general de todos los jugadores'),

            new SlashCommandBuilder()
                .setName('borrar')
                .setDescription('Borrar una entrada por ID')
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

// --- Manejo de comandos ---
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const db = cargarDB();

    try {
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
                if (!fecha) {
                    return interaction.reply({ content: '❌ Formato de fecha inválido. Usa DD/MM/YY o "hoy".', ephemeral: true });
                }
            } else {
                fecha = new Date().toISOString().split('T')[0];
            }

            const ganadores = ganadoresStr.split(',').map(s => s.trim()).filter(Boolean);
            const perdedores = perdedoresStr.split(',').map(s => s.trim()).filter(Boolean);

            const entrada = {
                id: db.nextId++,
                fecha,
                evento: interaction.commandName === 'subf' ? 'Manual' : 'Hoy',
                categoria,
                objeto,
                cantidad,
                ganadores,
                perdedores,
                notas: ''
            };

            db.compras.push(entrada);
            guardarDB(db);

            return interaction.reply({
                content: `✅ Registrado #${entrada.id}\n📅 ${formatearFecha(fecha)}\n📦 ${cantidad}x ${objeto} (${categoria})\n🏆 ${ganadores.join(', ') || 'nadie'}${perdedores.length ? `\n💔 Perdieron: ${perdedores.join(', ')}` : ''}`,
                ephemeral: false
            });
        }

        if (interaction.commandName === 'historial') {
            const jugador = interaction.options.getString('jugador');
            const filtradas = db.compras
                .filter(c => c.ganadores.includes(jugador))
                .sort((a, b) => b.fecha.localeCompare(a.fecha))
                .slice(0, 10);

            if (filtradas.length === 0) {
                return interaction.reply({ content: `No hay compras registradas para **${jugador}**.`, ephemeral: true });
            }

            const lineas = filtradas.map(c =>
                `#${c.id} · ${formatearFecha(c.fecha)} · ${c.cantidad}x ${c.objeto} (${c.categoria})`
            ).join('\n');

            return interaction.reply({ content: `📜 **Últimas compras de ${jugador}:**\n${lineas}`, ephemeral: false });
        }

        if (interaction.commandName === 'total') {
            const jugador = interaction.options.getString('jugador');
            const totales = {};
            for (const cat of CATEGORIAS) totales[cat] = 0;

            for (const c of db.compras) {
                if (c.ganadores.includes(jugador)) {
                    if (totales[c.categoria] !== undefined) {
                        totales[c.categoria] += c.cantidad;
                    }
                }
            }

            const total = Object.values(totales).reduce((a, b) => a + b, 0);
            const lineas = Object.entries(totales)
                .map(([cat, n]) => `${cat}: ${n}`)
                .join('\n');

            return interaction.reply({
                content: `📊 **Total de ${jugador}**\n${lineas}\n────────────\n**TOTAL:** ${total}`,
                ephemeral: false
            });
        }

        if (interaction.commandName === 'ranking') {
            const ranking = {};
            for (const c of db.compras) {
                for (const g of c.ganadores) {
                    if (!ranking[g]) {
                        ranking[g] = { total: 0 };
                        for (const cat of CATEGORIAS) ranking[g][cat] = 0;
                    }
                    if (ranking[g][c.categoria] !== undefined) {
                        ranking[g][c.categoria] += c.cantidad;
                        ranking[g].total += c.cantidad;
                    }
                }
            }

            const ordenado = Object.entries(ranking)
                .sort((a, b) => b[1].total - a[1].total)
                .slice(0, 30);

            const lineas = ordenado.map(([jug, d], i) =>
                `${i + 1}. **${jug}** · Total: ${d.total} | 20k: ${d['Cajas 20k']} | Únicos: ${d['Emblemas Únicos']} | Equipo: ${d['Equipo']} | Acc: ${d['Accesorios']}`
            ).join('\n');

            return interaction.reply({ content: `🏆 **Ranking general**\n${lineas}`, ephemeral: false });
        }

        if (interaction.commandName === 'borrar') {
            const id = interaction.options.getInteger('id');
            const idx = db.compras.findIndex(c => c.id === id);
            if (idx === -1) {
                return interaction.reply({ content: `❌ No existe entrada con ID #${id}.`, ephemeral: true });
            }
            const eliminada = db.compras.splice(idx, 1)[0];
            guardarDB(db);
            return interaction.reply({ content: `🗑️ Borrada #${id}: ${eliminada.cantidad}x ${eliminada.objeto}`, ephemeral: false });
        }

        if (interaction.commandName === 'ayuda') {
            return interaction.reply({
                content: `**Comandos disponibles:**\n\`/sub\` — registrar compra de hoy\n\`/subf\` — registrar con fecha\n\`/historial\` — últimas 10 compras de un jugador\n\`/total\` — totales por categoría\n\`/ranking\` — tabla general\n\`/borrar\` — borrar entrada por ID\n\`/ayuda\` — este mensaje`,
                ephemeral: true
            });
        }
    } catch (err) {
        console.error(err);
        if (!interaction.replied) {
            interaction.reply({ content: '❌ Ocurrió un error. Revisa los logs.', ephemeral: true });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
