const fs = require('fs');
const path = require('path');
const {
    Events,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    AttachmentBuilder
} = require('discord.js');

const utils = require('./utils');
const logic = require('./logic');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'control_boss_config.json');
const PENDIENTES_FILE = path.join(DATA_DIR, 'control_boss_pendientes.json');
const PANEL_FILE = path.join(DATA_DIR, 'control_boss_panel.json');
const IMG_DIR = path.join(DATA_DIR, 'imagenes', 'anuncios');

const confirmaciones = new Map();
const enProceso = new Set();

function asegurarDirs() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(IMG_DIR, { recursive: true });
}
function cargarJSON(file, def) {
    if (!fs.existsSync(file)) return def;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return def; }
}
function guardarJSON(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function cargarConfig() {
    const c = cargarJSON(CONFIG_FILE, { canalAnunciosId: null, slots: [] });
    if (!Array.isArray(c.slots)) c.slots = [];
    while (c.slots.length < 4) c.slots.push({ slot: c.slots.length + 1, objeto: null, categoria: null, texto: null, imagen: null, threadId: null });
    return c;
}
function guardarConfig(c) { guardarJSON(CONFIG_FILE, c); }
function cargarPendientes() { const p = cargarJSON(PENDIENTES_FILE, []); return Array.isArray(p) ? p : []; }
function guardarPendientes(p) { guardarJSON(PENDIENTES_FILE, p); }
function cargarPanel() { return cargarJSON(PANEL_FILE, { channelId: null, messageId: null }); }
function guardarPanel(p) { guardarJSON(PANEL_FILE, p); }
function cargarSubastas() { const f = path.join(DATA_DIR, 'subastas_activas.json'); return cargarJSON(f, {}); }
function guardarSubastas(d) { const f = path.join(DATA_DIR, 'subastas_activas.json'); guardarJSON(f, d); }

function esLiderBoss(member, funciones) {
    if (!member) return false;
    if (member.id === member.guild.ownerId) return true;
    if (member.permissions && member.permissions.has('Administrator')) return true;
    return member.roles.cache.has(funciones.ROL_LIDER);
}

function slotConfigurado(s) { return !!(s && s.objeto && s.texto && s.imagen); }

function obtenerEventoPorHora() {
    const ahora = new Date();
    const horaStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hour12: false }).format(ahora);
    const hora = parseInt(horaStr, 10);
    if (hora >= 5 && hora < 18) return 'Invasión diurna';
    if (hora >= 18 && hora <= 21) return 'Invasión nocturna';
    return 'Banquete';
}

function githubConfigurado() {
    return !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
}

async function githubPut(repoPath, contentBuffer, message) {
    if (!githubConfigurado()) return;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const token = process.env.GITHUB_TOKEN;
    const url = `https://api.github.com/repos/${repo}/contents/${repoPath}`;

    let sha = null;
    const rGet = await fetch(`${url}?ref=${branch}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'bot-subastas' }
    });
    if (rGet.ok) { const data = await rGet.json(); sha = data.sha; }

    const body = { message, content: contentBuffer.toString('base64'), branch };
    if (sha) body.sha = sha;

    const rPut = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'bot-subastas' },
        body: JSON.stringify(body)
    });
    if (!rPut.ok) {
        const txt = await rPut.text();
        console.error(`GitHub PUT ${repoPath}: ${rPut.status} ${txt.slice(0, 150)}`);
    }
}

async function publicarConfig() {
    if (!githubConfigurado()) return;
    await githubPut('data/control_boss_config.json', Buffer.from(JSON.stringify(cargarConfig(), null, 2)), 'Actualizar control_boss_config.json');
}
async function publicarPendientes() {
    if (!githubConfigurado()) return;
    await githubPut('data/control_boss_pendientes.json', Buffer.from(JSON.stringify(cargarPendientes(), null, 2)), 'Actualizar control_boss_pendientes.json');
}
async function publicarPanel() {
    if (!githubConfigurado()) return;
    await githubPut('data/control_boss_panel.json', Buffer.from(JSON.stringify(cargarPanel(), null, 2)), 'Actualizar control_boss_panel.json');
}
async function publicarImagen(filename) {
    if (!githubConfigurado()) return;
    const local = path.join(IMG_DIR, filename);
    if (!fs.existsSync(local)) return;
    await githubPut(`data/imagenes/anuncios/${filename}`, fs.readFileSync(local), `Subir imagen ${filename}`);
}

async function renderPanelControlBoss(config) {
    const embed = new EmbedBuilder().setTitle('🎛️ Panel de Control de Boss').setColor(0x2B2D31);
    const configurados = config.slots.filter(slotConfigurado);
    
    if (configurados.length === 0) {
        embed.setDescription('No hay slots configurados. Usá `/control-boss objeto set`.');
        return { embeds: [embed], components: [] };
    }

    const subastas = cargarSubastas();
    let desc = '';
    const rows = [];
    let row = new ActionRowBuilder();

    for (const s of configurados) {
        let session = null;
        if (s.threadId) {
            session = Object.values(subastas).find(x => x.threadId === s.threadId && (x.estado === 'abierta' || x.estado === 'bloqueada'));
        }

        if (session) {
            desc += `• **[${s.slot}]** <#${s.threadId}> — 🟢 Activo (${session.interesados.length}/${session.item.cantidad})\n`;
            if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); }
            row.addComponents(new ButtonBuilder().setCustomId(`boss_slot_cerrar:${s.slot}`).setLabel(`Cerrar ${s.slot}`).setStyle(ButtonStyle.Danger));
        } else {
            desc += `• **[${s.slot}]** ${s.objeto} — 🔴 Cerrado\n`;
            if (row.components.length === 5) { rows.push(row); row = new ActionRowBuilder(); }
            row.addComponents(new ButtonBuilder().setCustomId(`boss_slot_abrir:${s.slot}`).setLabel(`Abrir ${s.slot}`).setStyle(ButtonStyle.Success));
        }
    }
    embed.setDescription(desc);
    if (row.components.length > 0) rows.push(row);
    return { embeds: [embed], components: rows };
}

