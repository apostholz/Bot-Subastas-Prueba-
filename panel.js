const fs = require('fs');
const path = require('path');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder,
    SlashCommandBuilder
} = require('discord.js');

const DATA_DIR = '/app/data';
const SUBASTAS_FILE = path.join(DATA_DIR, 'subastas_activas.json');
const ARCHIVADAS_FILE = path.join(DATA_DIR, 'subastas_archivadas.json');
const INDICE_FILE = path.join(DATA_DIR, 'indice.json');

const CATEGORIAS_PANEL = ['Cajas 20k', 'Emblemas Generales', 'Emblemas Únicos', 'Equipo', 'Accesorios'];
const EVENTOS_PANEL = ['Invasión diurna', 'Invasión nocturna', 'Banquete'];

const pendingPanel = new Map();

function cargarJSON(file, def) {
    if (!fs.existsSync(file)) return def;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return def; }
}
function guardarJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function cargarSubastas() { return cargarJSON(SUBASTAS_FILE, {}); }
function guardarSubastas(d) { guardarJSON(SUBASTAS_FILE, d); }
function cargarArchivadas() { return cargarJSON(ARCHIVADAS_FILE, {}); }
function guardarArchivadas(d) { guardarJSON(ARCHIVADAS_FILE, d); }
function cargarIndice() { return cargarJSON(INDICE_FILE, { channelId: null, messageId: null }); }
function guardarIndice(d) { guardarJSON(INDICE_FILE, d); }
function generarId() { return Math.random().toString(36).slice(2, 10); }

function normalizarLocal(s) {
    return (s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function claveJugadorLocal(nombre, miembros) {
    if (!nombre) return '';
    const norm = normalizarLocal(nombre);
    if (miembros && miembros.canonicos && miembros.canonicos[norm]) {
        return normalizarLocal(miembros.canonicos[norm]);
    }
    return norm;
}

function incluyeInteresado(session, nombre, miembros) {
    const key = claveJugadorLocal(nombre, miembros);
    return session.interesados.some(i => claveJugadorLocal(i, miembros) === key);
}

function esLider(member, funciones) {
    if (!member) return false;
    if (member.id === member.guild.ownerId) return true;
    if (member.permissions && member.permissions.has('Administrator')) return true;
    return member.roles.cache.has(funciones.ROL_LIDER) || member.roles.cache.has(funciones.ROL_HELPER);
}

function obtenerEventoPorHora() {
    const ahora = new Date();
    const horaStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
        hour: '2-digit',
        hour12: false
    }).format(ahora);
    const hora = parseInt(horaStr, 10);
    if (hora >= 5 && hora < 18) return 'Invasión diurna';
    if (hora >= 18 && hora <= 21) return 'Invasión nocturna';
    return 'Banquete';
}

function inferirCategoria(objeto, db) {
    const key = normalizarLocal(objeto);
    const map = {
        'lagarto de trueno vil': 'Emblemas Únicos',
        'idolo de obsidiana vil': 'Emblemas Únicos',
        'tiranosaurio vil': 'Emblemas Únicos',
        'hidra vil': 'Emblemas Únicos',
        'elemental de trueno': 'Emblemas Generales',
        'gigante de lava': 'Emblemas Generales',
        'espiritu del viento': 'Emblemas Generales',
        'gigante bioquimico': 'Emblemas Generales',
        'combatiente': 'Emblemas Generales',
        'luchador hombre pez': 'Emblemas Generales',
        'arquero gnoll': 'Emblemas Generales',
        'mago': 'Emblemas Generales'
    };
    if (map[key]) return map[key];
    if (key.includes('caja 20k')) return 'Cajas 20k';
    if (key.includes('collar') || key.includes('anillo') || key.includes('marca') || key.includes('brazal')) return 'Accesorios';
    if (db && Array.isArray(db.compras)) {
        const compras = db.compras.filter(c => c.objeto && normalizarLocal(c.objeto) === key);
        if (compras.length > 0) {
            const conteo = {};
            for (const c of compras) {
                conteo[c.categoria] = (conteo[c.categoria] || 0) + 1;
            }
            const orden = Object.entries(conteo).sort((a, b) => b[1] - a[1]);
            if (orden.length > 0) return orden[0][0];
        }
    }
    return 'Equipo';
}

function guardarPendientePanel(tipo, payload, userId) {
    const id = Math.random().toString(36).slice(2, 10);
    pendingPanel.set(id, { tipo, payload, userId, expira: Date.now() + 10 * 60 * 1000 });
    for (const [k, v] of pendingPanel.entries()) {
        if (v.expira < Date.now()) pendingPanel.delete(k);
    }
    return id;
}

