const fs = require('fs');
const path = require('path');
const {
    Events,
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

const DATA_DIR = path.join(__dirname, 'data');
const SUBASTAS_FILE = path.join(DATA_DIR, 'subastas_activas.json');
const ARCHIVADAS_FILE = path.join(DATA_DIR, 'subastas_archivadas.json');
const INDICE_FILE = path.join(DATA_DIR, 'indice.json');
const CONTROL_FILE = path.join(DATA_DIR, 'control.json');
const THREADS_FILE = path.join(DATA_DIR, 'threads_fijos.json');
const BOSS_CONFIG_FILE = path.join(DATA_DIR, 'control_boss_config.json');
const DADOS_PENDIENTES_FILE = path.join(DATA_DIR, 'dados_pendientes.json');

const CATEGORIAS_PANEL = ['Cajas 20k', 'Emblemas Generales', 'Emblemas Únicos', 'Equipo', 'Accesorios', 'Sin Categoría', 'Azules', 'Box 10k'];
const EVENTOS_PANEL = ['Invasión diurna', 'Invasión nocturna', 'Banquete'];

const pendingPanel = new Map();
let refrescandoPaneles = false;
let procesandoPaneles = false;

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
function cargarThreadsFijos() {
    const raw = cargarJSON(THREADS_FILE, []);
    return raw.map(item => {
        if (typeof item === 'string') return { id: item, nombre: null, objeto: null, categoria: null };
        return item;
    });
}
function guardarThreadsFijos(d) { guardarJSON(THREADS_FILE, d); }
function generarId() { return Math.random().toString(36).slice(2, 10); }

function esThreadBoss(threadId) {
    if (!fs.existsSync(BOSS_CONFIG_FILE)) return false;
    try {
        const config = JSON.parse(fs.readFileSync(BOSS_CONFIG_FILE, 'utf8'));
        return config.slots.some(s => s.threadId === threadId);
    } catch { return false; }
}

async function publicarBossConfig(config) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    if (!token || !repo) return;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const url = `https://api.github.com/repos/${repo}/contents/data/control_boss_config.json`;

    try {
        let sha = null;
        const rGet = await fetch(`${url}?ref=${branch}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'bot-subastas' }
        });
        if (rGet.ok) {
            const data = await rGet.json();
            sha = data.sha;
        }

        const body = {
            message: 'Limpiar threadId de slot boss',
            content: Buffer.from(JSON.stringify(config, null, 2)).toString('base64'),
            branch
        };
        if (sha) body.sha = sha;

        await fetch(url, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'User-Agent': 'bot-subastas'
            },
            body: JSON.stringify(body)
        });
    } catch (e) {
        console.error('Error publicando control_boss_config.json:', e.message);
    }
}

async function limpiarSlotBossPorThread(threadId, client) {
    if (!threadId) return false;

    const config = cargarJSON(BOSS_CONFIG_FILE, { canalAnunciosId: null, slots: [] });
    if (!Array.isArray(config.slots)) return false;

    let cambiado = false;
    for (const s of config.slots) {
        if (s.threadId === threadId) {
            s.threadId = null;
            cambiado = true;
        }
    }

    if (!cambiado) return false;

    guardarJSON(BOSS_CONFIG_FILE, config);
    await publicarBossConfig(config);

    try {
        const { actualizarPanelControlBoss } = require('./control-boss');
        if (typeof actualizarPanelControlBoss === 'function') await actualizarPanelControlBoss(client);
    } catch (e) { /* ignorar si control-boss no está cargado */ }

    return true;
}

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

function aplicarDadosPendientes(session) {
    if (!fs.existsSync(DADOS_PENDIENTES_FILE)) return;
    let pendientes = [];
    try { pendientes = JSON.parse(fs.readFileSync(DADOS_PENDIENTES_FILE, 'utf8')); } catch { return; }

    const ahora = Date.now();
    const diezMinutos = 10 * 60 * 1000;
    let huboCambios = false;
    const restantes = [];

    if (!session.dados) session.dados = {};

    for (const p of pendientes) {
        if (p.threadId === session.threadId && p.expiraEn > ahora) {
            if (p.creadoEn && (ahora - p.creadoEn > diezMinutos)) {
                huboCambios = true;
                continue;
            }

            if (!session.dados[p.nombre]) {
                session.dados[p.nombre] = { historial: [], propio: p.propio };
            }
            session.dados[p.nombre].historial.push(p.valor);
            session.dados[p.nombre].propio = p.propio;
            huboCambios = true;
        } else if (p.expiraEn > ahora) {
            restantes.push(p);
        } else {
            huboCambios = true;
        }
    }

    if (huboCambios) {
        fs.writeFileSync(DADOS_PENDIENTES_FILE, JSON.stringify(restantes, null, 2));
    }
}

function renderPanel(session, funciones) {
    const item = session.item;
    const miembros = funciones.cargarMiembros();
    const icon = utils.ICONOS[item.categoria] || '❓';

    const dados = session.dados || {};
    const conDado = [];
    const sinDado = [];

    session.interesados.forEach((nombre, index) => {
        const infoDado = dados[nombre];
        if (infoDado && infoDado.historial && infoDado.historial.length > 0) {
            const valorMasReciente = infoDado.historial[infoDado.historial.length - 1];
            conDado.push({ nombre, valor: valorMasReciente, historial: infoDado.historial, index });
        } else if (infoDado && infoDado.valor) {
            conDado.push({ nombre, valor: infoDado.valor, historial: [infoDado.valor], index });
        } else {
            sinDado.push({ nombre, index });
        }
    });

    conDado.sort((a, b) => b.valor - a.valor || a.index - b.index);
    const interesadosOrdenados = [...conDado, ...sinDado].map(obj => {
        const nombreCanon = funciones.aplicarCanonico(obj.nombre, miembros);
        if (obj.historial && obj.historial.length > 0) {
            const ultimos = obj.historial.slice(-3);
            const histStr = ultimos.map((v, i) => i === ultimos.length - 1 ? `🎲 ${v}` : v).join(' → ');
            return `• ${nombreCanon} ( ${histStr} )`;
        }
        return `• ${nombreCanon}`;
    });

    let title = `${icon} ${item.cantidad}x ${item.objeto}`;
    const embed = new EmbedBuilder()
        .setDescription(`**Event:** ${item.evento}\n**Category:** ${item.categoria}\n**Amount:** ${item.cantidad}\n**Date:** ${item.fecha}`)
        .addFields({
            name: `Interested (${session.interesados.length})`,
            value: interesadosOrdenados.length ? interesadosOrdenados.join('\n') : 'No one yet'
        });

    const cerrada = session.estado === 'cerrada';
    const bloqueada = session.estado === 'bloqueada';

    if (cerrada) {
        embed.setTitle(`${icon} ${item.cantidad}x ${item.objeto} ( ✅ Registered )`);
        embed.setColor(0x95A5A6);
        const regPor = session.registradoPor || 'Leader';
        const regFecha = session.fechaRegistro ? new Date(session.fechaRegistro).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) : 'Recent';
        embed.setFooter({ text: `Auction registered by ${regPor} on ${regFecha}` });
    } else {
        if (bloqueada) {
            embed.setTitle(`${icon} ${item.cantidad}x ${item.objeto} (🔒 Locked )`);
            embed.setColor(0xFF0000);
        } else {
            embed.setTitle(title);
            if (session.interesados.length > item.cantidad) {
                embed.setColor(0xFFCF00);
            } else {
                embed.setColor(0x00FF00);
            }
        }

        const ultimo = session.historial[session.historial.length - 1];
        if (ultimo) embed.setFooter({ text: `Last mod: ${ultimo.userName} - ${new Date(ultimo.timestamp).toLocaleTimeString('en-US')}` });
    }

    if (cerrada) {
        return { embeds: [embed], components: [] };
    }

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel_btn:anotarme:${session.id}`).setLabel('Join Auction').setStyle(ButtonStyle.Success).setDisabled(bloqueada),
        new ButtonBuilder().setCustomId(`panel_btn:retirarme:${session.id}`).setLabel('Leave').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`panel_btn:bloquear:${session.id}`).setEmoji(bloqueada ? '🔒' : '🔓').setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel_btn:prioridad:${session.id}`).setLabel('Calcular prioridad').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`panel_btn:historial:${session.id}`).setLabel('Ver historial').setStyle(ButtonStyle.Primary)
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel_btn:editar:${session.id}`).setLabel('Editar').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`panel_btn:logs:${session.id}`).setLabel('Logs').setStyle(ButtonStyle.Secondary)
    );

    const row4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel_btn:registrar:${session.id}`).setLabel('Registrar resultado').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`panel_btn:cancelar:${session.id}`).setLabel('Cancelar subasta').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row1, row2, row3, row4] };
}

async function actualizarMensajePanel(client, session, funciones) {
    if (!session.messageId || !session.channelId) return;
    try {
        const canal = await client.channels.fetch(session.channelId);
        const msg = await canal.messages.fetch(session.messageId);
        const { embeds, components } = renderPanel(session, funciones);
        await msg.edit({ embeds, components });
    } catch (e) {
        if (e.code === 10008) {
            const subastas = cargarSubastas();
            const actual = subastas[session.id];
            if (actual && actual.messageId && actual.messageId !== session.messageId) {
                session.messageId = actual.messageId;
                return;
            }

            console.log(`[Panel] Mensaje no encontrado en <#${session.threadId}>. Recreando...`);
            try {
                const canal = await client.channels.fetch(session.channelId);
                const { embeds, components } = renderPanel(session, funciones);
                const nuevo = await canal.send({ embeds, components });
                session.messageId = nuevo.id;
                const subastas2 = cargarSubastas();
                subastas2[session.id] = session;
                guardarSubastas(subastas2);
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
        const activas = Object.values(subastas).filter(s => s.estado === 'abierta' || s.estado === 'bloqueada');

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

        let desc = 'Referencia: (interesados / unidades)\n\n';
        if (fijos.length === 0) {
            desc += 'No hay threads fijos configurados.';
        } else {
            fijos.slice(0, 16).forEach((fijo, i) => {
                const session = Object.values(subastas).find(s => s.threadId === fijo.id && (s.estado === 'abierta' || s.estado === 'bloqueada'));
                let estado = '';
                if (session) {
                    estado = `🟢 Activo — (${session.interesados.length}/${session.item.cantidad})`;
                } else {
                    estado = '🔴 Cerrado';
                }
                desc += `• **[${i + 1}]** <#${fijo.id}> — ${estado}\n`;
            });
        }

        const embed = new EmbedBuilder().setTitle('🎛️ Panel de Control de Invasión').setDescription(desc).setColor(0x2B2D31);

        const rows = [];
        const chunks = fijos.slice(0, 16);
        for (let i = 0; i < chunks.length; i += 4) {
            const row = new ActionRowBuilder();
            for (let j = 0; j < 4 && i + j < chunks.length; j++) {
                const idx = i + j;
                const fijo = chunks[idx];
                const session = Object.values(subastas).find(s => s.threadId === fijo.id && (s.estado === 'abierta' || s.estado === 'bloqueada'));
                const label = `${session ? 'Cerrar' : 'Abrir'} ${idx + 1}`;
                const style = session ? ButtonStyle.Danger : ButtonStyle.Success;
                const action = session ? 'cerrar' : 'abrir';
                row.addComponents(new ButtonBuilder().setCustomId(`control_btn:${action}:${fijo.id}`).setLabel(label).setStyle(style));
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
    if (procesandoPaneles) return 0;
    procesandoPaneles = true;
    try {
        const subastas = cargarSubastas();
        let actualizadas = 0;
        for (const id in subastas) {
            if (subastas[id].estado === 'abierta' || subastas[id].estado === 'bloqueada') {
                await actualizarMensajePanel(client, subastas[id], funciones);
                actualizadas++;
            }
        }
        await actualizarIndice(client, funciones);
        await actualizarControlPanel(client, funciones);
        return actualizadas;
    } catch (e) {
        console.error('Error en refrescarTodo:', e.message);
        return 0;
    } finally {
        procesandoPaneles = false;
    }
}

async function moverPanelesAlFinal(client, funciones) {
    if (procesandoPaneles) return 0;
    procesandoPaneles = true;

    const subastas = cargarSubastas();
    let movidos = 0;

    try {
        for (const id in subastas) {
            const session = subastas[id];
            if (!session || (session.estado !== 'abierta' && session.estado !== 'bloqueada') || !session.channelId) continue;

            try {
                const canal = await client.channels.fetch(session.channelId);
                if (!canal) continue;

                const mensajes = await canal.messages.fetch({ limit: 1 });
                const ultimo = mensajes.first();

                if (ultimo && ultimo.id === session.messageId) continue;

                const viejoId = session.messageId;
                const { embeds, components } = renderPanel(session, funciones);
                const nuevo = await canal.send({ embeds, components });

                session.messageId = nuevo.id;
                subastas[id] = session;
                guardarSubastas(subastas);

                if (viejoId) {
                    try {
                        const viejo = await canal.messages.fetch(viejoId);
                        if (viejo) await viejo.delete();
                    } catch (e) { /* ignorar si ya no existe */ }
                }

                movidos++;
            } catch (e) {
                console.error(`[Panel] Error moviendo panel de <#${session.threadId}>:`, e.message);
            }
        }
    } finally {
        procesandoPaneles = false;
    }

    return movidos;
}

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
    let txt = '';
    if (session.estado === 'bloqueada') {
        txt += `⚠️ **ATENCIÓN: La subasta está BLOQUEADA.**\n¿Estás seguro? Otro líder podría estar registrando los ganadores.\n\n`;
    }
    txt += `📋 **Confirmar agregar**\n\n**Se agregarán:** ${nuevos.map(n => `**${n}**`).join(', ')}\n`;
    if (yaEstaban.length > 0) txt += `**Ya estaban:** ${yaEstaban.join(', ')}\n\n¿Confirmás?`;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Confirmar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Cancelar').setStyle(ButtonStyle.Danger)
    );
    return interaction.reply({ content: txt, components: [row], ephemeral: true });
}