async function actualizarPanelControlBoss(client) {
    const panel = cargarPanel();
    if (!panel.channelId) return;
    try {
        const canal = await client.channels.fetch(panel.channelId);
        let msg = null;
        if (panel.messageId) { try { msg = await canal.messages.fetch(panel.messageId); } catch { msg = null; } }
        const payload = await renderPanelControlBoss(cargarConfig());
        if (msg) await msg.edit(payload);
        else { const nuevo = await canal.send(payload); guardarPanel({ channelId: canal.id, messageId: nuevo.id }); await publicarPanel(); }
    } catch (e) { console.error('Error panel control boss:', e.message); }
}

async function guardarAdjunto(attachment, slot) {
    asegurarDirs();
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`No se pudo descargar adjunto (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = path.extname(attachment.name || '.png') || '.png';
    const filename = `slot${slot}_${Date.now()}${ext}`;
    fs.writeFileSync(path.join(IMG_DIR, filename), buf);
    return filename;
}

async function procesarPendiente(client, pendiente, funciones) {
    if (!pendiente || pendiente.estado !== 'pendiente') return;
    if (enProceso.has(pendiente.id)) return;
    enProceso.add(pendiente.id);
    try {
        const canal = await client.channels.fetch(pendiente.channelId);
        let thread = null;
        try {
            const activos = await canal.threads.fetchActive();
            for (const t of activos.threads.values()) {
                try {
                    const starter = await t.fetchStarterMessage();
                    if (starter && starter.id === pendiente.messageId) { thread = t; break; }
                } catch {}
            }
        } catch {}
        if (!thread) return;

        if (pendiente.expiraEn < Date.now()) {
            const pendientes = cargarPendientes();
            const idx = pendientes.findIndex(p => p.id === pendiente.id);
            if (idx !== -1) { pendientes[idx].estado = 'expirado'; guardarPendientes(pendientes); await publicarPendientes(); }
            return;
        }

        const pendientes = cargarPendientes();
        const idx = pendientes.findIndex(p => p.id === pendiente.id && p.estado === 'pendiente');
        if (idx === -1) return;
        pendientes[idx].estado = 'usado';
        guardarPendientes(pendientes);
        await publicarPendientes();

        const { crearPanelEnThread } = require('./panel');
        await crearPanelEnThread(client, thread, {
            fecha: funciones.fechaHoyArgentina(),
            evento: obtenerEventoPorHora(),
            categoria: pendiente.categoria,
            objeto: pendiente.objeto,
            cantidad: pendiente.cantidad
        }, funciones, pendiente.creadoPor);

        const config = cargarConfig();
        const slotObj = config.slots.find(s => s.slot === pendiente.slot);
        if (slotObj) {
            slotObj.threadId = thread.id;
            guardarConfig(config);
            await publicarConfig();
            await actualizarPanelControlBoss(client);
        }
    } catch (e) {
        console.error('Error procesando pendiente:', e.message);
    } finally {
        enProceso.delete(pendiente.id);
    }
}

async function reconciliarPendientes(client, funciones) {
    const pendientes = cargarPendientes();
    let cambios = false;
    const ahora = Date.now();
    for (const p of pendientes) {
        if (p.estado !== 'pendiente') continue;
        if (p.expiraEn < ahora) { p.estado = 'expirado'; cambios = true; continue; }
        await procesarPendiente(client, p, funciones);
    }
    if (cambios) { guardarPendientes(pendientes); await publicarPendientes(); }
}

function setupControlBoss(client, funciones) {
    asegurarDirs();

    setInterval(() => { reconciliarPendientes(client, funciones).catch(e => console.error('Error reconciliando:', e.message)); }, 30 * 1000);
    client.once(Events.ClientReady, () => { reconciliarPendientes(client, funciones).catch(e => console.error('Error reconciliando al iniciar:', e.message)); });

    client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
        if (!newlyCreated) return;
        const config = cargarConfig();
        if (!config.canalAnunciosId || thread.parentId !== config.canalAnunciosId) return;
        try {
            const starter = await thread.fetchStarterMessage();
            if (!starter) return;
            const pendientes = cargarPendientes();
            const pendiente = pendientes.find(p => p.messageId === starter.id && p.estado === 'pendiente');
            if (!pendiente) return;
            await procesarPendiente(client, pendiente, funciones);
        } catch (e) { console.error('Error ThreadCreate:', e.message); }
    });

    client.on('interactionCreate', async (interaction) => {
        if (interaction.isAutocomplete() && interaction.commandName === 'control-boss') {
            const focused = interaction.options.getFocused(true);
            if (focused.name === 'objeto') {
                const db = funciones.cargarDB();
                const objetos = funciones.obtenerObjetosUnicos(db);
                const q = funciones.normalizar(focused.value);
                return interaction.respond(objetos.filter(n => funciones.normalizar(n).includes(q)).slice(0, 25).map(n => ({ name: n, value: n })));
            }
            return;
        }

        if (interaction.isChatInputCommand() && interaction.commandName === 'control-boss') {
            if (!esLiderBoss(interaction.member, funciones)) return interaction.reply({ content: '❌ Solo líderes/admins.', ephemeral: true });
            const sub = interaction.options.getSubcommand();
            const grupo = interaction.options.getSubcommandGroup(false);

            if (sub === 'canal') {
                const canal = interaction.options.getChannel('canal');
                const config = cargarConfig();
                config.canalAnunciosId = canal.id;
                guardarConfig(config);
                await publicarConfig();
                return interaction.reply({ content: `✅ Canal de anuncios configurado: <#${canal.id}>.`, ephemeral: true });
            }

            if (grupo === 'objeto' && sub === 'set') {
                const slot = interaction.options.getInteger('slot');
                if (slot < 1 || slot > 4) return interaction.reply({ content: '❌ Slot inválido. Usá 1 a 4.', ephemeral: true });
                const objeto = interaction.options.getString('objeto').trim();
                const texto = interaction.options.getString('texto').trim();
                const imagen = interaction.options.getAttachment('imagen');
                if (!imagen) return interaction.reply({ content: '❌ Falta la imagen.', ephemeral: true });

                const db = funciones.cargarDB();
                const categoria = logic.inferirCategoria(objeto, db);
                const filename = await guardarAdjunto(imagen, slot);

                const config = cargarConfig();
                config.slots[slot - 1] = { slot, objeto, categoria, texto, imagen: filename, threadId: null };
                guardarConfig(config);
                await publicarImagen(filename);
                await publicarConfig();
                await actualizarPanelControlBoss(client);
                return interaction.reply({ content: `✅ Slot ${slot} configurado con **${objeto}**.\nImagen: \`${filename}\`.`, ephemeral: true });
            }

            if (grupo === 'objeto' && sub === 'quitar') {
                const slot = interaction.options.getInteger('slot');
                if (slot < 1 || slot > 4) return interaction.reply({ content: '❌ Slot inválido. Usá 1 a 4.', ephemeral: true });
                const config = cargarConfig();
                config.slots[slot - 1] = { slot, objeto: null, categoria: null, texto: null, imagen: null, threadId: null };
                guardarConfig(config);
                await publicarConfig();
                await actualizarPanelControlBoss(client);
                return interaction.reply({ content: `✅ Slot ${slot} liberado.`, ephemeral: true });
            }

            if (grupo === 'objeto' && sub === 'lista') {
                const config = cargarConfig();
                let out = '**Slots de anuncios**\n\n';
                for (const s of config.slots) {
                    out += `**Slot ${s.slot}:** ${slotConfigurado(s) ? `${s.objeto} | ${s.imagen}` : 'sin configurar'}\n`;
                }
                return interaction.reply({ content: out, ephemeral: true });
            }

            if (sub === 'panel') {
                await interaction.deferReply({ ephemeral: true });
                const config = cargarConfig();
                const payload = await renderPanelControlBoss(config);
                const msg = await interaction.channel.send(payload);
                guardarPanel({ channelId: interaction.channelId, messageId: msg.id });
                await publicarPanel();
                return interaction.editReply({ content: '✅ Panel de Control de Boss creado/actualizado.' });
            }

            if (sub === 'estado') {
                const pendientes = cargarPendientes();
                const abiertos = pendientes.filter(p => p.estado === 'pendiente').length;
                const usados = pendientes.filter(p => p.estado === 'usado').length;
                const expirados = pendientes.filter(p => p.estado === 'expirado').length;
                return interaction.reply({ content: `Pendientes: **${abiertos}**\nUsados: **${usados}**\nExpirados: **${expirados}**`, ephemeral: true });
            }
        }

        if (interaction.isButton() && interaction.customId.startsWith('boss_slot_abrir:')) {
            const slot = parseInt(interaction.customId.split(':')[1], 10);
            const config = cargarConfig();
            const s = config.slots.find(x => x.slot === slot);
            if (!slotConfigurado(s)) return interaction.reply({ content: '❌ Slot no configurado.', ephemeral: true });

            const modal = new ModalBuilder().setCustomId(`boss_modal:${slot}`).setTitle(`Abrir Slot ${slot}`);
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('cantidad').setLabel('Cantidad').setStyle(TextInputStyle.Short).setValue('1').setRequired(true)
            ));
            return interaction.showModal(modal);
        }

        if (interaction.isButton() && interaction.customId.startsWith('boss_slot_cerrar:')) {
            const slot = parseInt(interaction.customId.split(':')[1], 10);
            const config = cargarConfig();
            const s = config.slots.find(x => x.slot === slot);
            if (!s || !s.threadId) return interaction.reply({ content: '❌ No hay thread activo para este slot.', ephemeral: true });

            const subastas = cargarSubastas();
            const session = Object.values(subastas).find(x => x.threadId === s.threadId && (x.estado === 'abierta' || x.estado === 'bloqueada'));
            if (!session) return interaction.reply({ content: '❌ No hay subasta activa en este thread.', ephemeral: true });

            const id = Math.random().toString(36).slice(2, 10);
            confirmaciones.set(id, { userId: interaction.user.id, accion: 'cerrar', sessionId: session.id, slot, threadId: s.threadId, expira: Date.now() + 5 * 60 * 1000 });
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`boss_confirm_cerrar:${id}`).setLabel('Sí, cerrar').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`boss_cancel:${id}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
            );
            return interaction.reply({ content: `⚠️ **¿Cerrar subasta del Slot ${slot} en <#${s.threadId}>?**`, components: [row], ephemeral: true });
        }

        if (interaction.isModalSubmit() && interaction.customId.startsWith('boss_modal:')) {
            const slot = parseInt(interaction.customId.split(':')[1], 10);
            const config = cargarConfig();
            const s = config.slots.find(x => x.slot === slot);
            if (!slotConfigurado(s)) return interaction.reply({ content: '❌ Slot no configurado.', ephemeral: true });
            if (!config.canalAnunciosId) return interaction.reply({ content: '❌ No hay canal de anuncios configurado.', ephemeral: true });

            const cant = parseInt(interaction.fields.getTextInputValue('cantidad'), 10);
            if (isNaN(cant) || cant < 1) return interaction.reply({ content: '❌ Cantidad inválida.', ephemeral: true });

            const id = Math.random().toString(36).slice(2, 10);
            confirmaciones.set(id, { userId: interaction.user.id, accion: 'abrir', slot, cantidad: cant, expira: Date.now() + 5 * 60 * 1000 });

            let txt = `📋 **Confirmar anuncio**\n\n**Slot:** ${slot}\n**Objeto:** ${s.objeto}\n**Categoría:** ${s.categoria}\n**Cantidad:** ${cant}\n**Texto:** ${s.texto}\n\n¿Enviar?`;
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`boss_confirm_abrir:${id}`).setLabel('Confirmar').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`boss_cancel:${id}`).setLabel('Cancelar').setStyle(ButtonStyle.Danger)
            );
            return interaction.reply({ content: txt, components: [row], ephemeral: true });
        }

        if (interaction.isButton() && (interaction.customId.startsWith('boss_confirm_abrir:') || interaction.customId.startsWith('boss_confirm_cerrar:') || interaction.customId.startsWith('boss_cancel:'))) {
            const esAbrir = interaction.customId.startsWith('boss_confirm_abrir:');
            const esCerrar = interaction.customId.startsWith('boss_confirm_cerrar:');
            const id = interaction.customId.split(':')[1];
            const p = confirmaciones.get(id);
            if (!p || p.userId !== interaction.user.id || p.expira < Date.now()) {
                confirmaciones.delete(id);
                return interaction.update({ content: '❌ Sesión expirada.', components: [] });
            }
            if (!esAbrir && !esCerrar) { confirmaciones.delete(id); return interaction.update({ content: '❌ Acción cancelada.', components: [] }); }
            confirmaciones.delete(id);

            const config = cargarConfig();

            if (esCerrar) {
                const subastas = cargarSubastas();
                const session = subastas[p.sessionId];
                if (!session || (session.estado !== 'abierta' && session.estado !== 'bloqueada')) return interaction.update({ content: '❌ La subasta ya no está activa.', components: [] });
                
                session.estado = 'cancelada';
                session.historial.push({ timestamp: Date.now(), userId: interaction.user.id, userName: interaction.member?.displayName || 'Líder', accion: 'Cancelada desde Panel Boss' });
                
                const archivadasF = path.join(DATA_DIR, 'subastas_archivadas.json');
                const archivadas = cargarJSON(archivadasF, {});
                archivadas[session.id] = session;
                guardarJSON(archivadasF, archivadas);
                
                delete subastas[session.id];
                guardarSubastas(subastas);

                try {
                    const canal = await client.channels.fetch(session.channelId);
                    const msg = await canal.messages.fetch(session.messageId);
                    await msg.delete();
                } catch {}

                const slotObj = config.slots.find(x => x.slot === p.slot);
                if (slotObj) { slotObj.threadId = null; guardarConfig(config); await publicarConfig(); }
                
                await actualizarPanelControlBoss(client);
                
                // Refrescar panel de invasión también
                try {
                    const { setupPanel } = require('./panel');
                    // No podemos llamar a refrescarTodo directamente porque no está exportado, pero actualizarPanelControlBoss y el índice se actualizan solos en su intervalo. 
                    // O podemos forzar vía comando. Por ahora con actualizarPanelControlBoss basta.
                } catch(e) {}

                return interaction.update({ content: '✅ Subasta cerrada y panel eliminado.', components: [] });
            }

            if (esAbrir) {
                const s = config.slots.find(x => x.slot === p.slot);
                const canal = await client.channels.fetch(config.canalAnunciosId);
                const filePath = path.join(IMG_DIR, s.imagen);
                if (!fs.existsSync(filePath)) return interaction.update({ content: '❌ Falta la imagen local del slot.', components: [] });

                const attachment = new AttachmentBuilder(filePath);
                const msg = await canal.send({ content: s.texto, files: [attachment] });

                const pendientes = cargarPendientes();
                pendientes.push({
                    id: Math.random().toString(36).slice(2, 10),
                    messageId: msg.id,
                    channelId: canal.id,
                    slot: p.slot,
                    objeto: s.objeto,
                    categoria: s.categoria,
                    cantidad: p.cantidad,
                    texto: s.texto,
                    imagen: s.imagen,
                    creadoPor: interaction.user.id,
                    creadoEn: Date.now(),
                    expiraEn: Date.now() + 3 * 60 * 1000,
                    estado: 'pendiente'
                });
                guardarPendientes(pendientes);
                await publicarPendientes();
                return interaction.update({ content: '✅ Anuncio enviado. Esperando thread...', components: [] });
            }
        }
    });
}

module.exports = { setupControlBoss, actualizarPanelControlBoss };
