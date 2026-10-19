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

const utils = require('./utils');
const logic = require('./logic');

const DATA_DIR = '/app/data';
const SUBASTAS_FILE = path.join(DATA_DIR, 'subastas_activas.json');
const ARCHIVADAS_FILE = path.join(DATA_DIR, 'subastas_archivadas.json');
const INDICE_FILE = path.join(DATA_DIR, 'indice.json');
const CONTROL_FILE = path.join(DATA_DIR, 'control.json');
const THREADS_FILE = path.join(DATA_DIR, 'threads_fijos.json');

const CATEGORIAS_PANEL = ['Cajas 20k', 'Emblemas Generales', 'Emblemas Únicos', 'Equipo', 'Accesorios'];
const EVENTOS_PANEL = ['Invasión diurna', 'Invasión nocturna', 'Banquete'];

const pendingPanel = new Map();

// ====== HELPERS DE ARCHIVOS ======
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
function cargarControl() { return cargarJSON(CONTROL_FILE, { channelId: null, messageId: null }); }
function guardarControl(d) { guardarJSON(CONTROL_FILE, d); }
function cargarThreadsFijos() { return cargarJSON(THREADS_FILE, []); }
function guardarThreadsFijos(d) { guardarJSON(THREADS_FILE, d); }
function generarId() { return Math.random().toString(36).slice(2, 10); }

// ====== LÓGICA DE NEGOCIO ======
function esLider(member, funciones) {
    if (!member) return false;
    if (member.id === member.guild.ownerId) return true;
    if (member.permissions && member.permissions.has('Administrator')) return true;
    return member.roles.cache.has(funciones.ROL_LIDER) || member.roles.cache.has(funciones.ROL_HELPER);
}

function obtenerEventoPorHora() {
    const ahora = new Date();
    const horaStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }).format(ahora);
    const hora = parseInt(horaStr, 10);
    if (hora >= 5 && hora < 18) return 'Invasión diurna';
    if (hora >= 18 && hora <= 21) return 'Invasión nocturna';
    return 'Banquete';
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
        timestamp: Date.now(), userId: interaction.user.id,
        userName: interaction.member?.displayName || interaction.user.username, accion
    });
    if (session.historial.length > 50) session.historial = session.historial.slice(-50);
}

// ====== RENDERIZADO ======
function renderPanel(session, funciones) {
    const item = session.item;
    const miembros = funciones.cargarMiembros();
    const interesados = session.interesados.map(i => funciones.aplicarCanonico(i, miembros));

    const embed = new EmbedBuilder()
        .setTitle(`📦 ${item.objeto}`)
        .setDescription(`**Evento:** ${item.evento}\n**Categoría:** ${item.categoria}\n**Cantidad:** ${item.cantidad}\n**Fecha:** ${item.fecha}`)
        .addFields({ name: `Interesados (${interesados.length})`, value: interesados.length ? interesados.map(i => `• ${i}`).join('\n') : 'Nadie aún' });

    if (interesados.length > item.cantidad) {
        embed.setColor(0xFF0000);
        embed.setFooter({ text: `⚠️ Hay ${interesados.length} interesados para ${item.cantidad} unidades` });
    } else embed.setColor(0x00FF00);

    const ultimo = session.historial[session.historial.length - 1];
    if (ultimo) embed.setFooter({ text: `Últ. mod: ${ultimo.userName} - ${new Date(ultimo.timestamp).toLocaleTimeString('es-AR')}` });

    const cerrada = session.estado !== 'abierta';

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel_btn:anotarme:${session.id}`).setLabel('Anotarme').setStyle(ButtonStyle.Success).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:retirarme:${session.id}`).setLabel('Retirarme').setStyle(ButtonStyle.Danger).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:prioridad:${session.id}`).setLabel('Calcular prioridad').setStyle(ButtonStyle.Primary).setDisabled(cerrada)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel_btn:editar:${session.id}`).setLabel('Editar').setStyle(ButtonStyle.Secondary).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:historial:${session.id}`).setLabel('Ver historial').setStyle(ButtonStyle.Secondary).setDisabled(cerrada),
        new ButtonBuilder().setCustomId(`panel_btn:logs:${session.id}`).setLabel('Logs').setStyle(ButtonStyle.Secondary).setDisabled(cerrada),
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
        if (e.code === 10008) { // Unknown Message
            console.log(`[Panel] Mensaje no encontrado en <#${session.threadId}>. Recreando...`);
            try {
                const canal = await client.channels.fetch(session.channelId);
                const { embeds, components } = renderPanel(session, funciones);
                const nuevo = await canal.send({ embeds, components });
                session.messageId = nuevo.id;
                const subastas = cargarSubastas();
                subastas[session.id] = session;
                guardarSubastas(subastas);
            } catch (err) { console.error('[Panel] Error al recrear:', err.message); }
        } else {
            console.error(`[Panel] Error editando en <#${session.threadId}>:`, e.message);
        }
    }
}

async function actualizarIndice(client, funciones) {
    const indice = cargarIndice();
    if (!indice.channelId) return;
    try {
        const canal = await client.channels.fetch(indice.channelId);
        let msg = null;
        if (indice.messageId) try { msg = await canal.messages.fetch(indice.messageId); } catch { msg = null; }

        const subastas = cargarSubastas();
        const activas = Object.values(subastas).filter(s => s.estado === 'abierta');

        let desc = 'No hay subastas activas.';
        if (activas.length > 0) {
            desc = 'Referencia: (interesados / unidades)\n\n';
            desc += activas.map(s => `• <#${s.threadId}> — ${s.item.objeto} (${s.interesados.length} / ${s.item.cantidad})`).join('\n');
        }

        const embed = new EmbedBuilder().setTitle('📌 Índice de subastas activas').setDescription(desc).setColor(0x5865F2);
        if (msg) await msg.edit({ embeds: [embed] });
        else { const nuevo = await canal.send({ embeds: [embed] }); guardarIndice({ channelId: canal.id, messageId: nuevo.id }); }
    } catch (e) { /* ignorar */ }
}