async function crearPanelEnThread(client, thread, item, funciones, creadoPor) {
    const subastas = cargarSubastas();
    const threadId = thread.id;

    if (Object.values(subastas).find(s => s.threadId === threadId && (s.estado === 'abierta' || s.estado === 'bloqueada'))) return null;

    const session = {
        id: generarId(),
        threadId,
        channelId: thread.id,
        messageId: null,
        threadName: thread.name,
        item: {
            fecha: item.fecha,
            evento: item.evento,
            categoria: item.categoria,
            objeto: item.objeto,
            cantidad: item.cantidad
        },
        interesados: [],
        dados: {},
        estado: 'abierta',
        historial: [{ timestamp: Date.now(), userId: creadoPor, userName: 'Sistema', accion: 'Panel creado por anuncio' }],
        creadoPor,
        createdAt: Date.now()
    };

    aplicarDadosPendientes(session);

    subastas[session.id] = session;
    guardarSubastas(subastas);

    const { embeds, components } = renderPanel(session, funciones);
    const msg = await thread.send({ embeds, components });
    session.messageId = msg.id;
    guardarSubastas(subastas);

    await refrescarTodo(client, funciones);
    return session;
}

function setupPanel(client, funciones) {
    setInterval(async () => {
        if (refrescandoPaneles) return;
        refrescandoPaneles = true;
        try {
            await refrescarTodo(client, funciones);
        } finally {
            refrescandoPaneles = false;
        }
    }, 60 * 1000);

    setInterval(async () => {
        await moverPanelesAlFinal(client, funciones);
    }, 2 * 60 * 1000);

    client.on(Events.ThreadDelete, async (thread) => {
        try {
            await limpiarSlotBossPorThread(thread.id, client);

            const subastas = cargarSubastas();
            let cambios = false;
            for (const id in subastas) {
                if (subastas[id].threadId === thread.id && (subastas[id].estado === 'abierta' || subastas[id].estado === 'bloqueada')) {
                    subastas[id].estado = 'cancelada';
                    subastas[id].historial.push({
                        timestamp: Date.now(),
                        userId: 'sistema',
                        userName: 'Sistema',
                        accion: 'Thread eliminado, subasta cancelada automáticamente'
                    });
                    const archivadas = cargarArchivadas();
                    archivadas[id] = subastas[id];
                    guardarArchivadas(archivadas);
                    delete subastas[id];
                    cambios = true;
                }
            }
            if (cambios) {
                guardarSubastas(subastas);
                await actualizarIndice(client, funciones);
                await actualizarControlPanel(client, funciones);
                try {
                    const { actualizarPanelControlBoss } = require('./control-boss');
                    await actualizarPanelControlBoss(client);
                } catch(e) { /* ignorar si control-boss no está cargado */ }
            }
        } catch(e) { console.error('Error ThreadDelete:', e.message); }
    });

    client.on('interactionCreate', async (interaction) => {
        try {
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

            if (interaction.isAutocomplete() && interaction.commandName === 'control') {
                const focused = interaction.options.getFocused(true);
                if (focused.name === 'objeto') {
                    const db = funciones.cargarDB();
                    const objetos = funciones.obtenerObjetosUnicos(db);
                    const q = funciones.normalizar(focused.value);
                    return interaction.respond(objetos.filter(n => funciones.normalizar(n).includes(q)).slice(0, 25).map(n => ({ name: n, value: n })));
                }
                return;
            }

            if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
                const sub = interaction.options.getSubcommand();
                const subastas = cargarSubastas();
                const esLiderUsuario = esLider(interaction.member, funciones);

                if (sub === 'refresh') {
                    if (refrescandoPaneles) return interaction.reply({ content: '⏳ Ya hay un refresco en curso.', ephemeral: true });
                    refrescandoPaneles = true;
                    try {
                        await interaction.deferReply({ ephemeral: true });
                        const cant = await refrescarTodo(client, funciones);
                        const movidos = await moverPanelesAlFinal(client, funciones);
                        return interaction.editReply({ content: `✅ Refrescados **${cant}** paneles activos. Movidos al final: **${movidos}**.` });
                    } finally {
                        refrescandoPaneles = false;
                    }
                }

                if (sub === 'crear') {
                    await interaction.deferReply();
                    if (!interaction.channel.isThread()) return interaction.editReply({ content: '❌ Solo funciona en threads.' });
                    const threadId = interaction.channelId;
                    if (Object.values(subastas).find(s => s.threadId === threadId && (s.estado === 'abierta' || s.estado === 'bloqueada'))) return interaction.editReply({ content: '❌ Ya hay panel activo acá.' });

                    const db = funciones.cargarDB();
                    const objeto = interaction.options.getString('objeto');
                    const categoria = logic.inferirCategoria(objeto, db);
                    const cantidad = interaction.options.getInteger('cantidad');
                    const evento = interaction.options.getString('evento') || obtenerEventoPorHora();
                    const fecha = funciones.fechaHoyArgentina();
                    const threadName = interaction.channel.name;

                    const session = {
                        id: generarId(), threadId, channelId: interaction.channelId, messageId: null, threadName,
                        item: { fecha, evento, categoria, objeto, cantidad },
                        interesados: [], dados: {}, estado: 'abierta', historial: [], creadoPor: interaction.user.id, createdAt: Date.now()
                    };

                    aplicarDadosPendientes(session);

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
                    if (!esLiderUsuario) return interaction.reply({ content: '❌ Only leaders/staff.', ephemeral: true });
                    if (!interaction.channel.isThread()) return interaction.reply({ content: '❌ Only in threads.', ephemeral: true });
                    const session = Object.values(subastas).find(s => s.threadId === interaction.channelId && (s.estado === 'abierta' || s.estado === 'bloqueada'));
                    if (!session) return interaction.reply({ content: '❌ No hay panel activo.', ephemeral: true });

                    const id = guardarPendientePanel('cancelar_subasta', { sessionId: session.id }, interaction.user.id);
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Sí, cancelar y eliminar').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Volver').setStyle(ButtonStyle.Secondary)
                    );
                    return interaction.reply({ content: '⚠️ **¿Cancelar esta subasta y eliminar el panel?**', components: [row], ephemeral: true });
                }

                if (!interaction.channel.isThread()) return interaction.reply({ content: '❌ Only in threads.', ephemeral: true });
                const session = Object.values(subastas).find(s => s.threadId === interaction.channelId && (s.estado === 'abierta' || s.estado === 'bloqueada'));
                if (!session) return interaction.reply({ content: '❌ No hay panel activo.', ephemeral: true });

                if (sub === 'ver') {
                    if (session.messageId) {
                        try {
                            const canal = await client.channels.fetch(session.channelId);
                            const oldMsg = await canal.messages.fetch(session.messageId);
                            await oldMsg.delete();
                        } catch (e) { /* ignorar si ya no existe */ }
                    }
                    const { embeds, components } = renderPanel(session, funciones);
                    const msg = await interaction.reply({ embeds, components, fetchReply: true });
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

                    if (accion === 'añadir' && session.estado === 'bloqueada' && !esLiderUsuario) {
                        return interaction.reply({ content: '❌ The auction is locked. You cant join.', ephemeral: true });
                    }

                    if (accion === 'quitar') {
                        if (!esLiderUsuario) return interaction.reply({ content: '❌ Only leaders/staff.', ephemeral: true });
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

            if (interaction.isChatInputCommand() && interaction.commandName === 'control') {
                const sub = interaction.options.getSubcommand();
                if (!esLider(interaction.member, funciones)) return interaction.reply({ content: '❌ Only leaders/staff.', ephemeral: true });

                if (sub === 'agregar') {
                    const tId = interaction.options.getChannel('canal')?.id || interaction.channelId;
                    const objeto = interaction.options.getString('objeto') || null;
                    const categoria = interaction.options.getString('categoria') || null;
                    let fijos = cargarThreadsFijos();
                    if (fijos.some(f => f.id === tId)) return interaction.reply({ content: 'ℹ️ Ya está en la lista.', ephemeral: true });

                    let nombre = `Thread ${tId.slice(-4)}`;
                    try { const ch = await client.channels.fetch(tId); if (ch && ch.name) nombre = ch.name; } catch {}

                    fijos.push({ id: tId, nombre, objeto, categoria });
                    guardarThreadsFijos(fijos);
                    await actualizarControlPanel(client, funciones);
                    return interaction.reply({ content: `✅ Thread <#${tId}> fijado.` });
                }
                if (sub === 'quitar') {
                    const tId = interaction.options.getChannel('canal')?.id || interaction.channelId;
                    let fijos = cargarThreadsFijos();
                    if (!fijos.some(f => f.id === tId)) return interaction.reply({ content: 'ℹ️ No está en la lista.', ephemeral: true });
                    fijos = fijos.filter(f => f.id !== tId);
                    guardarThreadsFijos(fijos);
                    await actualizarControlPanel(client, funciones);
                    return interaction.reply({ content: `✅ Thread removido.` });
                }
                if (sub === 'panel') {
                    await interaction.deferReply({ ephemeral: true });
                    const control = cargarControl();
                    let canal = interaction.channel, msg = null;
                    if (control.channelId && control.messageId) try { const c = await client.channels.fetch(control.channelId); msg = await c.messages.fetch(control.messageId); canal = c; } catch { msg = null; }
                    const embed = new EmbedBuilder().setTitle('🎛️ Panel de Control de Invasión').setDescription('Cargando...').setColor(0x2B2D31);
                    if (msg) await msg.edit({ embeds: [embed], components: [] }); else { const nuevo = await canal.send({ embeds: [embed] }); guardarControl({ channelId: canal.id, messageId: nuevo.id }); }
                    await actualizarControlPanel(client, funciones);
                    return interaction.editReply({ content: '✅ Panel de Control de Invasión actualizado.' });
                }
            }

            if (interaction.isButton() && interaction.customId.startsWith('panel_btn:')) {
                const [, accion, sessionId] = interaction.customId.split(':');
                const subastas = cargarSubastas();
                const session = subastas[sessionId];
                if (!session || (session.estado !== 'abierta' && session.estado !== 'bloqueada')) return interaction.reply({ content: '❌ Panel cerrado o inexistente.', ephemeral: true });

                const db = funciones.cargarDB();
                const miembros = funciones.cargarMiembros();
                const esLiderUsuario = esLider(interaction.member, funciones);

                if (accion === 'bloquear') {
                    if (!esLiderUsuario) return interaction.reply({ content: '❌ Only leaders/staff can lock the auction.', ephemeral: true });
                    session.estado = session.estado === 'abierta' ? 'bloqueada' : 'abierta';
                    pushHistorial(session, interaction, session.estado === 'abierta' ? 'Subasta desbloqueada' : 'Subasta bloqueada');
                    guardarSubastas(subastas);
                    await actualizarMensajePanel(client, session, funciones);
                    return interaction.reply({ content: session.estado === 'abierta' ? '✅ Subasta desbloqueada.' : '🔒 Subasta bloqueada.', ephemeral: true });
                }

                if (accion === 'anotarme' || accion === 'retirarme') {
                    if (session.estado === 'bloqueada' && accion === 'anotarme') return interaction.reply({ content: '❌ The auction is locked.', ephemeral: true });

                    await interaction.deferReply({ ephemeral: true });
                    const nombre = funciones.aplicarCanonico(interaction.member?.displayName || interaction.user.username, miembros);
                    const key = utils.claveJugador(nombre, miembros);

                    if (accion === 'anotarme') {
                        if (session.interesados.some(i => utils.claveJugador(i, miembros) === key)) return interaction.editReply({ content: 'ℹ️ You have already joined.' });
                        session.interesados.push(nombre);
                        pushHistorial(session, interaction, 'Se anotó');
                    } else {
                        const idx = session.interesados.findIndex(i => utils.claveJugador(i, miembros) === key);
                        if (idx === -1) return interaction.editReply({ content: "ℹ️ You haven't joined this auction." });
                        session.interesados.splice(idx, 1);
                        pushHistorial(session, interaction, 'Se retiró');
                    }
                    guardarSubastas(subastas);
                    await refrescarTodo(client, funciones);
                    return interaction.editReply({ content: accion === 'anotarme' ? '✅ You joined.' : '⬅️ You left.' });
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
                    if (session.interesados.length === 0) return interaction.reply({ content: 'ℹ️ No hay interesados.', ephemeral: true });
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`panel_hist:res:${sessionId}:1`).setLabel('Resumido').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`panel_hist:det:${sessionId}`).setLabel('Detallado').setStyle(ButtonStyle.Secondary)
                    );
                    return interaction.reply({ content: 'Elegí el formato del historial:', components: [row], ephemeral: true });
                }

                if (accion === 'editar') {
                    const embed = new EmbedBuilder().setTitle('✏️ Editar panel').setDescription('Elegí qué querés editar:');
                    const row1 = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`panel_edit:evento:${sessionId}`).setLabel('Evento').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId(`panel_edit:categoria:${sessionId}`).setLabel('Categoría').setStyle(ButtonStyle.Secondary),
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
                    if (!esLiderUsuario) return interaction.reply({ content: '❌ Only staff/leaders.', ephemeral: true });
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
                    if (!esLiderUsuario) return interaction.reply({ content: '❌ Only leaders/staff.', ephemeral: true });
                    const id = guardarPendientePanel('cancelar_subasta', { sessionId: session.id }, interaction.user.id);
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Sí, cancelar y eliminar').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Volver').setStyle(ButtonStyle.Secondary)
                    );
                    return interaction.reply({ content: '⚠️ **¿Estás seguro de cancelar y eliminar esta subasta?**', components: [row], ephemeral: true });
                }
            }

            if (interaction.isButton() && interaction.customId.startsWith('panel_hist:')) {
                const partes = interaction.customId.split(':');
                const tipo = partes[1];
                const sessionId = partes[2];
                const page = parseInt(partes[3]) || 1;

                const subastas = cargarSubastas();
                const session = subastas[sessionId];
                if (!session) return interaction.reply({ content: '❌ Panel inexistente.', ephemeral: true });
                const db = funciones.cargarDB();
                const miembros = funciones.cargarMiembros();

                if (tipo === 'res') {
                    const todos = session.interesados.map(j => ({ jugador: j, ...funciones.calcularPrioridad(j, session.item.categoria, db.compras, miembros) }));
                    todos.sort(funciones.compararPrioridad);

                    const porPagina = 5;
                    const totalPaginas = Math.max(1, Math.ceil(todos.length / porPagina));
                    const paginaActual = Math.min(Math.max(1, page), totalPaginas);
                    const inicio = (paginaActual - 1) * porPagina;
                    const slice = todos.slice(inicio, inicio + porPagina);

                    let out = `📜 **Últimas 5 compras por jugador** (Pág. ${paginaActual}/${totalPaginas})\n\n`;
                    if (slice.length === 0) out += 'Sin interesados.';
                    else {
                        for (const t of slice) {
                            const nombre = funciones.aplicarCanonico(t.jugador, miembros);
                            let comprasJ = db.compras.filter(c => utils.contarGanador(c.ganadores, t.jugador, miembros) > 0);
                            comprasJ.sort(utils.ordenarComprasDesc);
                            const ultimas = comprasJ.slice(0, 5);
                            out += `**${nombre}** (últimas ${ultimas.length}):\n`;
                            if (ultimas.length === 0) out += `Sin compras.\n`;
                            else {
                                for (const c of ultimas) {
                                    const n = utils.contarGanador(c.ganadores, t.jugador, miembros);
                                    out += `#${c.id} · ${utils.formatearFecha(c.fecha)} ${utils.etiquetaDias(c.fecha)} · ${n}x ${c.objeto} (${c.categoria})\n`;
                                }
                            }
                            out += `\n`;
                        }
                    }

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`panel_hist:res:${sessionId}:${paginaActual - 1}`).setLabel('◀').setStyle(ButtonStyle.Primary).setDisabled(paginaActual <= 1),
                        new ButtonBuilder().setCustomId(`panel_hist:res:${sessionId}:${paginaActual + 1}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(paginaActual >= totalPaginas)
                    );
                    return interaction.update({ content: out, components: [row] });
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
                let comprasJ = db.compras.filter(c => utils.contarGanador(c.ganadores, t.jugador, miembros) > 0).sort(utils.ordenarComprasDesc);

                let out = `📜 **${nombre}** (Detallado)\n\n`;
                for (const cat of utils.CATEGORIAS) {
                    const filtradas = comprasJ.filter(c => c.categoria === cat).slice(0, 5);
                    if (filtradas.length === 0) continue;
                    out += `**${cat}** (últimas ${filtradas.length}):\n`;
                    for (const c of filtradas) {
                        const n = utils.contarGanador(c.ganadores, t.jugador, miembros);
                        out += `#${c.id} · ${utils.formatearFecha(c.fecha)} ${utils.etiquetaDias(c.fecha)} · ${n}x ${c.objeto}\n`;
                    }
                    out += `\n`;
                }

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

            if (interaction.isButton() && interaction.customId.startsWith('panel_edit:')) {
                const [, campo, sessionId] = interaction.customId.split(':');
                const subastas = cargarSubastas();
                const session = subastas[sessionId];
                if (!session || (session.estado !== 'abierta' && session.estado !== 'bloqueada')) return interaction.reply({ content: '❌ Panel cerrado.', ephemeral: true });
                const esLiderUsuario = esLider(interaction.member, funciones);

                if (campo === 'evento') {
                    const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`panel_sel:evento:${sessionId}`).setPlaceholder('Elegir evento').addOptions(EVENTOS_PANEL.map(e => ({ label: e, value: e }))));
                    return interaction.reply({ content: 'Elegí evento:', components: [row], ephemeral: true });
                }
                if (campo === 'categoria') {
                    const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`panel_sel:categoria:${sessionId}`).setPlaceholder('Elegir categoría').addOptions(CATEGORIAS_PANEL.map(c => ({ label: c, value: c }))));
                    return interaction.reply({ content: 'Elegí categoría:', components: [row], ephemeral: true });
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
                    if (!esLiderUsuario) return interaction.reply({ content: '❌ Only leaders/staff.', ephemeral: true });
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
                if (!session || (session.estado !== 'abierta' && session.estado !== 'bloqueada')) return interaction.reply({ content: '❌ Panel cerrado.', ephemeral: true });
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
                if (!session || (session.estado !== 'abierta' && session.estado !== 'bloqueada')) return interaction.reply({ content: '❌ Panel cerrado.', ephemeral: true });
                if (!esLider(interaction.member, funciones)) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });

                const canon = funciones.aplicarCanonico(valor, funciones.cargarMiembros());
                const id = guardarPendientePanel('quitar_interesado', { sessionId: session.id, jugador: valor }, interaction.user.id);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`panel_pending_confirm:${id}`).setLabel('Sí, quitar').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`panel_pending_cancel:${id}`).setLabel('Volver').setStyle(ButtonStyle.Secondary)
                );
                return interaction.reply({ content: `⚠️ **¿Quitar a ${canon}?**`, components: [row], ephemeral: true });
            }

            if (interaction.isModalSubmit() && interaction.customId.startsWith('panel_modal:')) {
                const [, tipo, sessionId] = interaction.customId.split(':');
                const subastas = cargarSubastas();
                const session = subastas[sessionId];
                if (!session || (session.estado !== 'abierta' && session.estado !== 'bloqueada')) return interaction.reply({ content: '❌ Sesión no encontrada.', ephemeral: true });

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

                    const canonizarGanador = (valor) => {
                        const parsed = utils.parsearGanador(valor);
                        const baseCanon = funciones.aplicarCanonico(parsed.nombre, miembros);
                        return parsed.cantidad > 1 ? `${baseCanon} x${parsed.cantidad}` : baseCanon;
                    };

                    const canonizarSimple = (valor) => {
                        const parsed = utils.parsearGanador(valor);
                        return funciones.aplicarCanonico(parsed.nombre, miembros);
                    };

                    const g = interaction.fields.getTextInputValue('ganadores')
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean)
                        .map(canonizarGanador);

                    const p = interaction.fields.getTextInputValue('perdedores')
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean)
                        .map(canonizarSimple);

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
                if (!session || (session.estado !== 'abierta' && session.estado !== 'bloqueada')) { pendingPanel.delete(id); return interaction.editReply({ content: '❌ El panel ya no está activo.', components: [] }); }
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

                    session.item.cantidad = p.payload.cantidad;
                    session.estado = 'cerrada';
                    session.registradoPor = interaction.member?.displayName || interaction.user.username;
                    session.fechaRegistro = new Date().toISOString();
                    pushHistorial(session, interaction, 'Registró resultado');
                    guardarSubastas(subastas);

                    const syncRes = await funciones.sincronizarConGitHub(false);

                    await actualizarMensajePanel(client, session, funciones);

                    const archivadas = cargarArchivadas(); archivadas[session.id] = session; guardarArchivadas(archivadas);
                    delete subastas[session.id]; guardarSubastas(subastas);

                    await refrescarTodo(client, funciones);

                    const ganadoresExpandidos = [];
                    const ganadoresMultiples = [];
                    for (const g of entrada.ganadores) {
                        const parsed = utils.parsearGanador(g);
                        if (parsed.cantidad > 1) {
                            for (let i = 0; i < parsed.cantidad; i++) ganadoresMultiples.push(parsed.nombre);
                        } else {
                            ganadoresExpandidos.push(parsed.nombre);
                        }
                    }
                    const ganadoresOrdenados = [...ganadoresExpandidos, ...ganadoresMultiples];

                    const ganadoresNumerados = ganadoresOrdenados
                        .map((nombre, i) => `${i + 1}. ${funciones.aplicarCanonico(nombre, miembros)}`)
                        .join('\n');

                    const tituloGanadores = ganadoresOrdenados.length === 1 ? '🏆 **Winner:**' : '🏆 **Winners:**';

                    let msg = `✅ Resultado registrado: #${entrada.id} · 📅 ${utils.formatearFecha(entrada.fecha)} ${utils.etiquetaDias(entrada.fecha)} · ${entrada.cantidad}x ${entrada.objeto} (${entrada.categoria})`;
                    msg += `\n\n${tituloGanadores}\n${ganadoresNumerados || 'nadie'}`;

                    if (entrada.perdedores.length > 0) {
                        const perdedoresBase = entrada.perdedores.map(p => funciones.aplicarCanonico(utils.parsearGanador(p).nombre, miembros));
                        const tituloPerdedores = entrada.perdedores.length === 1 ? '💔 **Non-winner:**' : '💔 **Non-winners:**';
                        msg += `\n\n${tituloPerdedores}\n${perdedoresBase.join(', ')}`;
                    }

                    if (!syncRes.ok) msg += `\n\n⚠️ Sync falló: ${syncRes.motivo}`;

                    pendingPanel.delete(id);
                    await interaction.editReply({ content: '✅ Acción completada.', components: [] });
                    await interaction.followUp({ content: msg, ephemeral: false });

                    if (entrada.ganadores.length > 0) {
                        try {
                            let members;
                            try { members = await interaction.guild.members.fetch(); } catch { members = interaction.guild.members.cache; }

                            const nombresBase = [];
                            const vistosBase = new Set();
                            for (const g of entrada.ganadores) {
                                const nombreBase = utils.parsearGanador(g).nombre;
                                const key = utils.claveJugador(nombreBase, miembros);
                                if (!vistosBase.has(key)) {
                                    vistosBase.add(key);
                                    nombresBase.push(nombreBase);
                                }
                            }

                            const menciones = nombresBase.map(nombreBase => {
                                const normG = utils.normalizar(nombreBase);
                                const canonG = utils.normalizar(funciones.aplicarCanonico(nombreBase, miembros));
                                const member = members.find(m => {
                                    if (!m) return false;
                                    const username = utils.normalizar(m.user?.username || '');
                                    const displayName = utils.normalizar(m.displayName || '');
                                    const nickname = utils.normalizar(m.nickname || '');
                                    const canonDisplay = utils.normalizar(funciones.aplicarCanonico(m.displayName || '', miembros));
                                    return (
                                        username === normG || displayName === normG || nickname === normG || canonDisplay === normG ||
                                        username === canonG || displayName === canonG || nickname === canonG || canonDisplay === canonG
                                    );
                                });
                                return member ? `<@${member.id}>` : `**${nombreBase}**`;
                            });

                            const pingId = funciones.guardarPendiente('ping', { menciones }, interaction.user.id);
                            const rowPing = new ActionRowBuilder().addComponents(
                                new ButtonBuilder().setCustomId(`ping_confirm_${pingId}`).setLabel('Sí, pingear').setStyle(ButtonStyle.Success),
                                new ButtonBuilder().setCustomId(`ping_cancel_${pingId}`).setLabel('No, gracias').setStyle(ButtonStyle.Secondary)
                            );

                            await interaction.followUp({ content: '🔔 ¿Querés avisar a los ganadores?', components: [rowPing], ephemeral: true });
                        } catch (e) { console.error('Error en ping:', e.message); }
                    }
                    return;
                }

                if (p.tipo === 'cancelar_subasta') {
                    session.estado = 'cancelada';
                    pushHistorial(session, interaction, 'Subasta cancelada y eliminada');
                    guardarSubastas(subastas);
                    const archivadas = cargarArchivadas(); archivadas[session.id] = session; guardarArchivadas(archivadas);
                    delete subastas[session.id]; guardarSubastas(subastas);

                    if (esThreadBoss(session.threadId)) {
                        try {
                            const thread = await client.channels.fetch(session.threadId);
                            if (thread) {
                                const starterMsg = await thread.fetchStarterMessage().catch(() => null);
                                await thread.delete().catch(() => null);
                                if (starterMsg) await starterMsg.delete().catch(() => null);
                            }
                        } catch {}
                    } else {
                        try {
                            const canal = await client.channels.fetch(session.channelId);
                            const msg = await canal.messages.fetch(session.messageId);
                            await msg.delete();
                        } catch {}
                    }

                    await limpiarSlotBossPorThread(session.threadId, client);

                    await refrescarTodo(client, funciones);
                    pendingPanel.delete(id);
                    return interaction.editReply({ content: '🗑️ Subasta cancelada, panel eliminado y archivada sin registrar.', components: [] });
                }
            }

            if (interaction.isButton() && interaction.customId.startsWith('control_btn:')) {
                if (!esLider(interaction.member, funciones)) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });
                const partes = interaction.customId.split(':');
                const accion = partes[1];
                const threadId = partes[2];

                if (accion === 'abrir') {
                    const fijos = cargarThreadsFijos();
                    const fijo = fijos.find(f => f.id === threadId);
                    const modal = new ModalBuilder().setCustomId(`control_modal:abrir:${threadId}`).setTitle('Abrir Subasta');
                    if (fijo && fijo.objeto) {
                        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cantidad').setLabel('Cantidad').setStyle(TextInputStyle.Short).setValue('1').setRequired(true)));
                    } else {
                        modal.addComponents(
                            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('objeto').setLabel('Objeto').setStyle(TextInputStyle.Short).setRequired(true)),
                            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cantidad').setLabel('Cantidad').setStyle(TextInputStyle.Short).setValue('1').setRequired(true))
                        );
                    }
                    return interaction.showModal(modal);
                }

                if (accion === 'cerrar') {
                    const subastas = cargarSubastas();
                    const session = Object.values(subastas).find(s => s.threadId === threadId && (s.estado === 'abierta' || s.estado === 'bloqueada'));
                    if (!session) return interaction.reply({ content: '❌ No hay subasta activa en ese thread.', ephemeral: true });
                    const id = guardarPendientePanel('control_cancelar_subasta', { sessionId: session.id }, interaction.user.id);
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`control_pending_confirm:${id}`).setLabel('Sí, cerrar y borrar').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(`control_pending_cancel:${id}`).setLabel('Volver').setStyle(ButtonStyle.Secondary)
                    );
                    return interaction.reply({ content: `⚠️ **¿Cancelar subasta de <#${threadId}> y borrar el panel?**`, components: [row], ephemeral: true });
                }

                if (accion === 'abrir_todos') {
                    const fijos = cargarThreadsFijos();
                    const subastas = cargarSubastas();
                    const disponibles = [];
                    let activosCount = 0;
                    let sinObjetoCount = 0;

                    for (const fijo of fijos) {
                        if (!fijo.objeto) {
                            sinObjetoCount++;
                            continue;
                        }
                        const activa = Object.values(subastas).find(s => s.threadId === fijo.id && (s.estado === 'abierta' || s.estado === 'bloqueada'));
                        if (activa) {
                            activosCount++;
                        } else {
                            disponibles.push(fijo);
                        }
                    }

                    if (disponibles.length === 0) {
                        return interaction.reply({ content: '❌ No hay threads disponibles con objeto configurado.', ephemeral: true });
                    }

                    let txt = `⚠️ **¿Abrir subasta en ${disponibles.length} thread(s)?**\n`;
                    if (activosCount > 0) txt += `ℹ️ Se omitirán **${activosCount}** thread(s) que ya tienen subasta activa.\n`;
                    if (sinObjetoCount > 0) txt += `ℹ️ Se omitirán **${sinObjetoCount}** thread(s) sin objeto configurado.\n`;

                    const id = guardarPendientePanel('control_abrir_todos', { disponibles }, interaction.user.id);
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`control_pending_confirm:${id}`).setLabel('Confirmar').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`control_pending_cancel:${id}`).setLabel('Cancelar').setStyle(ButtonStyle.Danger)
                    );
                    return interaction.reply({ content: txt, components: [row], ephemeral: true });
                }

                if (accion === 'cerrar_todos') {
                    const modal = new ModalBuilder().setCustomId(`control_modal:cerrar_todos`).setTitle('Cerrar Todas las Subastas');
                    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('confirmar').setLabel('Escribí "CONFIRMAR" para cerrar todas').setStyle(TextInputStyle.Short).setRequired(true)));
                    return interaction.showModal(modal);
                }
            }

            if (interaction.isButton() && (interaction.customId.startsWith('control_pending_confirm:') || interaction.customId.startsWith('control_pending_cancel:'))) {
                const esConfirm = interaction.customId.startsWith('control_pending_confirm:');
                const id = interaction.customId.replace('control_pending_confirm:', '').replace('control_pending_cancel:', '');
                const p = pendingPanel.get(id);
                if (!p) return interaction.update({ content: '❌ La sesión expiró.', components: [] });
                if (p.userId !== interaction.user.id) return interaction.reply({ content: '❌ Solo quien inició la acción puede confirmar.', ephemeral: true });
                if (!esConfirm) { pendingPanel.delete(id); return interaction.update({ content: '❌ Acción cancelada.', components: [] }); }

                try { await interaction.deferUpdate(); } catch {}
                const subastas = cargarSubastas();

                if (p.tipo === 'control_abrir_todos') {
                    const disponibles = p.payload.disponibles;
                    const f = funciones.fechaHoyArgentina();
                    const ev = obtenerEventoPorHora();
                    const db = funciones.cargarDB();
                    let abiertas = 0;
                    let omitidas = 0;

                    for (const fijo of disponibles) {
                        if (!fijo || !fijo.objeto) { omitidas++; continue; }
                        const yaActiva = Object.values(subastas).find(s => s.threadId === fijo.id && (s.estado === 'abierta' || s.estado === 'bloqueada'));
                        if (yaActiva) { omitidas++; continue; }

                        const cat = (fijo && fijo.categoria) ? fijo.categoria : logic.inferirCategoria(fijo.objeto, db);
                        const session = {
                            id: generarId(), threadId: fijo.id, channelId: fijo.id, messageId: null, threadName: fijo.nombre,
                            item: { fecha: f, evento: ev, categoria: cat, objeto: fijo.objeto, cantidad: 1 },
                            interesados: [], dados: {}, estado: 'abierta', historial: [], creadoPor: interaction.user.id, createdAt: Date.now()
                        };

                        aplicarDadosPendientes(session);

                        pushHistorial(session, interaction, 'Panel creado por Abrir TODAS');
                        subastas[session.id] = session;
                        try {
                            const canal = await client.channels.fetch(fijo.id);
                            const { embeds, components } = renderPanel(session, funciones);
                            const msg = await canal.send({ embeds, components });
                            session.messageId = msg.id;
                            abiertas++;
                        } catch (e) {
                            console.error(e);
                            omitidas++;
                        }
                    }
                    guardarSubastas(subastas);
                    await refrescarTodo(client, funciones);
                    pendingPanel.delete(id);
                    return interaction.editReply({ content: `✅ Se abrieron **${abiertas}** subastas. Se omitieron **${omitidas}**.`, components: [] });
                }

                const session = subastas[p.payload.sessionId];
                if (!session || (session.estado !== 'abierta' && session.estado !== 'bloqueada')) { pendingPanel.delete(id); return interaction.editReply({ content: '❌ El panel ya no está activo.', components: [] }); }

                if (p.tipo === 'control_cancelar_subasta') {
                    session.estado = 'cancelada';
                    pushHistorial(session, interaction, 'Subasta cancelada desde Control');
                    guardarSubastas(subastas);
                    const archivadas = cargarArchivadas(); archivadas[session.id] = session; guardarArchivadas(archivadas);
                    delete subastas[session.id]; guardarSubastas(subastas);

                    if (esThreadBoss(session.threadId)) {
                        try {
                            const thread = await client.channels.fetch(session.threadId);
                            if (thread) {
                                const starterMsg = await thread.fetchStarterMessage().catch(() => null);
                                await thread.delete().catch(() => null);
                                if (starterMsg) await starterMsg.delete().catch(() => null);
                            }
                        } catch {}
                    } else {
                        try {
                            const canal = await client.channels.fetch(session.channelId);
                            const msg = await canal.messages.fetch(session.messageId);
                            await msg.delete();
                        } catch {}
                    }

                    await limpiarSlotBossPorThread(session.threadId, client);

                    await refrescarTodo(client, funciones);
                    pendingPanel.delete(id);
                    return interaction.editReply({ content: '🗑️ Subasta cancelada y panel eliminado.', components: [] });
                }
            }

            if (interaction.isModalSubmit() && interaction.customId.startsWith('control_modal:')) {
                if (!esLider(interaction.member, funciones)) return interaction.reply({ content: '❌ Solo líderes/helpers.', ephemeral: true });
                const partes = interaction.customId.split(':');
                const accion = partes[1];
                const threadId = partes[2];

                if (accion === 'abrir') {
                    await interaction.deferReply({ ephemeral: true });
                    const fijos = cargarThreadsFijos();
                    const fijo = fijos.find(f => f.id === threadId);
                    let obj = fijo && fijo.objeto ? fijo.objeto : null;
                    if (!obj) obj = interaction.fields.getTextInputValue('objeto');
                    const cant = parseInt(interaction.fields.getTextInputValue('cantidad'), 10) || 1;

                    const db = funciones.cargarDB();
                    const cat = (fijo && fijo.categoria) ? fijo.categoria : logic.inferirCategoria(obj, db);
                    const ev = obtenerEventoPorHora();
                    const f = funciones.fechaHoyArgentina();

                    const subastas = cargarSubastas();
                    if (Object.values(subastas).find(s => s.threadId === threadId && (s.estado === 'abierta' || s.estado === 'bloqueada'))) return interaction.editReply({ content: '❌ Ese thread ya tiene subasta.' });

                    let nombre = fijo ? fijo.nombre : `Thread ${threadId.slice(-4)}`;
                    try { const ch = await client.channels.fetch(threadId); if (ch && ch.name) nombre = ch.name; } catch {}

                    const session = {
                        id: generarId(), threadId, channelId: threadId, messageId: null, threadName: nombre,
                        item: { fecha: f, evento: ev, categoria: cat, objeto: obj, cantidad: cant },
                        interesados: [], dados: {}, estado: 'abierta', historial: [], creadoPor: interaction.user.id, createdAt: Date.now()
                    };

                    aplicarDadosPendientes(session);

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
                        if (subastas[id].estado === 'abierta' || subastas[id].estado === 'bloqueada') {
                            const bossThreadId = subastas[id].threadId;

                            subastas[id].estado = 'cancelada';
                            pushHistorial(subastas[id], interaction, 'Cancelada por Control Global');
                            archivadas[id] = subastas[id];

                            if (esThreadBoss(bossThreadId)) {
                                try {
                                    const thread = await client.channels.fetch(bossThreadId);
                                    if (thread) {
                                        const starterMsg = await thread.fetchStarterMessage().catch(() => null);
                                        await thread.delete().catch(() => null);
                                        if (starterMsg) await starterMsg.delete().catch(() => null);
                                    }
                                } catch {}
                            } else {
                                try {
                                    const canal = await client.channels.fetch(subastas[id].channelId);
                                    const msg = await canal.messages.fetch(subastas[id].messageId);
                                    await msg.delete();
                                } catch {}
                            }

                            await limpiarSlotBossPorThread(bossThreadId, client);

                            delete subastas[id];
                            cerradas++;
                        }
                    }
                    guardarSubastas(subastas); guardarArchivadas(archivadas);
                    await refrescarTodo(client, funciones);
                    return interaction.editReply({ content: `✅ Se cancelaron y eliminaron **${cerradas}** subastas.` });
                }
            }
        } catch (err) {
            if (err.code === 10062) {
                console.log('⚠️ Interacción caducada ignorada (10062).');
            } else {
                console.error('❌ Error en panel:', err);
                if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
                    try { await interaction.reply({ content: '❌ Error interno.', ephemeral: true }); } catch (e) {}
                }
            }
        }
    });
}

module.exports = { setupPanel, crearPanelEnThread, actualizarIndice, actualizarMensajePanel };