function pushHistorial(session, interaction, accion) {
    session.historial.push({
        timestamp: Date.now(),
        userId: interaction.user.id,
        userName: interaction.member?.displayName || interaction.user.username,
        accion
    });
    if (session.historial.length > 50) session.historial = session.historial.slice(-50);
}

function renderPanel(session, funciones) {
    const item = session.item;
    const miembros = funciones.cargarMiembros();
    const interesados = session.interesados.map(i => funciones.aplicarCanonico(i, miembros));

    const embed = new EmbedBuilder()
        .setTitle(`📦 ${item.objeto}`)
        .setDescription(
            `**Evento:** ${item.evento}\n` +
            `**Categoría:** ${item.categoria}\n` +
            `**Cantidad:** ${item.cantidad}\n` +
            `**Fecha:** ${item.fecha}`
        )
        .addFields({
            name: `Interesados (${interesados.length})`,
            value: interesados.length ? interesados.map(i => `• ${i}`).join('\n') : 'Nadie aún'
        });

    if (interesados.length > item.cantidad) {
        embed.setColor(0xFF0000);
        embed.setFooter({ text: `⚠️ Hay ${interesados.length} interesados para ${item.cantidad} unidades` });
    } else {
        embed.setColor(0x00FF00);
    }

    const ultimo = session.historial[session.historial.length - 1];
    if (ultimo) {
        embed.setFooter({
            text: `Última modificación: ${ultimo.userName} - ${new Date(ultimo.timestamp).toLocaleTimeString('es-AR')}`
        });
    }

    const cerrada = session.estado !== 'abierta';

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel_btn:anotarme:${session.id}`).setLabel('Anotarme').setStyle(ButtonStyle.Success).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:retirarme:${session.id}`).setLabel('Retirarme').setStyle(ButtonStyle.Danger).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:prioridad:${session.id}`).setLabel('Calcular prioridad').setStyle(ButtonStyle.Primary).setDisabled(cerrada)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel_btn:editar:${session.id}`).setLabel('Editar').setStyle(ButtonStyle.Secondary).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:historial:${session.id}`).setLabel('Ver historial').setStyle(ButtonStyle.Secondary).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:registrar:${session.id}`).setLabel('Registrar resultado').setStyle(ButtonStyle.Primary).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:cancelar:${session.id}`).setLabel('Cancelar subasta').setStyle(ButtonStyle.Secondary).setDisabled(cerrada)
    );

    return { embeds: [embed], components: [row1, row2] };
}

async function actualizarMensajePanel(client, session, funciones) {
    if (!session.messageId || !session.channelId) return;
    try {
        const canal = await client.channels.fetch(session.channelId);
        const msg = await canal.messages.fetch(session.messageId);
        const { embeds, components } = renderPanel(session, funciones);
        await msg.edit({ embeds, components });
    } catch (e) {
        console.error('Error actualizando panel:', e.message);
    }
}

async function actualizarIndice(client, funciones) {
    const indice = cargarIndice();
    if (!indice.channelId) return;
    try {
        const canal = await client.channels.fetch(indice.channelId);
        let msg = null;
        if (indice.messageId) {
            try { msg = await canal.messages.fetch(indice.messageId); } catch { msg = null; }
        }

        const subastas = cargarSubastas();
        const activas = Object.values(subastas).filter(s => s.estado === 'abierta');

        let desc = 'No hay subastas activas.';
        if (activas.length > 0) {
            desc = 'Referencia: (interesados / unidades)\n\n';
            desc += activas.map(s => `• <#${s.threadId}> — ${s.item.objeto} (${s.interesados.length} / ${s.item.cantidad})`).join('\n');
        }

        const embed = new EmbedBuilder()
            .setTitle('📌 Índice de subastas activas')
            .setDescription(desc)
            .setColor(0x5865F2);

        if (msg) {
            await msg.edit({ embeds: [embed] });
        } else {
            const nuevo = await canal.send({ embeds: [embed] });
            guardarIndice({ channelId: canal.id, messageId: nuevo.id });
        }
    } catch (e) {
        console.error('Error actualizando índice:', e.message);
    }
}

async function mostrarConfirmacionAgregar(interaction, session, nombresRaw, funciones) {
    const miembros = funciones.cargarMiembros();
    const partes = nombresRaw.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    const nuevos = [];
    const yaEstaban = [];
    const vistos = new Set();

    for (const p of partes) {
        const canon = funciones.aplicarCanonico(p, miembros);
        const key = claveJugadorLocal(canon, miembros);
        if (vistos.has(key)) continue;
        vistos.add(key);
        if (incluyeInteresado(session, canon, miembros)) {
            yaEstaban.push(canon);
        } else {
            nuevos.push(canon);
        }
    }

    if (nuevos.length === 0) {
        return interaction.reply({
            content: `ℹ️ Todos ya estaban anotados: ${yaEstaban.join(', ')}`,
            ephemeral: true
        });
    }

    const id = guardarPendientePanel('agregar_interesados', {
        sessionId: session.id,
        nuevos,
        yaEstaban
    }, interaction.user.id);

    let txt = `📋 **Confirmar agregar interesados**\n\n`;
    txt += `**Se agregarán:** ${nuevos.map(n => `**${n}**`).join(', ')}\n`;
    if (yaEstaban.length > 0) txt += `**Ya estaban:** ${yaEstaban.join(', ')}\n`;
    txt += `\n¿Confirmás?`;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Confirmar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Cancelar').setStyle(ButtonStyle.Danger)
    );

    return interaction.reply({ content: txt, components: [row], ephemeral: true });
}