async function actualizarControlPanel(client, funciones) {
    const control = cargarControl();
    if (!control.channelId) return;
    try {
        const canal = await client.channels.fetch(control.channelId);
        let msg = null;
        if (control.messageId) try { msg = await canal.messages.fetch(control.messageId); } catch { msg = null; }

        const fijos = cargarThreadsFijos();
        const subastas = cargarSubastas();
        
        let desc = 'No hay threads fijos configurados.';
        if (fijos.length > 0) {
            desc = fijos.map(tId => {
                const session = Object.values(subastas).find(s => s.threadId === tId && s.estado === 'abierta');
                const estado = session ? `🔴 **Activa** - ${session.item.objeto}` : '🟢 Libre';
                return `• <#${tId}> — ${estado}`;
            }).join('\n');
        }

        const embed = new EmbedBuilder().setTitle('🎛️ Panel de Control de Subastas').setDescription(desc).setColor(0x2B2D31);

        const rows = [];
        const chunks = fijos.slice(0, 15);
        for (let i = 0; i < chunks.length; i += 3) {
            const row = new ActionRowBuilder();
            for (const tId of chunks.slice(i, i + 3)) {
                const session = Object.values(subastas).find(s => s.threadId === tId && s.estado === 'abierta');
                if (session) {
                    row.addComponents(new ButtonBuilder().setCustomId(`control_btn:cerrar:${tId}`).setLabel(`Cerrar ${tId.slice(-4)}`).setStyle(ButtonStyle.Danger));
                } else {
                    row.addComponents(new ButtonBuilder().setCustomId(`control_btn:abrir:${tId}`).setLabel(`Abrir ${tId.slice(-4)}`).setStyle(ButtonStyle.Success));
                }
            }
            rows.push(row);
        }

        if (fijos.length > 0) {
            const rowGlobal = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('control_btn:abrir_todos').setLabel('Abrir TODAS').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('control_btn:cerrar_todos').setLabel('Cerrar TODAS').setStyle(ButtonStyle.Secondary)
            );
            rows.push(rowGlobal);
        }

        if (msg) await msg.edit({ embeds: [embed], components: rows });
        else { const nuevo = await canal.send({ embeds: [embed], components: rows }); guardarControl({ channelId: canal.id, messageId: nuevo.id }); }
    } catch (e) { console.error('Error actualizando control:', e); }
}

async function refrescarTodo(client, funciones) {
    const subastas = cargarSubastas();
    let actualizadas = 0;
    for (const id in subastas) {
        if (subastas[id].estado === 'abierta') {
            await actualizarMensajePanel(client, subastas[id], funciones);
            actualizadas++;
        }
    }
    await actualizarIndice(client, funciones);
    await actualizarControlPanel(client, funciones);
    return actualizadas;
}

// ====== FLUJOS DE SUBAGREGAR INTERESADOS ======
async function mostrarConfirmacionAgregar(interaction, session, nombresRaw, funciones) {
    const miembros = funciones.cargarMiembros();
    const partes = nombresRaw.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
    const nuevos = [], yaEstaban = [], vistos = new Set();

    for (const p of partes) {
        const canon = funciones.aplicarCanonico(p, miembros);
        const key = utils.claveJugador(canon, miembros);
        if (vistos.has(key)) continue;
        vistos.add(key);
        if (session.interesados.some(i => utils.claveJugador(i, miembros) === key)) yaEstaban.push(canon);
        else nuevos.push(canon);
    }

    if (nuevos.length === 0) return interaction.reply({ content: `ℹ️ Todos ya estaban anotados: ${yaEstaban.join(', ')}`, ephemeral: true });

    const id = guardarPendientePanel('agregar_interesados', { sessionId: session.id, nuevos, yaEstaban }, interaction.user.id);
    let txt = `📋 **Confirmar agregar**\n\n**Se agregarán:** ${nuevos.map(n => `**${n}**`).join(', ')}\n`;
    if (yaEstaban.length > 0) txt += `**Ya estaban:** ${yaEstaban.join(', ')}\n\n¿Confirmás?`;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Confirmar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Cancelar').setStyle(ButtonStyle.Danger)
    );
    return interaction.reply({ content: txt, components: [row], ephemeral: true });
}

