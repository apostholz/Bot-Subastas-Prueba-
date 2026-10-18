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

function pushHistorial(session, interaction, accion) {
    session.historial.push({
        timestamp: Date.now(),
        userId: interaction.user.id,
        userName: interaction.user.username,
        accion
    });
    if (session.historial.length > 50) session.historial = session.historial.slice(-50);
}

function renderPanel(session, funciones) {
    const item = session.item;
    const interesados = session.interesados;

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
            value: interesados.length
                ? interesados.map(i => `• ${i}`).join('\n')
                : 'Nadie aún'
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

    const cerrada = session.estado === 'cerrada';

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel_btn:anotarme:${session.id}`).setLabel('Anotarme').setStyle(ButtonStyle.Success).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:retirarme:${session.id}`).setLabel('Retirarme').setStyle(ButtonStyle.Danger).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:ver_interesados:${session.id}`).setLabel('Ver interesados').setStyle(ButtonStyle.Secondary).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:prioridad:${session.id}`).setLabel('Calcular prioridad').setStyle(ButtonStyle.Primary).setDisabled(cerrada)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel_btn:editar:${session.id}`).setLabel('Editar').setStyle(ButtonStyle.Secondary).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:historial:${session.id}`).setLabel('Ver historial').setStyle(ButtonStyle.Secondary).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:registrar:${session.id}`).setLabel('Registrar resultado').setStyle(ButtonStyle.Primary).setDisabled(cerrada)
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
    if (!indice.channelId || !indice.messageId) return;
    try {
        const canal = await client.channels.fetch(indice.channelId);
        const msg = await canal.messages.fetch(indice.messageId);
        const subastas = cargarSubastas();
        const activas = Object.values(subastas).filter(s => s.estado === 'abierta');

        let desc = 'No hay subastas activas.';
        if (activas.length > 0) {
            desc = activas.map(s => `• <#${s.threadId}> — ${s.item.objeto} (${s.interesados.length}/${s.item.cantidad})`).join('\n');
        }

        const embed = new EmbedBuilder()
            .setTitle('📌 Índice de subastas activas')
            .setDescription(desc)
            .setColor(0x5865F2);

        await msg.edit({ embeds: [embed] });
    } catch (e) {
        console.error('Error actualizando índice:', e.message);
    }
}