const comandosPanel = [
    new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Gestionar panel de subasta')
        .addSubcommand(sub => sub
            .setName('crear')
            .setDescription('Crear panel en el thread actual (categoría automática)')
            .addStringOption(o => o.setName('objeto').setDescription('Nombre del objeto').setRequired(true).setAutocomplete(true))
            .addIntegerOption(o => o.setName('cantidad').setDescription('Cantidad').setRequired(true))
            .addStringOption(o => o.setName('evento').setDescription('Evento (opcional)').setRequired(false)
                .addChoices(...EVENTOS_PANEL.map(e => ({ name: e, value: e })))))
        .addSubcommand(sub => sub
            .setName('ver')
            .setDescription('Mostrar el panel activo de este thread'))
        .addSubcommand(sub => sub
            .setName('objeto')
            .setDescription('Cambiar el objeto del panel activo')
            .addStringOption(o => o.setName('nombre').setDescription('Nuevo nombre del objeto').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub
            .setName('interesado')
            .setDescription('Añadir o quitar interesado')
            .addStringOption(o => o.setName('jugador').setDescription('Nombre del jugador').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('accion').setDescription('Añadir o Quitar').setRequired(false)
                .addChoices(
                    { name: 'Añadir', value: 'añadir' },
                    { name: 'Quitar', value: 'quitar' }
                )))
        .addSubcommand(sub => sub
            .setName('cancelar')
            .setDescription('Cancelar la subasta activa de este thread (solo líder/helper)'))
        .addSubcommand(sub => sub
            .setName('indice')
            .setDescription('Crear/actualizar índice privado en este canal (solo líder/helper)'))
];

function setupPanel(client, funciones) {
    client.on('interactionCreate', async (interaction) => {
        // Autocompletado de /panel
        if (interaction.isAutocomplete() && interaction.commandName === 'panel') {
            const focused = interaction.options.getFocused(true);
            const db = funciones.cargarDB();
            const miembros = funciones.cargarMiembros();

            if (focused.name === 'objeto' || focused.name === 'nombre') {
                const objetos = funciones.obtenerObjetosUnicos(db);
                const q = funciones.normalizar(focused.value);
                const filtrados = objetos.filter(n => funciones.normalizar(n).includes(q)).slice(0, 25);
                return interaction.respond(filtrados.map(n => ({ name: n, value: n })));
            }

            if (focused.name === 'jugador') {
                const nombres = funciones.obtenerNombresUnicos(db, miembros);
                const q = funciones.normalizar(focused.value);
                const filtrados = nombres.filter(n => funciones.normalizar(n).includes(q)).slice(0, 25);
                return interaction.respond(filtrados.map(n => ({ name: n, value: n })));
            }
            return;
        }

        // Comando /panel
        if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
            const sub = interaction.options.getSubcommand();
            const subastas = cargarSubastas();
            const esLiderUsuario = esLider(interaction.member, funciones);

            if (sub === 'crear') {
                await interaction.deferReply();
                if (!interaction.channel.isThread()) {
                    return interaction.editReply({ content: '❌ Este comando solo funciona dentro de un thread.' });
                }
                const threadId = interaction.channelId;
                const existente = Object.values(subastas).find(s => s.threadId === threadId && s.estado === 'abierta');
                if (existente) {
                    return interaction.editReply({ content: '❌ Ya hay un panel activo en este thread. Cancelalo o registralo antes de crear otro.' });
                }

                const db = funciones.cargarDB();
                const objeto = interaction.options.getString('objeto');
                const categoria = inferirCategoria(objeto, db);
                const cantidad = interaction.options.getInteger('cantidad');
                const evento = interaction.options.getString('evento') || obtenerEventoPorHora();
                const fecha = funciones.fechaHoyArgentina();

                const session = {
                    id: generarId(),
                    threadId,
                    channelId: interaction.channelId,
                    messageId: null,
                    item: { fecha, evento, categoria, objeto, cantidad },
                    interesados: [],
                    estado: 'abierta',
                    historial: [],
                    creadoPor: interaction.user.id,
                    createdAt: Date.now()
                };
                pushHistorial(session, interaction, 'Panel creado');
                subastas[session.id] = session;
                guardarSubastas(subastas);

                const { embeds, components } = renderPanel(session, funciones);
                const msg = await interaction.editReply({ embeds, components });
                session.messageId = msg.id;
                guardarSubastas(subastas);

                await actualizarIndice(client, funciones);
                return;
            }

            if (sub === 'indice') {
                if (!esLiderUsuario) {
                    return interaction.reply({ content: '❌ Solo líderes/helpers pueden crear o actualizar el índice.', ephemeral: true });
                }
                await interaction.deferReply({ ephemeral: true });
                const indice = cargarIndice();
                let canal = interaction.channel;
                let msg = null;

                if (indice.channelId && indice.messageId) {
                    try {
                        const c = await client.channels.fetch(indice.channelId);
                        msg = await c.messages.fetch(indice.messageId);
                        canal = c;
                    } catch { msg = null; }
                }

                const embed = new EmbedBuilder()
                    .setTitle('📌 Índice de subastas activas')
                    .setDescription('Actualizando...')
                    .setColor(0x5865F2);

                if (msg) {
                    await msg.edit({ embeds: [embed] });
                } else {
                    const nuevo = await canal.send({ embeds: [embed] });
                    guardarIndice({ channelId: canal.id, messageId: nuevo.id });
                }

                await actualizarIndice(client, funciones);
                return interaction.editReply({ content: '✅ Índice actualizado.' });
            }

            if (sub === 'cancelar') {
                if (!esLiderUsuario) {
                    return interaction.reply({ content: '❌ Solo líderes/helpers pueden cancelar una subasta.', ephemeral: true });
                }
                if (!interaction.channel.isThread()) {
                    return interaction.reply({ content: '❌ Este comando solo funciona dentro de un thread.', ephemeral: true });
                }
                const session = Object.values(subastas).find(s => s.threadId === interaction.channelId && s.estado === 'abierta');
                if (!session) {
                    return interaction.reply({ content: '❌ No hay panel activo en este thread.', ephemeral: true });
                }

                const id = guardarPendientePanel('cancelar_subasta', { sessionId: session.id }, interaction.user.id);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Sí, cancelar').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Volver').setStyle(ButtonStyle.Secondary)
                );
                return interaction.reply({ content: '⚠️ **¿Estás seguro de cancelar esta subasta?** No se guardará en el historial.', components: [row], ephemeral: true });
            }

            if (!interaction.channel.isThread()) {
                return interaction.reply({ content: '❌ Este comando solo funciona dentro de un thread.', ephemeral: true });
            }

            const session = Object.values(subastas).find(s => s.threadId === interaction.channelId && s.estado === 'abierta');
            if (!session) {
                return interaction.reply({ content: '❌ No hay panel activo en este thread.', ephemeral: true });
            }

            if (sub === 'ver') {
                const { embeds, components } = renderPanel(session, funciones);
                return interaction.reply({ embeds, components });
            }

            if (sub === 'objeto') {
                const db = funciones.cargarDB();
                const nombre = interaction.options.getString('nombre');
                const categoria = inferirCategoria(nombre, db);
                session.item.objeto = nombre;
                session.item.categoria = categoria;
                pushHistorial(session, interaction, `Objeto cambiado a ${nombre}`);
                guardarSubastas(subastas);
                await actualizarMensajePanel(client, session, funciones);
                await actualizarIndice(client, funciones);
                return interaction.reply({ content: `✅ Objeto cambiado a **${nombre}** (categoría: **${categoria}**).`, ephemeral: true });
            }

            if (sub === 'interesado') {
                const jugadorRaw = interaction.options.getString('jugador');
                const accion = interaction.options.getString('accion') || 'añadir';

                if (accion === 'quitar') {
                    if (!esLiderUsuario) {
                        return interaction.reply({
                            content: '❌ Solo líderes/helpers pueden quitar a otros interesados. Usá el botón "Retirarme" para quitarte a vos mismo.',
                            ephemeral: true
                        });
                    }
                    const miembros = funciones.cargarMiembros();
                    const canon = funciones.aplicarCanonico(jugadorRaw, miembros);
                    const idx = session.interesados.findIndex(i => claveJugadorLocal(i, miembros) === claveJugadorLocal(canon, miembros));
                    if (idx === -1) {
                        return interaction.reply({ content: 'ℹ️ Ese jugador no está anotado.', ephemeral: true });
                    }
                    session.interesados.splice(idx, 1);
                    pushHistorial(session, interaction, `Quitó a ${canon}`);
                    guardarSubastas(subastas);
                    await actualizarMensajePanel(client, session, funciones);
                    await actualizarIndice(client, funciones);
                    return interaction.reply({ content: `✅ **${canon}** quitado.`, ephemeral: true });
                }

                return mostrarConfirmacionAgregar(interaction, session, jugadorRaw, funciones);
            }
        }

        // Botones del panel
        if (interaction.isButton() && interaction.customId.startsWith('panel_btn:')) {
            const [, accion, sessionId] = interaction.customId.split(':');
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session || session.estado !== 'abierta') {
                return interaction.reply({ content: '❌ Este panel ya está cerrado, cancelado o no existe.', ephemeral: true });
            }

            const db = funciones.cargarDB();
            const miembros = funciones.cargarMiembros();
            const esLiderUsuario = esLider(interaction.member, funciones);

            if (accion === 'anotarme' || accion === 'retirarme') {
                await interaction.deferReply({ ephemeral: true });

                const nombreRaw = interaction.member?.displayName || interaction.user.username;
                const nombre = funciones.aplicarCanonico(nombreRaw, miembros);

                if (accion === 'anotarme') {
                    if (incluyeInteresado(session, nombre, miembros)) {
                        return interaction.editReply({ content: 'ℹ️ Ya estás anotado.' });
                    }
                    session.interesados.push(nombre);
                    pushHistorial(session, interaction, 'Se anotó');
                } else {
                    const idx = session.interesados.findIndex(i => claveJugadorLocal(i, miembros) === claveJugadorLocal(nombre, miembros));
                    if (idx === -1) {
                        return interaction.editReply({ content: 'ℹ️ No estabas anotado.' });
                    }
                    session.interesados.splice(idx, 1);
                    pushHistorial(session, interaction, 'Se retiró');
                }

                guardarSubastas(subastas);
                await actualizarMensajePanel(client, session, funciones);
                await actualizarIndice(client, funciones);

                return interaction.editReply({ content: accion === 'anotarme' ? '✅ Te anotaste.' : '✅ Te retiraste.' });
            }

            if (accion === 'prioridad') {
                if (session.interesados.length === 0) {
                    return interaction.reply({ content: 'ℹ️ No hay interesados para calcular prioridad.', ephemeral: true });
                }
                const resultados = session.interesados.map(j => ({
                    jugador: j,
                    ...funciones.calcularPrioridad(j, session.item.categoria, db.compras, miembros)
                }));
                resultados.sort(funciones.compararPrioridad);

                let out = `🏆 **Prioridad para ${session.item.objeto}**\n\n`;
                resultados.forEach((r, i) => {
                    out += `${i + 1}. **${funciones.aplicarCanonico(r.jugador, miembros)}**\n`;
                    out += `   Impacto: ${r.impacto.toFixed(2)} | Unid 7d: ${r.unidades7d} | Hist: ${r.historico}\n`;
                });
                return interaction.reply({ content: out, ephemeral: true });
            }

            if (accion === 'historial') {
                const hist = session.historial.slice(-10).map(h =>
                    `- ${new Date(h.timestamp).toLocaleTimeString('es-AR')} - ${h.userName}: ${h.accion}`
                ).join('\n');
                return interaction.reply({
                    content: `**Últimas modificaciones:**\n${hist || 'Sin registros.'}`,
                    ephemeral: true
                });
            }

            if (accion === 'editar') {
                const embed = new EmbedBuilder()
                    .setTitle('✏️ Editar panel')
                    .setDescription('Elegí qué querés editar:');

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`panel_edit:evento:${sessionId}`).setLabel('Evento').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`panel_edit:cantidad:${sessionId}`).setLabel('Cantidad').setStyle(ButtonStyle.Secondary)
                );
                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`panel_edit:objeto:${sessionId}`).setLabel('Objeto').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`panel_edit:agregar_interesado:${sessionId}`).setLabel('Añadir interesado').setStyle(ButtonStyle.Success)
                );
                if (esLiderUsuario) {
                    row2.addComponents(
                        new ButtonBuilder().setCustomId(`panel_edit:quitar_interesado:${sessionId}`).setLabel('Quitar interesado').setStyle(ButtonStyle.Danger)
                    );
                }

                return interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
            }

            if (accion === 'registrar') {
                if (!esLiderUsuario) {
                    return interaction.reply({ content: '❌ Solo líderes/helpers pueden registrar resultados.', ephemeral: true });
                }
                if (session.interesados.length === 0) {
                    return interaction.reply({ content: 'ℹ️ No hay interesados para registrar.', ephemeral: true });
                }

                const resultados = session.interesados.map(j => ({
                    jugador: j,
                    ...funciones.calcularPrioridad(j, session.item.categoria, db.compras, miembros)
                }));
                resultados.sort(funciones.compararPrioridad);

                const ganadorSugerido = resultados[0].jugador;
                const perdedoresSugeridos = resultados.slice(1).map(r => r.jugador);

                const modal = new ModalBuilder()
                    .setCustomId(`panel_modal:registrar:${sessionId}`)
                    .setTitle('Registrar resultado');

                const inputGanadores = new TextInputBuilder()
                    .setCustomId('ganadores')
                    .setLabel('Ganadores (separados por coma, usar x2)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(funciones.aplicarCanonico(ganadorSugerido, miembros))
                    .setRequired(true);

                const inputPerdedores = new TextInputBuilder()
                    .setCustomId('perdedores')
                    .setLabel('Perdedores (separados por coma)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(perdedoresSugeridos.map(p => funciones.aplicarCanonico(p, miembros)).join(', '))
                    .setRequired(false);

                const inputCantidad = new TextInputBuilder()
                    .setCustomId('cantidad')
                    .setLabel('Cantidad total')
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(session.item.cantidad))
                    .setRequired(true);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(inputGanadores),
                    new ActionRowBuilder().addComponents(inputPerdedores),
                    new ActionRowBuilder().addComponents(inputCantidad)
                );

                return interaction.showModal(modal);
            }

            if (accion === 'cancelar') {
                if (!esLiderUsuario) {
                    return interaction.reply({ content: '❌ Solo líderes/helpers pueden cancelar la subasta.', ephemeral: true });
                }
                const id = guardarPendientePanel('cancelar_subasta', { sessionId: session.id }, interaction.user.id);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Sí, cancelar').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Volver').setStyle(ButtonStyle.Secondary)
                );
                return interaction.reply({ content: '⚠️ **¿Estás seguro de cancelar esta subasta?** No se guardará en el historial.', components: [row], ephemeral: true });
            }
        }

        // Botones del menú Editar
        if (interaction.isButton() && interaction.customId.startsWith('panel_edit:')) {
            const [, campo, sessionId] = interaction.customId.split(':');
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session || session.estado !== 'abierta') {
                return interaction.reply({ content: '❌ Panel cerrado, cancelado o inexistente.', ephemeral: true });
            }
            const esLiderUsuario = esLider(interaction.member, funciones);

            if (campo === 'evento') {
                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`panel_sel:evento:${sessionId}`)
                        .setPlaceholder('Elegir evento')
                        .addOptions(EVENTOS_PANEL.map(e => ({ label: e, value: e })))
                );
                return interaction.reply({ content: 'Elegí evento:', components: [row], ephemeral: true });
            }

            if (campo === 'cantidad') {
                const modal = new ModalBuilder()
                    .setCustomId(`panel_modal:cantidad:${sessionId}`)
                    .setTitle('Editar cantidad');

                const input = new TextInputBuilder()
                    .setCustomId('valor')
                    .setLabel('Nueva cantidad')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(String(session.item.cantidad));

                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            if (campo === 'objeto') {
                return interaction.reply({
                    content: 'Para cambiar el objeto usá el comando `/panel objeto` (tocá el comando para copiarlo).',
                    ephemeral: true
                });
            }

            if (campo === 'agregar_interesado') {
                const modal = new ModalBuilder()
                    .setCustomId(`panel_modal:agregar_interesado:${sessionId}`)
                    .setTitle('Añadir interesado');
                const input = new TextInputBuilder()
                    .setCustomId('jugador')
                    .setLabel('Nombre(s), separados por coma')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            if (campo === 'quitar_interesado') {
                if (!esLiderUsuario) {
                    return interaction.reply({ content: '❌ Solo líderes/helpers pueden quitar interesados.', ephemeral: true });
                }
                if (session.interesados.length === 0) {
                    return interaction.reply({ content: 'ℹ️ No hay interesados para quitar.', ephemeral: true });
                }
                const opciones = session.interesados.slice(0, 25).map(j => ({
                    label: funciones.aplicarCanonico(j, funciones.cargarMiembros()),
                    value: j
                }));
                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`panel_sel_quitar:${sessionId}`)
                        .setPlaceholder('Elegí a quién quitar')
                        .addOptions(opciones)
                );
                return interaction.reply({ content: 'Elegí a quién quitar:', components: [row], ephemeral: true });
            }
        }

        // Select menus
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('panel_sel:')) {
            const [, campo, sessionId] = interaction.customId.split(':');
            const valor = interaction.values[0];
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session || session.estado !== 'abierta') {
                return interaction.reply({ content: '❌ Panel cerrado, cancelado o inexistente.', ephemeral: true });
            }

            session.item[campo] = valor;
            pushHistorial(session, interaction, `Cambió ${campo} a ${valor}`);
            guardarSubastas(subastas);
            await actualizarMensajePanel(client, session, funciones);
            await actualizarIndice(client, funciones);

            return interaction.update({ content: `✅ ${campo} cambiado a **${valor}**.`, components: [] });
        }

        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('panel_sel_quitar:')) {
            const sessionId = interaction.customId.split(':')[1];
            const valor = interaction.values[0];
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session || session.estado !== 'abierta') {
                return interaction.reply({ content: '❌ Panel cerrado, cancelado o inexistente.', ephemeral: true });
            }
            if (!esLider(interaction.member, funciones)) {
                return interaction.reply({ content: '❌ Solo líderes/helpers pueden quitar interesados.', ephemeral: true });
            }

            const miembros = funciones.cargarMiembros();
            const canon = funciones.aplicarCanonico(valor, miembros);

            const id = guardarPendientePanel('quitar_interesado', {
                sessionId: session.id,
                jugador: valor
            }, interaction.user.id);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Sí, quitar').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Volver').setStyle(ButtonStyle.Secondary)
            );

            return interaction.reply({
                content: `⚠️ **¿Quitar a ${canon} de los interesados?**`,
                components: [row],
                ephemeral: true
            });
        }

        // Modales del panel
        if (interaction.isModalSubmit() && interaction.customId.startsWith('panel_modal:')) {
            const [, tipo, sessionId] = interaction.customId.split(':');
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session || session.estado !== 'abierta') {
                return interaction.reply({ content: '❌ Sesión no encontrada o panel cerrado/cancelado.', ephemeral: true });
            }

            if (tipo === 'cantidad') {
                const valor = parseInt(interaction.fields.getTextInputValue('valor'), 10);
                if (isNaN(valor) || valor < 0) {
                    return interaction.reply({ content: '❌ Cantidad inválida.', ephemeral: true });
                }
                session.item.cantidad = valor;
                pushHistorial(session, interaction, `Cambió cantidad a ${valor}`);
                guardarSubastas(subastas);
                await actualizarMensajePanel(client, session, funciones);
                await actualizarIndice(client, funciones);
                return interaction.reply({ content: `✅ Cantidad cambiada a **${valor}**.`, ephemeral: true });
            }

            if (tipo === 'agregar_interesado') {
                const jugadorRaw = interaction.fields.getTextInputValue('jugador').trim();
                if (!jugadorRaw) {
                    return interaction.reply({ content: '❌ Nombre inválido.', ephemeral: true });
                }
                return mostrarConfirmacionAgregar(interaction, session, jugadorRaw, funciones);
            }

            if (tipo === 'registrar') {
                if (!esLider(interaction.member, funciones)) {
                    return interaction.reply({ content: '❌ Solo líderes/helpers pueden registrar resultados.', ephemeral: true });
                }

                const miembros = funciones.cargarMiembros();
                const ganadoresRaw = interaction.fields.getTextInputValue('ganadores')
                    .split(',').map(s => s.trim()).filter(Boolean)
                    .map(g => funciones.aplicarCanonico(g, miembros));
                const perdedoresRaw = interaction.fields.getTextInputValue('perdedores')
                    .split(',').map(s => s.trim()).filter(Boolean)
                    .map(g => funciones.aplicarCanonico(g, miembros));
                const cantidad = parseInt(interaction.fields.getTextInputValue('cantidad'), 10) || session.item.cantidad;

                const id = guardarPendientePanel('registrar_resultado', {
                    sessionId,
                    ganadores: ganadoresRaw,
                    perdedores: perdedoresRaw,
                    cantidad
                }, interaction.user.id);

                let txt = `📋 **Confirmar registro de resultado**\n\n`;
                txt += `**Objeto:** ${session.item.objeto}\n`;
                txt += `**Categoría:** ${session.item.categoria}\n`;
                txt += `**Evento:** ${session.item.evento}\n`;
                txt += `**Fecha:** ${session.item.fecha}\n`;
                txt += `**Cantidad:** ${cantidad}\n\n`;
                txt += `🏆 **Ganadores:** ${ganadoresRaw.map(g => `**${g}**`).join(', ') || 'nadie'}\n`;
                if (perdedoresRaw.length > 0) txt += `💔 **Perdedores:** ${perdedoresRaw.join(', ')}\n`;
                txt += `\n¿Confirmás y guardás en el historial?`;

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Confirmar y guardar').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Cancelar').setStyle(ButtonStyle.Danger)
                );

                return interaction.reply({ content: txt, components: [row], ephemeral: true });
            }
        }

        // Confirmaciones pendientes del panel
        if (interaction.isButton() && (interaction.customId.startsWith('panel_pending_confirm:') || interaction.customId.startsWith('panel_pending_cancel:'))) {
            const esConfirm = interaction.customId.startsWith('panel_pending_confirm:');
            const id = interaction.customId.replace('panel_pending_confirm:', '').replace('panel_pending_cancel:', '');
            const p = pendingPanel.get(id);
            if (!p) {
                return interaction.update({ content: '❌ La sesión expiró. Volvé a intentarlo.', components: [] });
            }
            if (p.userId !== interaction.user.id) {
                return interaction.reply({ content: '❌ Solo quien inició la acción puede confirmar.', ephemeral: true });
            }
            if (!esConfirm) {
                pendingPanel.delete(id);
                return interaction.update({ content: '❌ Acción cancelada.', components: [] });
            }

            try { await interaction.deferUpdate(); } catch { /* ignorar */ }

            const subastas = cargarSubastas();
            const session = subastas[p.payload.sessionId];
            if (!session || session.estado !== 'abierta') {
                pendingPanel.delete(id);
                return interaction.editReply({ content: '❌ El panel ya no está activo.', components: [] });
            }

            const miembros = funciones.cargarMiembros();

            if (p.tipo === 'agregar_interesados') {
                const nuevos = p.payload.nuevos || [];
                const yaEstaban = p.payload.yaEstaban || [];
                const agregados = [];
                for (const n of nuevos) {
                    if (!incluyeInteresado(session, n, miembros)) {
                        session.interesados.push(n);
                        agregados.push(n);
                    }
                }
                if (agregados.length > 0) {
                    pushHistorial(session, interaction, `Añadió a ${agregados.join(', ')}`);
                    guardarSubastas(subastas);
                    await actualizarMensajePanel(client, session, funciones);
                    await actualizarIndice(client, funciones);
                }
                pendingPanel.delete(id);

                let txt = `✅ **Agregados:** ${agregados.map(n => `**${n}**`).join(', ') || 'ninguno'}`;
                if (yaEstaban.length > 0) txt += `\nℹ️ Ya estaban: ${yaEstaban.join(', ')}`;
                return interaction.editReply({ content: txt, components: [] });
            }

            if (p.tipo === 'quitar_interesado') {
                const jugador = p.payload.jugador;
                const idx = session.interesados.findIndex(i => claveJugadorLocal(i, miembros) === claveJugadorLocal(jugador, miembros));
                if (idx === -1) {
                    pendingPanel.delete(id);
                    return interaction.editReply({ content: 'ℹ️ Ese jugador ya no está en la lista.', components: [] });
                }
                session.interesados.splice(idx, 1);
                pushHistorial(session, interaction, `Quitó a ${jugador}`);
                guardarSubastas(subastas);
                await actualizarMensajePanel(client, session, funciones);
                await actualizarIndice(client, funciones);
                pendingPanel.delete(id);
                return interaction.editReply({ content: `✅ **${funciones.aplicarCanonico(jugador, miembros)}** quitado.`, components: [] });
            }

            if (p.tipo === 'registrar_resultado') {
                const db = funciones.cargarDB();
                const entrada = {
                    id: db.nextId++,
                    fecha: session.item.fecha,
                    evento: session.item.evento,
                    categoria: session.item.categoria,
                    objeto: session.item.objeto,
                    cantidad: p.payload.cantidad,
                    ganadores: p.payload.ganadores,
                    perdedores: p.payload.perdedores,
                    notas: ''
                };
                db.compras.push(entrada);
                funciones.guardarDB(db);

                const syncRes = await funciones.sincronizarConGitHub(false);

                session.estado = 'cerrada';
                pushHistorial(session, interaction, 'Registró resultado');
                guardarSubastas(subastas);
                await actualizarMensajePanel(client, session, funciones);

                const archivadas = cargarArchivadas();
                archivadas[session.id] = session;
                guardarArchivadas(archivadas);

                delete subastas[session.id];
                guardarSubastas(subastas);
                await actualizarIndice(client, funciones);

                let msg = `✅ Resultado registrado: #${entrada.id} · ${entrada.cantidad}x ${entrada.objeto} (${entrada.categoria})\n`;
                msg += `🏆 ${entrada.ganadores.map(g => funciones.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}`;
                if (entrada.perdedores.length > 0) {
                    msg += `\n💔 ${entrada.perdedores.map(g => funciones.formatearNombreConCantidad(g, miembros)).join(', ')}`;
                }
                if (!syncRes.ok) msg += `\n⚠️ Sync falló: ${syncRes.motivo}`;

                pendingPanel.delete(id);
                return interaction.editReply({ content: msg, components: [] });
            }

            if (p.tipo === 'cancelar_subasta') {
                session.estado = 'cancelada';
                pushHistorial(session, interaction, 'Subasta cancelada');
                guardarSubastas(subastas);
                await actualizarMensajePanel(client, session, funciones);

                const archivadas = cargarArchivadas();
                archivadas[session.id] = session;
                guardarArchivadas(archivadas);

                delete subastas[session.id];
                guardarSubastas(subastas);
                await actualizarIndice(client, funciones);

                pendingPanel.delete(id);
                return interaction.editReply({ content: '🗑️ Subasta cancelada y archivada sin registrar en historial.', components: [] });
            }
        }
    });
}

module.exports = { comandosPanel, setupPanel };