// ====== SETUP PRINCIPAL ======
function setupPanel(client, funciones) {
    // 1. Hilo de Auto-actualización (cada 60s)
    setInterval(async () => {
        await refrescarTodo(client, funciones);
    }, 60 * 1000);

    client.on('interactionCreate', async (interaction) => {
        // Autocompletado de /panel
        if (interaction.isAutocomplete() && interaction.commandName === 'panel') {
            const focused = interaction.options.getFocused(true);
            const db = funciones.cargarDB();
            const miembros = funciones.cargarMiembros();
            if (focused.name === 'objeto' || focused.name === 'nombre') {
                const objetos = funciones.obtenerObjetosUnicos(db);
                const q = funciones.normalizar(focused.value);
                return interaction.respond(objetos.filter(n => funciones.normalizar(n).includes(q)).slice(0, 25).map(n => ({ name: n, value: n })));
            }
            if (focused.name === 'jugador') {
                const nombres = funciones.obtenerNombresUnicos(db, miembros);
                const q = funciones.normalizar(focused.value);
                return interaction.respond(nombres.filter(n => funciones.normalizar(n).includes(q)).slice(0, 25).map(n => ({ name: n, value: n })));
            }
            return;
        }

        // ====== COMANDO /PANEL ======
        if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
            const sub = interaction.options.getSubcommand();
            const subastas = cargarSubastas();
            const esLiderUsuario = esLider(interaction.member, funciones);

            if (sub === 'refresh') {
                await interaction.deferReply({ ephemeral: true });
                const cant = await refrescarTodo(client, funciones);
                return interaction.editReply({ content: `✅ Refrescados **${cant}** paneles activos.` });
            }

            if (sub === 'crear') {
                await interaction.deferReply();
                if (!interaction.channel.isThread()) return interaction.editReply({ content: '❌ Solo funciona en threads.' });
                const threadId = interaction.channelId;
                if (Object.values(subastas).find(s => s.threadId === threadId && s.estado === 'abierta')) return interaction.editReply({ content: '❌ Ya hay panel activo acá.' });

                const db = funciones.cargarDB();
                const objeto = interaction.options.getString('objeto');
                const categoria = logic.inferirCategoria(objeto, db);
                const cantidad = interaction.options.getInteger('cantidad');
                const evento = interaction.options.getString('evento') || obtenerEventoPorHora();
                const fecha = funciones.fechaHoyArgentina();

                const session = {
                    id: generarId(), threadId, channelId: interaction.channelId, messageId: null,
                    item: { fecha, evento, categoria, objeto, cantidad },
                    interesados: [], estado: 'abierta', historial: [], creadoPor: interaction.user.id, createdAt: Date.now()
                };
                pushHistorial(session, interaction, 'Panel creado');
                subastas[session.id] = session;
                guardarSubastas(subastas);

                const { embeds, components } = renderPanel(session, funciones);
                const msg = await interaction.editReply({ embeds, components });
                session.messageId = msg.id;
                guardarSubastas(subastas);

                await refrescarTodo(client, funciones);
                return;
            }

            if (sub === 'indice') {
                if (!esLiderUsuario) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });
                await interaction.deferReply({ ephemeral: true });
                const indice = cargarIndice();
                let canal = interaction.channel, msg = null;
                if (indice.channelId && indice.messageId) try { const c = await client.channels.fetch(indice.channelId); msg = await c.messages.fetch(indice.messageId); canal = c; } catch { msg = null; }
                
                const embed = new EmbedBuilder().setTitle('📌 Índice de subastas activas').setDescription('Actualizando...').setColor(0x5865F2);
                if (msg) await msg.edit({ embeds: [embed] }); else { const nuevo = await canal.send({ embeds: [embed] }); guardarIndice({ channelId: canal.id, messageId: nuevo.id }); }
                await actualizarIndice(client, funciones);
                return interaction.editReply({ content: '✅ Índice actualizado.' });
            }

            if (sub === 'cancelar') {
                if (!esLiderUsuario) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });
                if (!interaction.channel.isThread()) return interaction.reply({ content: '❌ Solo en threads.', ephemeral: true });
                const session = Object.values(subastas).find(s => s.threadId === interaction.channelId && s.estado === 'abierta');
                if (!session) return interaction.reply({ content: '❌ No hay panel activo.', ephemeral: true });

                const id = guardarPendientePanel('cancelar_subasta', { sessionId: session.id }, interaction.user.id);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Sí, cancelar y eliminar').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Volver').setStyle(ButtonStyle.Secondary)
                );
                return interaction.reply({ content: '⚠️ **¿Cancelar esta subasta y eliminar el panel?**', components: [row], ephemeral: true });
            }

            if (!interaction.channel.isThread()) return interaction.reply({ content: '❌ Solo en threads.', ephemeral: true });
            const session = Object.values(subastas).find(s => s.threadId === interaction.channelId && s.estado === 'abierta');
            if (!session) return interaction.reply({ content: '❌ No hay panel activo.', ephemeral: true });

            if (sub === 'ver') {
                // Punto 4: Borrar el mensaje anterior
                if (session.messageId) {
                    try {
                        const canal = await client.channels.fetch(session.channelId);
                        const oldMsg = await canal.messages.fetch(session.messageId);
                        await oldMsg.delete();
                    } catch (e) { /* ignorar si ya no existe */ }
                }
                const { embeds, components } = renderPanel(session, funciones);
                const msg = await interaction.reply({ embeds, components });
                session.messageId = msg.id;
                guardarSubastas(subastas);
                return;
            }

            if (sub === 'objeto') {
                const db = funciones.cargarDB();
                const nombre = interaction.options.getString('nombre');
                const categoria = logic.inferirCategoria(nombre, db);
                session.item.objeto = nombre; session.item.categoria = categoria;
                pushHistorial(session, interaction, `Objeto cambiado a ${nombre}`);
                guardarSubastas(subastas);
                await refrescarTodo(client, funciones);
                return interaction.reply({ content: `✅ Objeto cambiado a **${nombre}** (${categoria}).`, ephemeral: true });
            }

            if (sub === 'interesado') {
                const jugadorRaw = interaction.options.getString('jugador');
                const accion = interaction.options.getString('accion') || 'añadir';

                if (accion === 'quitar') {
                    if (!esLiderUsuario) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });
                    const miembros = funciones.cargarMiembros();
                    const canon = funciones.aplicarCanonico(jugadorRaw, miembros);
                    const idx = session.interesados.findIndex(i => utils.claveJugador(i, miembros) === utils.claveJugador(canon, miembros));
                    if (idx === -1) return interaction.reply({ content: 'ℹ️ No está anotado.', ephemeral: true });
                    session.interesados.splice(idx, 1);
                    pushHistorial(session, interaction, `Quitó a ${canon}`);
                    guardarSubastas(subastas);
                    await refrescarTodo(client, funciones);
                    return interaction.reply({ content: `✅ **${canon}** quitado.`, ephemeral: true });
                }
                return mostrarConfirmacionAgregar(interaction, session, jugadorRaw, funciones);
            }
        }

        // ====== COMANDO /CONTROL ======
        if (interaction.isChatInputCommand() && interaction.commandName === 'control') {
            const sub = interaction.options.getSubcommand();
            if (!esLider(interaction.member, funciones)) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });

            if (sub === 'agregar') {
                const tId = interaction.options.getChannel('canal')?.id || interaction.channelId;
                const fijos = cargarThreadsFijos();
                if (fijos.includes(tId)) return interaction.reply({ content: 'ℹ️ Ya está en la lista.', ephemeral: true });
                fijos.push(tId);
                guardarThreadsFijos(fijos);
                await actualizarControlPanel(client, funciones);
                return interaction.reply({ content: `✅ Thread <#${tId}> fijado.` });
            }
            if (sub === 'quitar') {
                const tId = interaction.options.getChannel('canal').id;
                let fijos = cargarThreadsFijos();
                if (!fijos.includes(tId)) return interaction.reply({ content: 'ℹ️ No está en la lista.', ephemeral: true });
                fijos = fijos.filter(id => id !== tId);
                guardarThreadsFijos(fijos);
                await actualizarControlPanel(client, funciones);
                return interaction.reply({ content: `✅ Thread removido.` });
            }
            if (sub === 'panel') {
                await interaction.deferReply({ ephemeral: true });
                const control = cargarControl();
                let canal = interaction.channel, msg = null;
                if (control.channelId && control.messageId) try { const c = await client.channels.fetch(control.channelId); msg = await c.messages.fetch(control.messageId); canal = c; } catch { msg = null; }
                const embed = new EmbedBuilder().setTitle('🎛️ Panel de Control de Subastas').setDescription('Cargando...').setColor(0x2B2D31);
                if (msg) await msg.edit({ embeds: [embed], components: [] }); else { const nuevo = await canal.send({ embeds: [embed] }); guardarControl({ channelId: canal.id, messageId: nuevo.id }); }
                await actualizarControlPanel(client, funciones);
                return interaction.editReply({ content: '✅ Panel de Control actualizado.' });
            }
        }

        // ====== BOTONES DEL PANEL DE SUBASTA ======
        if (interaction.isButton() && interaction.customId.startsWith('panel_btn:')) {
            const [, accion, sessionId] = interaction.customId.split(':');
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session || session.estado !== 'abierta') return interaction.reply({ content: '❌ Panel cerrado o inexistente.', ephemeral: true });

            const db = funciones.cargarDB();
            const miembros = funciones.cargarMiembros();
            const esLiderUsuario = esLider(interaction.member, funciones);

            if (accion === 'anotarme' || accion === 'retirarme') {
                await interaction.deferReply({ ephemeral: true });
                const nombre = funciones.aplicarCanonico(interaction.member?.displayName || interaction.user.username, miembros);
                const key = utils.claveJugador(nombre, miembros);

                if (accion === 'anotarme') {
                    if (session.interesados.some(i => utils.claveJugador(i, miembros) === key)) return interaction.editReply({ content: 'ℹ️ Ya estás anotado.' });
                    session.interesados.push(nombre);
                    pushHistorial(session, interaction, 'Se anotó');
                } else {
                    const idx = session.interesados.findIndex(i => utils.claveJugador(i, miembros) === key);
                    if (idx === -1) return interaction.editReply({ content: 'ℹ️ No estabas anotado.' });
                    session.interesados.splice(idx, 1);
                    pushHistorial(session, interaction, 'Se retiró');
                }
                guardarSubastas(subastas);
                await refrescarTodo(client, funciones);
                return interaction.editReply({ content: accion === 'anotarme' ? '✅ Te anotaste.' : '✅ Te retiraste.' });
            }

            if (accion === 'prioridad') {
                if (session.interesados.length === 0) return interaction.reply({ content: 'ℹ️ No hay interesados.', ephemeral: true });
                const resultados = session.interesados.map(j => ({ jugador: j, ...funciones.calcularPrioridad(j, session.item.categoria, db.compras, miembros) }));
                resultados.sort(funciones.compararPrioridad);
                
                const pPayload = { categoria: session.item.categoria, jugadores: session.interesados, resultados };
                const id = funciones.guardarPendiente('prioridad-page', pPayload, interaction.user.id);
                pPayload.id = id;
                
                const { content, components } = funciones.renderPrioridad(pPayload, miembros);
                return interaction.reply({ content, components, ephemeral: true });
            }

            if (accion === 'logs') {
                const hist = session.historial.slice(-10).map(h => `- ${new Date(h.timestamp).toLocaleTimeString('es-AR')} - ${h.userName}: ${h.accion}`).join('\n');
                return interaction.reply({ content: `**Últimas modificaciones:**\n${hist || 'Sin registros.'}`, ephemeral: true });
            }

            if (accion === 'historial') {
                // Punto 9: Nuevo botón de Historial
                if (session.interesados.length === 0) return interaction.reply({ content: 'ℹ️ No hay interesados.', ephemeral: true });
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`panel_hist:res:${sessionId}`).setLabel('Resumido').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`panel_hist:det:${sessionId}`).setLabel('Detallado').setStyle(ButtonStyle.Secondary)
                );
                return interaction.reply({ content: 'Elegí el formato del historial:', components: [row], ephemeral: true });
            }

            if (accion === 'editar') {
                const embed = new EmbedBuilder().setTitle('✏️ Editar panel').setDescription('Elegí qué querés editar:');
                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`panel_edit:evento:${sessionId}`).setLabel('Evento').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`panel_edit:cantidad:${sessionId}`).setLabel('Cantidad').setStyle(ButtonStyle.Secondary)
                );
                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`panel_edit:objeto:${sessionId}`).setLabel('Objeto').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`panel_edit:agregar_interesado:${sessionId}`).setLabel('Añadir interesado').setStyle(ButtonStyle.Success)
                );
                if (esLiderUsuario) row2.addComponents(new ButtonBuilder().setCustomId(`panel_edit:quitar_interesado:${sessionId}`).setLabel('Quitar interesado').setStyle(ButtonStyle.Danger));
                return interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
            }

            if (accion === 'registrar') {
                if (!esLiderUsuario) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });
                if (session.interesados.length === 0) return interaction.reply({ content: 'ℹ️ No hay interesados.', ephemeral: true });

                const resultados = session.interesados.map(j => ({ jugador: j, ...funciones.calcularPrioridad(j, session.item.categoria, db.compras, miembros) }));
                resultados.sort(funciones.compararPrioridad);
                const ganadorSugerido = resultados[0].jugador;
                const perdedoresSugeridos = resultados.slice(1).map(r => r.jugador);

                const modal = new ModalBuilder().setCustomId(`panel_modal:registrar:${sessionId}`).setTitle('Registrar resultado');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ganadores').setLabel('Ganadores (coma, usar x2)').setStyle(TextInputStyle.Short).setValue(funciones.aplicarCanonico(ganadorSugerido, miembros)).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('perdedores').setLabel('Perdedores (coma)').setStyle(TextInputStyle.Paragraph).setValue(perdedoresSugeridos.map(p => funciones.aplicarCanonico(p, miembros)).join(', ')).setRequired(false)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cantidad').setLabel('Cantidad total').setStyle(TextInputStyle.Short).setValue(String(session.item.cantidad)).setRequired(true))
                );
                return interaction.showModal(modal);
            }

            if (accion === 'cancelar') {
                if (!esLiderUsuario) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });
                const id = guardarPendientePanel('cancelar_subasta', { sessionId: session.id }, interaction.user.id);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Sí, cancelar y eliminar').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Volver').setStyle(ButtonStyle.Secondary)
                );
                return interaction.reply({ content: '⚠️ **¿Estás seguro de cancelar y eliminar esta subasta?**', components: [row], ephemeral: true });
            }
        }

        // ====== BOTONES DE HISTORIAL ======
        if (interaction.isButton() && interaction.customId.startsWith('panel_hist:')) {
            const [, tipo, sessionId] = interaction.customId.split(':');
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session) return interaction.reply({ content: '❌ Panel inexistente.', ephemeral: true });
            const db = funciones.cargarDB();
            const miembros = funciones.cargarMiembros();

            if (tipo === 'res') {
                const todos = session.interesados.map(j => ({ jugador: j, ...funciones.calcularPrioridad(j, session.item.categoria, db.compras, miembros) }));
                todos.sort(funciones.compararPrioridad);
                
                let compras = db.compras.filter(c => todos.some(t => utils.contarGanador(c.ganadores, t.jugador, miembros) > 0));
                compras.sort((a, b) => b.fecha.localeCompare(a.fecha));
                compras = compras.slice(0, 5);

                let out = `📜 **Últimas 5 compras (todos)**\n\n`;
                if (compras.length === 0) out += 'Sin registros.';
                else {
                    for (const c of compras) {
                        out += `#${c.id} · ${utils.formatearFecha(c.fecha)} · ${c.cantidad}x ${c.objeto} (${c.categoria})\n   🏆 ${c.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ')}\n`;
                    }
                }
                return interaction.update({ content: out, components: [] });
            }

            if (tipo === 'det') {
                const todos = session.interesados.map(j => ({ jugador: j, ...funciones.calcularPrioridad(j, session.item.categoria, db.compras, miembros) }));
                todos.sort(funciones.compararPrioridad);
                
                const rows = [];
                let row = new ActionRowBuilder();
                todos.forEach((t, i) => {
                    const nombre = funciones.aplicarCanonico(t.jugador, miembros);
                    if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
                    row.addComponents(new ButtonBuilder().setCustomId(`panel_hist_p:${sessionId}:${i}`).setLabel(nombre).setStyle(ButtonStyle.Primary));
                });
                rows.push(row);
                return interaction.update({ content: 'Elegí el jugador:', components: rows });
            }
        }

        if (interaction.isButton() && interaction.customId.startsWith('panel_hist_p:')) {
            const [, sessionId, index] = interaction.customId.split(':');
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session) return interaction.reply({ content: '❌ Panel inexistente.', ephemeral: true });
            const db = funciones.cargarDB();
            const miembros = funciones.cargarMiembros();
            
            const todos = session.interesados.map(j => ({ jugador: j, ...funciones.calcularPrioridad(j, session.item.categoria, db.compras, miembros) }));
            todos.sort(funciones.compararPrioridad);
            const t = todos[parseInt(index)];
            if (!t) return interaction.reply({ content: '❌ Jugador inválido.', ephemeral: true });
            
            const nombre = funciones.aplicarCanonico(t.jugador, miembros);
            let comprasJ = db.compras.filter(c => utils.contarGanador(c.ganadores, t.jugador, miembros) > 0).sort((a, b) => b.fecha.localeCompare(a.fecha));
            
            let out = `📜 **${nombre}** (Detallado)\n\n`;
            for (const cat of utils.CATEGORIAS) {
                const filtradas = comprasJ.filter(c => c.categoria === cat).slice(0, 5);
                if (filtradas.length === 0) continue;
                out += `**${cat}** (últimas ${filtradas.length}):\n`;
                for (const c of filtradas) {
                    const n = utils.contarGanador(c.ganadores, t.jugador, miembros);
                    out += `#${c.id} · ${utils.formatearFecha(c.fecha)} · ${n}x ${c.objeto}\n`;
                }
                out += `\n`;
            }
            
            // Volver a los jugadores
            const rows = [];
            let row = new ActionRowBuilder();
            todos.forEach((t, i) => {
                const nom = funciones.aplicarCanonico(t.jugador, miembros);
                if (i > 0 && i % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
                row.addComponents(new ButtonBuilder().setCustomId(`panel_hist_p:${sessionId}:${i}`).setLabel(nom).setStyle(i === parseInt(index) ? ButtonStyle.Success : ButtonStyle.Secondary));
            });
            rows.push(row);
            
            return interaction.update({ content: out, components: rows });
        }

        // ====== MENÚ EDITAR DEL PANEL ======
        if (interaction.isButton() && interaction.customId.startsWith('panel_edit:')) {
            const [, campo, sessionId] = interaction.customId.split(':');
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session || session.estado !== 'abierta') return interaction.reply({ content: '❌ Panel cerrado.', ephemeral: true });
            const esLiderUsuario = esLider(interaction.member, funciones);

            if (campo === 'evento') {
                const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`panel_sel:evento:${sessionId}`).setPlaceholder('Elegir evento').addOptions(EVENTOS_PANEL.map(e => ({ label: e, value: e }))));
                return interaction.reply({ content: 'Elegí evento:', components: [row], ephemeral: true });
            }
            if (campo === 'cantidad') {
                const modal = new ModalBuilder().setCustomId(`panel_modal:cantidad:${sessionId}`).setTitle('Editar cantidad');
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('valor').setLabel('Nueva cantidad').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(session.item.cantidad))));
                return interaction.showModal(modal);
            }
            if (campo === 'objeto') return interaction.reply({ content: 'Para cambiar el objeto usá el comando `/panel objeto` (tocalo para copiar).', ephemeral: true });
            if (campo === 'agregar_interesado') {
                const modal = new ModalBuilder().setCustomId(`panel_modal:agregar_interesado:${sessionId}`).setTitle('Añadir interesado');
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('jugador').setLabel('Nombre(s), separados por coma').setStyle(TextInputStyle.Short).setRequired(true)));
                return interaction.showModal(modal);
            }
            if (campo === 'quitar_interesado') {
                if (!esLiderUsuario) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });
                if (session.interesados.length === 0) return interaction.reply({ content: 'ℹ️ No hay interesados para quitar.', ephemeral: true });
                const opciones = session.interesados.slice(0, 25).map(j => ({ label: funciones.aplicarCanonico(j, funciones.cargarMiembros()), value: j }));
                const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`panel_sel_quitar:${sessionId}`).setPlaceholder('Elegí a quién quitar').addOptions(opciones));
                return interaction.reply({ content: 'Elegí a quién quitar:', components: [row], ephemeral: true });
            }
        }

        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('panel_sel:')) {
            const [, campo, sessionId] = interaction.customId.split(':');
            const valor = interaction.values[0];
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session || session.estado !== 'abierta') return interaction.reply({ content: '❌ Panel cerrado.', ephemeral: true });
            session.item[campo] = valor;
            pushHistorial(session, interaction, `Cambió ${campo} a ${valor}`);
            guardarSubastas(subastas);
            await refrescarTodo(client, funciones);
            return interaction.update({ content: `✅ ${campo} cambiado a **${valor}**.`, components: [] });
        }

        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('panel_sel_quitar:')) {
            const sessionId = interaction.customId.split(':')[1];
            const valor = interaction.values[0];
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session || session.estado !== 'abierta') return interaction.reply({ content: '❌ Panel cerrado.', ephemeral: true });
            if (!esLider(interaction.member, funciones)) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });

            const canon = funciones.aplicarCanonico(valor, funciones.cargarMiembros());
            const id = guardarPendientePanel('quitar_interesado', { sessionId: session.id, jugador: valor }, interaction.user.id);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Sí, quitar').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Volver').setStyle(ButtonStyle.Secondary)
            );
            return interaction.reply({ content: `⚠️ **¿Quitar a ${canon}?**`, components: [row], ephemeral: true });
        }

        // ====== MODALES DEL PANEL ======
        if (interaction.isModalSubmit() && interaction.customId.startsWith('panel_modal:')) {
            const [, tipo, sessionId] = interaction.customId.split(':');
            const subastas = cargarSubastas();
            const session = subastas[sessionId];
            if (!session || session.estado !== 'abierta') return interaction.reply({ content: '❌ Sesión no encontrada.', ephemeral: true });

            if (tipo === 'cantidad') {
                const valor = parseInt(interaction.fields.getTextInputValue('valor'), 10);
                if (isNaN(valor) || valor < 0) return interaction.reply({ content: '❌ Cantidad inválida.', ephemeral: true });
                session.item.cantidad = valor;
                pushHistorial(session, interaction, `Cambió cantidad a ${valor}`);
                guardarSubastas(subastas);
                await refrescarTodo(client, funciones);
                return interaction.reply({ content: `✅ Cantidad cambiada a **${valor}**.`, ephemeral: true });
            }

            if (tipo === 'agregar_interesado') {
                const jugadorRaw = interaction.fields.getTextInputValue('jugador').trim();
                if (!jugadorRaw) return interaction.reply({ content: '❌ Nombre inválido.', ephemeral: true });
                return mostrarConfirmacionAgregar(interaction, session, jugadorRaw, funciones);
            }

            if (tipo === 'registrar') {
                if (!esLider(interaction.member, funciones)) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });
                const miembros = funciones.cargarMiembros();
                const g = interaction.fields.getTextInputValue('ganadores').split(',').map(s => s.trim()).filter(Boolean).map(x => funciones.aplicarCanonico(x, miembros));
                const p = interaction.fields.getTextInputValue('perdedores').split(',').map(s => s.trim()).filter(Boolean).map(x => funciones.aplicarCanonico(x, miembros));
                const cant = parseInt(interaction.fields.getTextInputValue('cantidad'), 10) || session.item.cantidad;

                const id = guardarPendientePanel('registrar_resultado', { sessionId, ganadores: g, perdedores: p, cantidad: cant }, interaction.user.id);
                let txt = `📋 **Confirmar registro**\n\n**Objeto:** ${session.item.objeto}\n**Categoría:** ${session.item.categoria}\n**Evento:** ${session.item.evento}\n**Fecha:** ${session.item.fecha}\n**Cantidad:** ${cant}\n\n🏆 **Ganadores:** ${g.map(x => `**${x}**`).join(', ') || 'nadie'}\n`;
                if (p.length > 0) txt += `💔 **Perdedores:** ${p.join(', ')}\n`;
                txt += `\n¿Confirmás y guardás en el historial?`;

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Confirmar y guardar').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Cancelar').setStyle(ButtonStyle.Danger)
                );
                return interaction.reply({ content: txt, components: [row], ephemeral: true });
            }
        }

        // ====== CONFIRMACIONES DEL PANEL ======
        if (interaction.isButton() && (interaction.customId.startsWith('panel_pending_confirm:') || interaction.customId.startsWith('panel_pending_cancel:'))) {
            const esConfirm = interaction.customId.startsWith('panel_pending_confirm:');
            const id = interaction.customId.replace('panel_pending_confirm:', '').replace('panel_pending_cancel:', '');
            const p = pendingPanel.get(id);
            if (!p) return interaction.update({ content: '❌ La sesión expiró.', components: [] });
            if (p.userId !== interaction.user.id) return interaction.reply({ content: '❌ Solo quien inició la acción puede confirmar.', ephemeral: true });
            if (!esConfirm) { pendingPanel.delete(id); return interaction.update({ content: '❌ Acción cancelada.', components: [] }); }

            try { await interaction.deferUpdate(); } catch {}
            const subastas = cargarSubastas();
            const session = subastas[p.payload.sessionId];
            if (!session || session.estado !== 'abierta') { pendingPanel.delete(id); return interaction.editReply({ content: '❌ El panel ya no está activo.', components: [] }); }
            const miembros = funciones.cargarMiembros();

            if (p.tipo === 'agregar_interesados') {
                const ag = [];
                for (const n of p.payload.nuevos) {
                    if (!session.interesados.some(i => utils.claveJugador(i, miembros) === utils.claveJugador(n, miembros))) {
                        session.interesados.push(n);
                        ag.push(n);
                    }
                }
                if (ag.length > 0) {
                    pushHistorial(session, interaction, `Añadió a ${ag.join(', ')}`);
                    guardarSubastas(subastas);
                    await refrescarTodo(client, funciones);
                }
                pendingPanel.delete(id);
                let txt = `✅ **Agregados:** ${ag.map(n => `**${n}**`).join(', ') || 'ninguno'}`;
                if (p.payload.yaEstaban.length > 0) txt += `\nℹ️ Ya estaban: ${p.payload.yaEstaban.join(', ')}`;
                return interaction.editReply({ content: txt, components: [] });
            }

            if (p.tipo === 'quitar_interesado') {
                const idx = session.interesados.findIndex(i => utils.claveJugador(i, miembros) === utils.claveJugador(p.payload.jugador, miembros));
                if (idx !== -1) {
                    session.interesados.splice(idx, 1);
                    pushHistorial(session, interaction, `Quitó a ${p.payload.jugador}`);
                    guardarSubastas(subastas);
                    await refrescarTodo(client, funciones);
                }
                pendingPanel.delete(id);
                return interaction.editReply({ content: `✅ **${funciones.aplicarCanonico(p.payload.jugador, miembros)}** quitado.`, components: [] });
            }

            if (p.tipo === 'registrar_resultado') {
                const db = funciones.cargarDB();
                const entrada = { id: db.nextId++, fecha: session.item.fecha, evento: session.item.evento, categoria: session.item.categoria, objeto: session.item.objeto, cantidad: p.payload.cantidad, ganadores: p.payload.ganadores, perdedores: p.payload.perdedores, notas: '' };
                db.compras.push(entrada);
                funciones.guardarDB(db);
                const syncRes = await funciones.sincronizarConGitHub(false);

                session.estado = 'cerrada';
                pushHistorial(session, interaction, 'Registró resultado');
                guardarSubastas(subastas);
                const archivadas = cargarArchivadas(); archivadas[session.id] = session; guardarArchivadas(archivadas);
                delete subastas[session.id]; guardarSubastas(subastas);
                
                await refrescarTodo(client, funciones);

                let msg = `✅ Resultado registrado: #${entrada.id} · ${entrada.cantidad}x ${entrada.objeto} (${entrada.categoria})\n🏆 ${entrada.ganadores.map(g => funciones.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}`;
                if (entrada.perdedores.length > 0) msg += `\n💔 ${entrada.perdedores.map(g => funciones.formatearNombreConCantidad(g, miembros)).join(', ')}`;
                if (!syncRes.ok) msg += `\n⚠️ Sync falló: ${syncRes.motivo}`;

                pendingPanel.delete(id);
                await interaction.editReply({ content: '✅ Acción completada.', components: [] });
                await interaction.followUp({ content: msg, ephemeral: false });
                
                // Preguntar por ping
                if (entrada.ganadores.length > 0) {
                    const members = await interaction.guild.members.fetch();
                    const menciones = entrada.ganadores.map(g => {
                        const member = members.find(m => utils.normalizar(m.user.username) === utils.normalizar(g) || utils.normalizar(m.displayName) === utils.normalizar(g) || utils.normalizar(funciones.aplicarCanonico(m.displayName, miembros)) === utils.normalizar(g));
                        return member ? `<@${member.id}>` : `**${g}**`;
                    });
                    const pingId = funciones.guardarPendiente('ping', { menciones, mensajeBase: `✅ Registro guardado.` }, interaction.user.id);
                    const rowPing = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`ping_confirm_${pingId}`).setLabel('Sí, pingear').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`ping_cancel_${pingId}`).setLabel('No, gracias').setStyle(ButtonStyle.Secondary)
                    );
                    await interaction.followUp({ content: '🔔 ¿Querés avisar a los ganadores?', components: [rowPing], ephemeral: true });
                }
                return;
            }

            if (p.tipo === 'cancelar_subasta') {
                session.estado = 'cancelada';
                pushHistorial(session, interaction, 'Subasta cancelada y eliminada');
                guardarSubastas(subastas);
                const archivadas = cargarArchivadas(); archivadas[session.id] = session; guardarArchivadas(archivadas);
                delete subastas[session.id]; guardarSubastas(subastas);
                
                // Punto 2: Eliminar el mensaje del panel
                try {
                    const canal = await client.channels.fetch(session.channelId);
                    const msg = await canal.messages.fetch(session.messageId);
                    await msg.delete();
                } catch (e) { /* ignorar si ya no existe */ }

                await refrescarTodo(client, funciones);
                pendingPanel.delete(id);
                return interaction.editReply({ content: '🗑️ Subasta cancelada, panel eliminado y archivada sin registrar.', components: [] });
            }
        }

        // ====== BOTONES DEL PANEL DE CONTROL ======
        if (interaction.isButton() && interaction.customId.startsWith('control_btn:')) {
            if (!esLider(interaction.member, funciones)) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });
            const partes = interaction.customId.split(':');
            const accion = partes[1];
            const threadId = partes[2];

            if (accion === 'abrir') {
                const modal = new ModalBuilder().setCustomId(`control_modal:abrir:${threadId}`).setTitle('Abrir Subasta');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('objeto').setLabel('Objeto').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cantidad').setLabel('Cantidad').setStyle(TextInputStyle.Short).setRequired(true))
                );
                return interaction.showModal(modal);
            }

            if (accion === 'cerrar') {
                const subastas = cargarSubastas();
                const session = Object.values(subastas).find(s => s.threadId === threadId && s.estado === 'abierta');
                if (!session) return interaction.reply({ content: '❌ No hay subasta activa en ese thread.', ephemeral: true });
                const id = guardarPendientePanel('control_cancelar_subasta', { sessionId: session.id }, interaction.user.id);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`control_pending_confirm:${id}`).setLabel('Sí, cerrar').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`control_pending_cancel:${id}`).setLabel('Volver').setStyle(ButtonStyle.Secondary)
                );
                return interaction.reply({ content: `⚠️ **¿Cancelar subasta de <#${threadId}>?**`, components: [row], ephemeral: true });
            }

            if (accion === 'abrir_todos' || accion === 'cerrar_todos') {
                const modal = new ModalBuilder().setCustomId(`control_modal:${accion}`).setTitle(accion === 'abrir_todos' ? 'Abrir Todas las Subastas' : 'Cerrar Todas las Subastas');
                if (accion === 'abrir_todos') {
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('objeto').setLabel('Objeto para todas').setStyle(TextInputStyle.Short).setRequired(true)),
                        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cantidad').setLabel('Cantidad por thread').setStyle(TextInputStyle.Short).setRequired(true))
                    );
                } else {
                    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('confirmar').setLabel('Escribí "CONFIRMAR" para cerrar todas').setStyle(TextInputStyle.Short).setRequired(true)));
                }
                return interaction.showModal(modal);
            }
        }

        // ====== MODALES DEL CONTROL ======
        if (interaction.isModalSubmit() && interaction.customId.startsWith('control_modal:')) {
            if (!esLider(interaction.member, funciones)) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });
            const partes = interaction.customId.split(':');
            const accion = partes[1];
            const threadId = partes[2];

            if (accion === 'abrir') {
                await interaction.deferReply({ ephemeral: true });
                const objeto = interaction.fields.getTextInputValue('objeto');
                const cant = parseInt(interaction.fields.getTextInputValue('cantidad'), 10);
                const db = funciones.cargarDB();
                const cat = logic.inferirCategoria(objeto, db);
                const ev = obtenerEventoPorHora();
                const f = funciones.fechaHoyArgentina();

                const subastas = cargarSubastas();
                if (Object.values(subastas).find(s => s.threadId === threadId && s.estado === 'abierta')) return interaction.editReply({ content: '❌ Ese thread ya tiene subasta.' });

                const session = {
                    id: generarId(), threadId, channelId: threadId, messageId: null,
                    item: { fecha: f, evento: ev, categoria: cat, objeto, cantidad: cant },
                    interesados: [], estado: 'abierta', historial: [], creadoPor: interaction.user.id, createdAt: Date.now()
                };
                pushHistorial(session, interaction, 'Panel creado por Control');
                subastas[session.id] = session;
                guardarSubastas(subastas);

                const canal = await client.channels.fetch(threadId);
                const { embeds, components } = renderPanel(session, funciones);
                const msg = await canal.send({ embeds, components });
                session.messageId = msg.id;
                guardarSubastas(subastas);
                await refrescarTodo(client, funciones);
                return interaction.editReply({ content: `✅ Subasta abierta en <#${threadId}>.` });
            }

            if (accion === 'cerrar_todos') {
                if (interaction.fields.getTextInputValue('confirmar').toUpperCase() !== 'CONFIRMAR') return interaction.reply({ content: '❌ No confirmaste.', ephemeral: true });
                await interaction.deferReply({ ephemeral: true });
                const subastas = cargarSubastas();
                const archivadas = cargarArchivadas();
                let cerradas = 0;
                for (const id in subastas) {
                    if (subastas[id].estado === 'abierta') {
                        subastas[id].estado = 'cancelada';
                        pushHistorial(subastas[id], interaction, 'Cancelada por Control Global');
                        archivadas[id] = subastas[id];
                        
                        try {
                            const canal = await client.channels.fetch(subastas[id].channelId);
                            const msg = await canal.messages.fetch(subastas[id].messageId);
                            await msg.delete();
                        } catch (e) { /* ignorar */ }

                        delete subastas[id];
                        cerradas++;
                    }
                }
                guardarSubastas(subastas); guardarArchivadas(archivadas);
                await refrescarTodo(client, funciones);
                return interaction.editReply({ content: `✅ Se cancelaron y eliminaron **${cerradas}** subastas.` });
            }

            if (accion === 'abrir_todos') {
                await interaction.deferReply({ ephemeral: true });
                const objeto = interaction.fields.getTextInputValue('objeto');
                const cant = parseInt(interaction.fields.getTextInputValue('cantidad'), 10);
                const db = funciones.cargarDB();
                const cat = logic.inferirCategoria(objeto, db);
                const ev = obtenerEventoPorHora();
                const f = funciones.fechaHoyArgentina();
                const fijos = cargarThreadsFijos();
                const subastas = cargarSubastas();
                let abiertas = 0;

                for (const tId of fijos) {
                    if (Object.values(subastas).find(s => s.threadId === tId && s.estado === 'abierta')) continue;
                    const session = {
                        id: generarId(), threadId: tId, channelId: tId, messageId: null,
                        item: { fecha: f, evento: ev, categoria: cat, objeto, cantidad: cant },
                        interesados: [], estado: 'abierta', historial: [], creadoPor: interaction.user.id, createdAt: Date.now()
                    };
                    pushHistorial(session, interaction, 'Panel creado por Control Global');
                    subastas[session.id] = session;
                    try {
                        const canal = await client.channels.fetch(tId);
                        const { embeds, components } = renderPanel(session, funciones);
                        const msg = await canal.send({ embeds, components });
                        session.messageId = msg.id;
                        abiertas++;
                    } catch (e) { console.error(e); }
                }
                guardarSubastas(subastas);
                await refrescarTodo(client, funciones);
                return interaction.editReply({ content: `✅ Se abrieron **${abiertas}** subastas en los threads fijos.` });
            }
        }
    });
}

module.exports = { setupPanel };