const comandosPanel = [
    new SlashCommandBuilder()
        .setName('panel')
        .setDescription('Gestionar panel de subasta')
        .addSubcommand(sub => sub
            .setName('crear')
            .setDescription('Crear panel en el thread actual')
            .addStringOption(o => o.setName('objeto').setDescription('Nombre del objeto').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('categoria').setDescription('Categoría').setRequired(true)
                .addChoices(...CATEGORIAS_PANEL.map(c => ({ name: c, value: c }))))
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
                if (!interaction.channel.isThread()) {
                    return interaction.reply({ content: '❌ Este comando solo funciona dentro de un thread.', ephemeral: true });
                }
                const threadId = interaction.channelId;
                const existente = Object.values(subastas).find(s => s.threadId === threadId && s.estado === 'abierta');
                if (existente) {
                    return interaction.reply({ content: '❌ Ya hay un panel activo en este thread. Cerrálo antes de crear otro.', ephemeral: true });
                }

                const objeto = interaction.options.getString('objeto');
                const categoria = interaction.options.getString('categoria');
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
                const msg = await interaction.reply({ embeds, components, fetchReply: true });
                session.messageId = msg.id;
                guardarSubastas(subastas);

                await actualizarIndice(client, funciones);
                return;
            }

            if (sub === 'indice') {
                if (!esLiderUsuario) {
                    return interaction.reply({ content: '❌ Solo líderes/helpers pueden crear o actualizar el índice.', ephemeral: true });
                }
                const channelId = interaction.channelId;
                const embed = new EmbedBuilder()
                    .setTitle('📌 Índice de subastas activas')
                    .setDescription('Cargando...')
                    .setColor(0x5865F2);
                const msg = await interaction.reply({ embeds: [embed], fetchReply: true });
                guardarIndice({ channelId, messageId: msg.id });
                await actualizarIndice(client, funciones);
                return;
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
                const nombre = interaction.options.getString('nombre');
                session.item.objeto = nombre;
                pushHistorial(session, interaction, `Objeto cambiado a ${nombre}`);
                guardarSubastas(subastas);
                await actualizarMensajePanel(client, session, funciones);
                await actualizarIndice(client, funciones);
                return interaction.reply({ content: `✅ Objeto cambiado a **${nombre}**.`, ephemeral: true });
            }

            if (sub === 'interesado') {
                const jugador = interaction.options.getString('jugador');
                const accion = interaction.options.getString('accion') || 'añadir';

                if (accion === 'quitar' && !esLiderUsuario) {
                    return interaction.reply({
                        content: '❌ Solo líderes/helpers pueden quitar a otros interesados. Usá el botón "Retirarme" para quitarte a vos mismo.',
                        ephemeral: true
                    });
                }

                if (accion === 'añadir') {
                    if (!session.interesados.includes(jugador)) {
                        session.interesados.push(jugador);
                        pushHistorial(session, interaction, `Añadió a ${jugador}`);
                    }
                } else {
                    const idx = session.interesados.indexOf(jugador);
                    if (idx !== -1) {
                        session.interesados.splice(idx, 1);
                        pushHistorial(session, interaction, `Quitó a ${jugador}`);
                    }
                }

                guardarSubastas(subastas);
                await actualizarMensajePanel(client, session, funciones);
                await actualizarIndice(client, funciones);

                return interaction.reply({
                    content: `✅ ${accion === 'añadir' ? 'Añadido' : 'Quitado'} **${jugador}**.`,
                    ephemeral: true
                });
            }
        }

        // Botones del panel
        if (interaction.isButton() && interaction.customId.startsWith('panel_btn:')) {
            const [, accion, sessionId] = interaction.customId.split(':');
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session || session.estado === 'cerrada') {
                return interaction.reply({ content: '❌ Este panel ya está cerrado o no existe.', ephemeral: true });
            }

            const db = funciones.cargarDB();
            const miembros = funciones.cargarMiembros();
            const esLiderUsuario = esLider(interaction.member, funciones);

            if (accion === 'anotarme') {
                const nombre = funciones.aplicarCanonico(interaction.user.username, miembros);
                if (session.interesados.includes(nombre)) {
                    return interaction.reply({ content: 'ℹ️ Ya estás anotado.', ephemeral: true });
                }
                session.interesados.push(nombre);
                pushHistorial(session, interaction, 'Se anotó');
                guardarSubastas(subastas);
                await actualizarMensajePanel(client, session, funciones);
                await actualizarIndice(client, funciones);
                return interaction.reply({ content: '✅ Te anotaste.', ephemeral: true });
            }

            if (accion === 'retirarme') {
                const nombre = funciones.aplicarCanonico(interaction.user.username, miembros);
                const idx = session.interesados.indexOf(nombre);
                if (idx === -1) {
                    return interaction.reply({ content: 'ℹ️ No estabas anotado.', ephemeral: true });
                }
                session.interesados.splice(idx, 1);
                pushHistorial(session, interaction, 'Se retiró');
                guardarSubastas(subastas);
                await actualizarMensajePanel(client, session, funciones);
                await actualizarIndice(client, funciones);
                return interaction.reply({ content: '✅ Te retiraste.', ephemeral: true });
            }

            if (accion === 'ver_interesados') {
                const lista = session.interesados.length
                    ? session.interesados.join('\n')
                    : 'Nadie aún.';
                return interaction.reply({
                    content: `**Interesados (${session.interesados.length}/${session.item.cantidad}):**\n${lista}`,
                    ephemeral: true
                });
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
                    new ButtonBuilder().setCustomId(`panel_edit:categoria:${sessionId}`).setLabel('Categoría').setStyle(ButtonStyle.Secondary),
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
                    .setValue(ganadorSugerido)
                    .setRequired(true);

                const inputPerdedores = new TextInputBuilder()
                    .setCustomId('perdedores')
                    .setLabel('Perdedores (separados por coma)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(perdedoresSugeridos.join(', '))
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
        }

        // Botones del menú Editar
        if (interaction.isButton() && interaction.customId.startsWith('panel_edit:')) {
            const [, campo, sessionId] = interaction.customId.split(':');
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session || session.estado === 'cerrada') {
                return interaction.reply({ content: '❌ Panel cerrado o inexistente.', ephemeral: true });
            }
            const esLiderUsuario = esLider(interaction.member, funciones);

            if (campo === 'evento' || campo === 'categoria') {
                const opciones = campo === 'evento'
                    ? EVENTOS_PANEL.map(e => ({ label: e, value: e }))
                    : CATEGORIAS_PANEL.map(c => ({ label: c, value: c }));

                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`panel_sel:${campo}:${sessionId}`)
                        .setPlaceholder(`Elegir ${campo}`)
                        .addOptions(opciones)
                );
                return interaction.reply({ content: `Elegí ${campo}:`, components: [row], ephemeral: true });
            }

            if (campo === 'cantidad' || campo === 'objeto') {
                const modal = new ModalBuilder()
                    .setCustomId(`panel_modal:${campo}:${sessionId}`)
                    .setTitle(`Editar ${campo}`);

                const input = new TextInputBuilder()
                    .setCustomId('valor')
                    .setLabel(campo === 'cantidad' ? 'Nueva cantidad' : 'Nuevo objeto')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(campo === 'cantidad' ? String(session.item.cantidad) : session.item.objeto);

                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            if (campo === 'agregar_interesado') {
                const modal = new ModalBuilder()
                    .setCustomId(`panel_modal:agregar_interesado:${sessionId}`)
                    .setTitle('Añadir interesado');
                const input = new TextInputBuilder()
                    .setCustomId('jugador')
                    .setLabel('Nombre del jugador')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }

            if (campo === 'quitar_interesado') {
                if (!esLiderUsuario) {
                    return interaction.reply({ content: '❌ Solo líderes/helpers pueden quitar interesados.', ephemeral: true });
                }
                const modal = new ModalBuilder()
                    .setCustomId(`panel_modal:quitar_interesado:${sessionId}`)
                    .setTitle('Quitar interesado');
                const input = new TextInputBuilder()
                    .setCustomId('jugador')
                    .setLabel('Nombre del jugador')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(input));
                return interaction.showModal(modal);
            }
        }

        // Select menus de edición
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('panel_sel:')) {
            const [, campo, sessionId] = interaction.customId.split(':');
            const valor = interaction.values[0];
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session || session.estado === 'cerrada') {
                return interaction.reply({ content: '❌ Panel cerrado o inexistente.', ephemeral: true });
            }

            session.item[campo] = valor;
            pushHistorial(session, interaction, `Cambió ${campo} a ${valor}`);
            guardarSubastas(subastas);
            await actualizarMensajePanel(client, session, funciones);
            await actualizarIndice(client, funciones);

            return interaction.update({ content: `✅ ${campo} cambiado a **${valor}**.`, components: [] });
        }

        // Modales del panel
        if (interaction.isModalSubmit() && interaction.customId.startsWith('panel_modal:')) {
            const [, tipo, sessionId] = interaction.customId.split(':');
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session) {
                return interaction.reply({ content: '❌ Sesión no encontrada.', ephemeral: true });
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

            if (tipo === 'objeto') {
                const valor = interaction.fields.getTextInputValue('valor').trim();
                if (!valor) {
                    return interaction.reply({ content: '❌ El objeto no puede estar vacío.', ephemeral: true });
                }
                session.item.objeto = valor;
                pushHistorial(session, interaction, `Cambió objeto a ${valor}`);
                guardarSubastas(subastas);
                await actualizarMensajePanel(client, session, funciones);
                await actualizarIndice(client, funciones);
                return interaction.reply({ content: `✅ Objeto cambiado a **${valor}**.`, ephemeral: true });
            }

            if (tipo === 'agregar_interesado') {
                const jugador = interaction.fields.getTextInputValue('jugador').trim();
                if (!jugador) {
                    return interaction.reply({ content: '❌ Nombre inválido.', ephemeral: true });
                }
                if (!session.interesados.includes(jugador)) {
                    session.interesados.push(jugador);
                    pushHistorial(session, interaction, `Añadió a ${jugador}`);
                    guardarSubastas(subastas);
                    await actualizarMensajePanel(client, session, funciones);
                    await actualizarIndice(client, funciones);
                    return interaction.reply({ content: `✅ **${jugador}** añadido.`, ephemeral: true });
                }
                return interaction.reply({ content: 'ℹ️ Ya estaba en la lista.', ephemeral: true });
            }

            if (tipo === 'quitar_interesado') {
                if (!esLider(interaction.member, funciones)) {
                    return interaction.reply({ content: '❌ Solo líderes/helpers pueden quitar interesados.', ephemeral: true });
                }
                const jugador = interaction.fields.getTextInputValue('jugador').trim();
                const idx = session.interesados.indexOf(jugador);
                if (idx === -1) {
                    return interaction.reply({ content: 'ℹ️ No está en la lista.', ephemeral: true });
                }
                session.interesados.splice(idx, 1);
                pushHistorial(session, interaction, `Quitó a ${jugador}`);
                guardarSubastas(subastas);
                await actualizarMensajePanel(client, session, funciones);
                await actualizarIndice(client, funciones);
                return interaction.reply({ content: `✅ **${jugador}** quitado.`, ephemeral: true });
            }

            if (tipo === 'registrar') {
                if (!esLider(interaction.member, funciones)) {
                    return interaction.reply({ content: '❌ Solo líderes/helpers pueden registrar resultados.', ephemeral: true });
                }

                const ganadores = interaction.fields.getTextInputValue('ganadores')
                    .split(',').map(s => s.trim()).filter(Boolean);
                const perdedores = interaction.fields.getTextInputValue('perdedores')
                    .split(',').map(s => s.trim()).filter(Boolean);
                const cantidad = parseInt(interaction.fields.getTextInputValue('cantidad'), 10) || session.item.cantidad;

                const db = funciones.cargarDB();
                const entrada = {
                    id: db.nextId++,
                    fecha: session.item.fecha,
                    evento: session.item.evento,
                    categoria: session.item.categoria,
                    objeto: session.item.objeto,
                    cantidad,
                    ganadores,
                    perdedores,
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
                archivadas[sessionId] = session;
                guardarArchivadas(archivadas);

                delete subastas[sessionId];
                guardarSubastas(subastas);

                await actualizarIndice(client, funciones);

                let msg = `✅ Resultado registrado: #${entrada.id} · ${cantidad}x ${entrada.objeto} (${entrada.categoria})\n🏆 ${ganadores.join(', ') || 'nadie'}`;
                if (perdedores.length) msg += `\n💔 ${perdedores.join(', ')}`;
                if (!syncRes.ok) msg += `\n⚠️ Sync falló: ${syncRes.motivo}`;

                return interaction.reply({ content: msg, ephemeral: true });
            }
        }
    });
}

module.exports = { comandosPanel, setupPanel };
