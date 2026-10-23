require('dotenv').config();
const { Client, GatewayIntentBits, Events, REST, Routes, PermissionFlagsBits } = require('discord.js');
const { parse } = require('csv-parse/sync');

const utils = require('./utils');
const logic = require('./logic');
const { commandsData } = require('./commands');
const { setupPanel } = require('./panel');

const pendingActions = new Map();
function guardarPendiente(tipo, payload, userId) {
    const id = Math.random().toString(36).slice(2, 10);
    pendingActions.set(id, { tipo, payload, userId, expira: Date.now() + 5 * 60 * 1000 });
    for (const [k, v] of pendingActions.entries()) {
        if (v.expira < Date.now()) pendingActions.delete(k);
    }
    return id;
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

client.once(Events.ClientReady, async (c) => {
    console.log(`Bot listo como ${c.user.tag}`);
    logic.leerCSVInicial();

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(
            Routes.applicationCommands(process.env.DISCORD_APP_ID),
            { body: commandsData.map(cmd => cmd.toJSON()) }
        );
        console.log('✅ Comandos registrados automáticamente.');
    } catch (err) {
        console.error('❌ Error registrando comandos:', err);
    }
});

function construirBotonesConfirmacion(id) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`pend_confirm_${id}`).setLabel('Confirmar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`pend_cancel_${id}`).setLabel('Cancelar').setStyle(ButtonStyle.Danger)
    );
}

async function mostrarPreview(interaction, titulo, cuerpo, tipo, payload) {
    const id = guardarPendiente(tipo, payload, interaction.user.id);
    let preview = `📋 **${titulo}**\n\n${cuerpo}\n\n¿Confirmás?`;
    if (preview.length > 1900) preview = preview.slice(0, 1890) + '...';
    return interaction.reply({
        content: preview,
        components: [construirBotonesConfirmacion(id)],
        ephemeral: true
    });
}

function textoEstadoSync(res) {
    if (!res) return '';
    if (res.ok) {
        let txt = `\n\n☁️ Sync con GitHub: OK`;
        if (res.agregadas > 0) txt += ` (${res.agregadas} nuevas absorvidas del CSV)`;
        return txt;
    }
    return `\n\n⚠️ Sync con GitHub falló: ${res.motivo}`;
}

client.on(Events.InteractionCreate, async (interaction) => {
    // 1. Autocompletado
    if (interaction.isAutocomplete()) {
        const db = utils.cargarDB();
        const miembros = utils.cargarMiembros();
        const focused = interaction.options.getFocused(true);
        const cmd = interaction.commandName;

        if (['panel', 'control'].includes(cmd)) return;

        if ((cmd === 'sub' || cmd === 'subf' || cmd === 'catalogo') && focused.name === 'objeto') {
            const objetos = logic.obtenerObjetosUnicos(db);
            const q = utils.normalizar(focused.value);
            return interaction.respond(objetos.filter(n => utils.normalizar(n).includes(q)).slice(0, 25).map(n => ({ name: n, value: n })));
        }

        if (cmd === 'objeto' && focused.name === 'nombre') {
            const objetos = logic.obtenerObjetosUnicos(db);
            const q = utils.normalizar(focused.value);
            return interaction.respond(objetos.filter(n => utils.normalizar(n).includes(q)).slice(0, 25).map(n => ({ name: n, value: n })));
        }

        if (cmd === 'editar' && focused.name === 'objeto') {
            const objetos = logic.obtenerObjetosUnicos(db);
            const q = utils.normalizar(focused.value);
            return interaction.respond(objetos.filter(n => utils.normalizar(n).includes(q)).slice(0, 25).map(n => ({ name: n, value: n })));
        }

        if (['jugadores', 'ganadores', 'perdedores', 'quitar', 'poner', 'por'].includes(focused.name)) {
            const nombres = logic.obtenerNombresUnicos(db, miembros);
            return interaction.respond(logic.sugerirNombresMultiples(focused.value, nombres));
        }

        if (focused.name === 'jugador' || (cmd === 'miembros' && focused.name === 'nombre')) {
            const nombres = logic.obtenerNombresUnicos(db, miembros);
            if (cmd === 'editar' || cmd === 'miembros') return interaction.respond(logic.sugerirNombresMultiples(focused.value, nombres));
            const q = utils.normalizar(focused.value);
            return interaction.respond(nombres.filter(n => utils.normalizar(n).includes(q)).slice(0, 25).map(n => ({ name: n, value: n })));
        }
        return;
    }

    // 2. Botones (Paginación y Confirmaciones)
    if (interaction.isButton()) {
        const cid = interaction.customId;

        if (cid.startsWith('prio_')) {
            const esPerdedores = cid.startsWith('prio_perdedores_');
            const id = cid.replace('prio_perdedores_', '').replace('prio_volver_', '');
            const p = pendingActions.get(id);
            if (!p || p.tipo !== 'prioridad-page' || p.userId !== interaction.user.id) return interaction.reply({ content: '❌ Sesión expirada.', ephemeral: true });
            const db = utils.cargarDB();
            const miembros = utils.cargarMiembros();
            if (esPerdedores) {
                const { content, components } = logic.renderPerdedores(p.payload, db, miembros);
                return interaction.update({ content, components });
            } else {
                const { content, components } = logic.renderPrioridad(p.payload, miembros);
                return interaction.update({ content, components });
            }
        }

        if (cid.startsWith('dia_')) {
            const match = cid.match(/^dia_(first|prev|next|last)_(.+)$/);
            if (!match) return;
            const accion = match[1];
            const id = match[2];
            const p = pendingActions.get(id);
            if (!p || p.tipo !== 'dia-page' || p.userId !== interaction.user.id) return interaction.reply({ content: '❌ Sesión expirada.', ephemeral: true });

            let d = new Date(p.payload.fecha + 'T00:00:00Z');
            if (accion === 'first') d = new Date(p.payload.minDate + 'T00:00:00Z');
            else if (accion === 'prev') d.setUTCDate(d.getUTCDate() - 1);
            else if (accion === 'next') d.setUTCDate(d.getUTCDate() + 1);
            else if (accion === 'last') d = new Date(p.payload.maxDate + 'T00:00:00Z');

            const nuevaFecha = d.toISOString().split('T')[0];
            p.payload.fecha = nuevaFecha;
            p.expira = Date.now() + 5 * 60 * 1000;

            const miembros = utils.cargarMiembros();
            const db = utils.cargarDB();
            const comprasDia = db.compras.filter(c => c.fecha === nuevaFecha);

            let out = `📅 **Compras del ${utils.formatearFecha(nuevaFecha)}**\n`;
            if (comprasDia.length === 0) out = `📅 No hay compras registradas.`;
            else {
                const grupos = {};
                for (const c of comprasDia) {
                    const key = utils.normalizar(c.evento || 'Sin evento');
                    if (!grupos[key]) grupos[key] = { nombre: utils.nombreBonitoEvento(c.evento), items: [] };
                    grupos[key].items.push(c);
                }
                const eventosOrdenados = Object.keys(grupos).sort((a, b) => utils.ordenEvento(a) - utils.ordenEvento(b));
                for (const key of eventosOrdenados) {
                    out += `\n**__${grupos[key].nombre}__**\n`;
                    const lista = grupos[key].items.sort((a, b) => utils.ordenCategoria(key, a.categoria) - utils.ordenCategoria(key, b.categoria));
                    let bloqueActual = null;
                    for (const c of lista) {
                        const bloque = utils.bloqueDeCategoria(key, c.categoria);
                        if (bloque && bloque !== bloqueActual) { out += `\n**${bloque}**\n`; bloqueActual = bloque; }
                        out += `\n#${c.id} · ${c.cantidad}x ${c.objeto} (${c.categoria})\n   🏆 ${c.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}\n`;
                        if (c.perdedores.length > 0) out += `   💔 ${c.perdedores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ')}\n`;
                        if (c.notas) out += `   📝 ${c.notas}\n`;
                    }
                }
            }
            out += `\n📅 **Compras del ${utils.formatearFecha(nuevaFecha)}**`;

            const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`dia_first_${id}`).setLabel('⏮').setStyle(ButtonStyle.Secondary).setDisabled(nuevaFecha <= p.payload.minDate),
                new ButtonBuilder().setCustomId(`dia_prev_${id}`).setLabel('◀').setStyle(ButtonStyle.Primary).setDisabled(nuevaFecha <= p.payload.minDate),
                new ButtonBuilder().setCustomId(`dia_next_${id}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(nuevaFecha >= p.payload.maxDate),
                new ButtonBuilder().setCustomId(`dia_last_${id}`).setLabel('⏭').setStyle(ButtonStyle.Secondary).setDisabled(nuevaFecha >= p.payload.maxDate)
            );
            return interaction.update({ content: out, components: [row] });
        }

        const pagMatch = cid.match(/^(rank|obj|cat|catg)_(first|prev|next|last)_(.+)$/);
        if (pagMatch) {
            const [_, prefijo, accion, id] = pagMatch;
            const p = pendingActions.get(id);
            const tipoEsperado = prefijo === 'rank' ? 'ranking' : (prefijo === 'obj' ? 'objeto-page' : (prefijo === 'cat' ? 'categoria-page' : 'catalogo-page'));
            if (!p || p.tipo !== tipoEsperado || p.userId !== interaction.user.id) return interaction.reply({ content: '❌ Sesión expirada.', ephemeral: true });

            const payload = p.payload;
            let porPagina = prefijo === 'rank' ? (payload.categoria === 'Todas' ? 10 : 15) : (prefijo === 'obj' ? (payload.formato === 'Clasificación' ? 15 : 10) : (prefijo === 'cat' ? 10 : 15));
            const totalItems = payload.items ? payload.items.length : (payload.jugadores ? payload.jugadores.length : payload.catalogo.length);
            const totalPaginas = Math.max(1, Math.ceil(totalItems / porPagina));

            if (accion === 'first') payload.pagina = 1;
            else if (accion === 'prev') payload.pagina = Math.max(1, payload.pagina - 1);
            else if (accion === 'next') payload.pagina = Math.min(totalPaginas, payload.pagina + 1);
            else if (accion === 'last') payload.pagina = totalPaginas;
            p.expira = Date.now() + 5 * 60 * 1000;

            let render;
            if (tipoEsperado === 'ranking') render = logic.renderRankingPagina(payload);
            else if (tipoEsperado === 'objeto-page') render = logic.renderObjetoPagina(payload, utils.cargarMiembros());
            else if (tipoEsperado === 'categoria-page') render = logic.renderCategoriaPagina(payload, utils.cargarMiembros());
            else if (tipoEsperado === 'catalogo-page') {
                const totalPaginasCat = Math.max(1, Math.ceil(payload.catalogo.length / 15));
                const paginaActualCat = Math.min(Math.max(1, payload.pagina), totalPaginasCat);
                const inicio = (paginaActualCat - 1) * 15;
                const slice = payload.catalogo.slice(inicio, inicio + 15);
                let out = `📖 **Catálogo de Objetos** (Página ${paginaActualCat}/${totalPaginasCat})\n\n`;
                if (slice.length === 0) out += 'No hay objetos guardados.';
                else {
                    for (const item of slice) out += `• **${item.objeto}** → ${item.categoria}\n`;
                }
                render = { content: out, totalPaginas: totalPaginasCat, paginaActual: paginaActualCat };
            }

            const row = logic.construirBotonesPaginacion(prefijo, id, render.paginaActual, render.totalPaginas);
            return interaction.update({ content: render.content, components: [row] });
        }

        if (cid.startsWith('pend_confirm_') || cid.startsWith('pend_cancel_')) {
            const esConfirm = cid.startsWith('pend_confirm_');
            const id = cid.replace('pend_confirm_', '').replace('pend_cancel_', '');
            const p = pendingActions.get(id);
            if (!p) return interaction.update({ content: '❌ La sesión expiró.', components: [] });
            if (p.userId !== interaction.user.id) return interaction.reply({ content: '❌ Solo quien ejecutó el comando puede confirmar.', ephemeral: true });
            if (!esConfirm) {
                pendingActions.delete(id);
                return interaction.update({ content: '❌ Acción cancelada.', components: [] });
            }

            try { await interaction.deferUpdate(); } catch (e) { /* ignorar */ }

            const db = utils.cargarDB();
            const miembros = utils.cargarMiembros();
            let resultado = '';
            let requiereSync = false;
            let ganadoresParaPingear = [];

            if (p.tipo === 'sub' || p.tipo === 'subf') {
                const e = { id: db.nextId++, ...p.payload };
                db.compras.push(e);
                utils.guardarDB(db);
                resultado = `✅ #${e.id} · 📅 ${utils.formatearFecha(e.fecha)} ${utils.etiquetaDias(e.fecha)} · ${utils.nombreBonitoEvento(e.evento)}\n📦 ${e.cantidad}x ${e.objeto} (${e.categoria})\n🏆 ${e.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}${e.perdedores.length ? `\n💔 ${e.perdedores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ')}` : ''}`;
                requiereSync = true;
                ganadoresParaPingear = e.ganadores;
            }
            else if (p.tipo === 'sync') {
                const res = await logic.sincronizarConGitHub(true);
                let msg = res.ok ? `✅ Sync OK\n📤 CSV actualizado con ${res.total} entradas.` : `❌ Sync falló: ${res.motivo}`;
                if (res.ok && res.agregadas > 0) msg += `\n📥 ${res.agregadas} nuevas absorvidas.`;
                await logic.sincronizarArchivosJSON();
                resultado = msg;
                requiereSync = false;
            }
            else if (p.tipo === 'borrar') {
                const idsABorrar = p.payload.ids;
                const borradas = [];
                db.compras = db.compras.filter(c => {
                    if (idsABorrar.includes(c.id)) { borradas.push(c); return false; }
                    return true;
                });
                utils.guardarDB(db);
                resultado = `🗑️ Se borraron **${borradas.length}** entradas:\n` + borradas.map(c => `#${c.id} · ${c.cantidad}x ${c.objeto}`).join('\n');
                requiereSync = true;
            }
            else if (p.tipo === 'editar') {
                const idx = db.compras.findIndex(c => c.id === p.payload.id);
                if (idx === -1) resultado = '❌ La entrada ya no existe.';
                else {
                    const e = db.compras[idx];
                    const { sub, valor } = p.payload;
                    const miembros = utils.cargarMiembros();
                    
                    if (sub === 'ganador') {
                        if (valor.accion === 'agregar') for (const j of valor.nombres) e.ganadores.push(j);
                        else for (const j of valor.nombres) { const pos = utils.buscarJugadorEnLista(e.ganadores, j, miembros); if (pos !== -1) e.ganadores.splice(pos, 1); }
                    }
                    else if (sub === 'perdedor') {
                        if (valor.accion === 'agregar') for (const j of valor.nombres) e.perdedores.push(j);
                        else for (const j of valor.nombres) { const pos = utils.buscarJugadorEnLista(e.perdedores, j, miembros); if (pos !== -1) e.perdedores.splice(pos, 1); }
                    }
                    else if (sub === 'reemplazar-ganador') {
                        const pos = utils.buscarJugadorEnLista(e.ganadores, valor.quitar, miembros);
                        if (pos !== -1) e.ganadores.splice(pos, 1, valor.poner);
                    }
                    else if (sub === 'reemplazar-perdedor') {
                        const pos = utils.buscarJugadorEnLista(e.perdedores, valor.quitar, miembros);
                        if (pos !== -1) e.perdedores.splice(pos, 1, valor.poner);
                    }
                    else if (sub === 'set') {
                        if (valor.objeto) { e.objeto = valor.objeto; if (!valor.categoria) e.categoria = logic.inferirCategoria(valor.objeto, db); }
                        if (valor.cantidad !== undefined && valor.cantidad !== null) e.cantidad = valor.cantidad;
                        if (valor.categoria) e.categoria = valor.categoria;
                        if (valor.evento) e.evento = valor.evento;
                        if (valor.fecha) e.fecha = valor.fecha;
                    }
                    else if (sub === 'set-nota') e.notas = valor;
                    else if (sub === 'borrar-nota') e.notas = '';
                    
                    utils.guardarDB(db);
                    resultado = `✅ Edición aplicada a #${e.id}.\n\n#${e.id} · ${utils.formatearFecha(e.fecha)} ${utils.etiquetaDias(e.fecha)} · ${utils.nombreBonitoEvento(e.evento)} · ${e.cantidad}x ${e.objeto} (${e.categoria})\n🏆 ${e.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}\n`;
                    if (e.perdedores.length > 0) resultado += `💔 ${e.perdedores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ')}\n`;
                    if (e.notas) resultado += `📝 ${e.notas}`;
                    requiereSync = true;
                }
            }
            else if (p.tipo === 'registro-rapido') {
                const existentes = new Set(db.compras.map(logic.huella));
                let agregadas = 0, duplicados = 0;
                for (const entrada of p.payload.entradas) {
                    const nueva = { id: db.nextId, ...entrada };
                    if (existentes.has(logic.huella(nueva))) { duplicados++; continue; }
                    db.compras.push(nueva);
                    existentes.add(logic.huella(nueva));
                    db.nextId++;
                    agregadas++;
                    ganadoresParaPingear.push(...nueva.ganadores);
                }
                utils.guardarDB(db);
                resultado = `✅ **${agregadas}** entradas registradas.`;
                if (duplicados > 0) resultado += `\n⚠️ ${duplicados} duplicadas ignoradas.`;
                resultado += `\nTotal en la base: **${db.compras.length}**.`;
                requiereSync = true;
            }

            resultado = resultado.trimEnd();

            pendingActions.delete(id);
            if (requiereSync) {
                const syncRes = await logic.sincronizarConGitHub(false);
                resultado += textoEstadoSync(syncRes);
            }

            await interaction.editReply({ content: '✅ Acción completada.', components: [] });
            
            if (ganadoresParaPingear.length > 0) {
                const pingText = logic.formatearPingGanadores(ganadoresParaPingear, [], miembros, interaction.guild);
                await interaction.followUp({ content: `${resultado}\n\n${pingText}`, ephemeral: false });
            } else {
                await interaction.followUp({ content: resultado, ephemeral: false });
            }
            
            return;
        }

        if (cid.startsWith('ping_confirm_') || cid.startsWith('ping_cancel_')) {
            const esConfirm = cid.startsWith('ping_confirm_');
            const id = cid.replace('ping_confirm_', '').replace('ping_cancel_', '');
            const p = pendingActions.get(id);
            if (!p || p.tipo !== 'ping' || p.userId !== interaction.user.id) return interaction.update({ content: '❌ Sesión expirada.', components: [] });
            
            pendingActions.delete(id);
            if (!esConfirm) return interaction.update({ content: '❌ Aviso cancelado.', components: [] });

            await interaction.update({ content: '✅ Aviso enviado.', components: [] });
            await interaction.channel.send(`🔔 Aviso para: ${p.payload.menciones.join(', ')}`);
            return;
        }

        return;
    }

    // 3. Comandos Slash
    if (!interaction.isChatInputCommand()) return;
    
    const comandosAdmin = ['backup', 'sync', 'registro-rapido'];
    const comandosLider = ['miembros', 'catalogo'];
    const comandosHelper = ['borrar', 'editar', 'sub', 'subf'];
    
    if (comandosAdmin.includes(interaction.commandName) || comandosLider.includes(interaction.commandName) || comandosHelper.includes(interaction.commandName)) {
        const esDueño = interaction.guild && interaction.guild.ownerId === interaction.user.id;
        const tieneLider = interaction.member && interaction.member.roles.cache.has(utils.ROL_LIDER);
        const tieneHelper = interaction.member && interaction.member.roles.cache.has(utils.ROL_HELPER);
        const esAdmin = interaction.member && interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        
        const puedeAdmin = esDueño || esAdmin;
        const puedeLider = puedeAdmin || tieneLider;
        const puedeHelper = puedeLider || tieneHelper;

        if (comandosAdmin.includes(interaction.commandName) && !puedeAdmin) {
            return interaction.reply({ content: '❌ No tienes permiso (solo Administradores).', ephemeral: true });
        }
        if (comandosLider.includes(interaction.commandName) && !puedeLider) {
            return interaction.reply({ content: '❌ No tienes permiso (solo Líderes/Admins).', ephemeral: true });
        }
        if (comandosHelper.includes(interaction.commandName) && !puedeHelper) {
            return interaction.reply({ content: '❌ No tienes permiso (solo Líderes/Helpers/Admins).', ephemeral: true });
        }
    }

    const db = utils.cargarDB();
    const miembros = utils.cargarMiembros();

    try {
        if (interaction.commandName === 'sync') {
            let cuerpo = `Esta acción fusionará el archivo \`historial.csv\` de GitHub con tu base de datos local, y luego subirá los datos combinados de vuelta a GitHub.\n\n⚠️ **Advertencias:**\n• Si borraste una compra recientemente y no llegó a subirse a GitHub, el /sync podría "resucitarla".\n• Si el archivo en GitHub fue editado manualmente con errores, esos errores se importarán al bot.\n\n¿Estás seguro de que deseas continuar?`;
            return mostrarPreview(interaction, 'Confirmar Sincronización', cuerpo, 'sync', {});
        }

        if (interaction.commandName === 'registro-rapido') {
            const texto = interaction.options.getString('texto') || '';
            if (!texto.trim()) return interaction.reply({ content: '❌ No hay texto.', ephemeral: true });
            let textoConHeader = texto.trim();
            if (!textoConHeader.toLowerCase().startsWith('fecha')) textoConHeader = 'fecha,evento,categoria,objeto,cantidad,ganadores,perdedores,notas\n' + textoConHeader;
            
            let filas;
            try { filas = parse(textoConHeader, { columns: true, skip_empty_lines: true, trim: true }); }
            catch (e) { return interaction.reply({ content: `❌ Error CSV: ${e.message}`, ephemeral: true }); }

            const validas = [];
            const errores = [];
            for (let i = 0; i < filas.length; i++) {
                const fila = filas[i];
                const fechaConv = utils.convertirFecha(fila.fecha);
                if (!fechaConv) { errores.push(`Fila ${i+2}: fecha inválida`); continue; }
                if (fila.categoria && !utils.CATEGORIAS.includes(fila.categoria)) { errores.push(`Fila ${i+2}: categoría inválida`); continue; }
                if (fila.objeto && utils.OBJETOS_PROHIBIDOS.some(o => utils.normalizar(o) === utils.normalizar(fila.objeto))) { errores.push(`Fila ${i+2}: objeto prohibido`); continue; }
                
                validas.push({
                    fecha: fechaConv, evento: fila.evento || '', categoria: fila.categoria || '', objeto: fila.objeto || '',
                    cantidad: parseInt(fila.cantidad) || 1,
                    ganadores: fila.ganadores ? fila.ganadores.split(',').map(s => s.trim()).filter(Boolean) : [],
                    perdedores: fila.perdedores ? fila.perdedores.split(',').map(s => s.trim()).filter(Boolean) : [],
                    notas: fila.notas || ''
                });
            }
            if (validas.length === 0) return interaction.reply({ content: `❌ Ninguna fila válida.\n${errores.slice(0, 5).join('\n')}`, ephemeral: true });

            let preview = `📋 **Preview — ${validas.length} entrada(s)**\n\n`;
            validas.slice(0, 5).forEach((v, i) => {
                preview += `**${i+1}.** ${utils.formatearFecha(v.fecha)} ${utils.etiquetaDias(v.fecha)} · ${utils.nombreBonitoEvento(v.evento)} · ${v.cantidad}x ${v.objeto} (${v.categoria})\n   🏆 ${v.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}\n`;
            });
            if (validas.length > 5) preview += `... y ${validas.length - 5} más.\n`;
            if (errores.length > 0) preview += `\n⚠️ **${errores.length} errores:**\n${errores.slice(0, 5).join('\n')}`;

            return mostrarPreview(interaction, 'Confirmar registro rápido', preview, 'registro-rapido', { entradas: validas });
        }

        if (interaction.commandName === 'backup') {
            const fs = require('fs');
            const { AttachmentBuilder } = require('discord.js');
            const contenido = logic.generarCSV(db);
            fs.writeFileSync(utils.BACKUP_FILE, contenido);
            const adjunto = new AttachmentBuilder(Buffer.from(contenido, 'utf8'), { name: 'backup.csv' });
            return interaction.reply({ content: `✅ Respaldo guardado. Total: **${db.compras.length}**.`, files: [adjunto] });
        }

        if (interaction.commandName === 'catalogo') {
            const sub = interaction.options.getSubcommand();
            const catalogo = utils.cargarCatalogo();

            if (sub === 'agregar') {
                const obj = interaction.options.getString('objeto').trim();
                const cat = interaction.options.getString('categoria');
                catalogo[obj] = cat;
                utils.guardarCatalogo(catalogo);
                await logic.sincronizarArchivosJSON();
                return interaction.reply({ content: `✅ Objeto **${obj}** guardado en el catálogo como **${cat}**.`, ephemeral: true });
            }
            if (sub === 'quitar') {
                const obj = interaction.options.getString('objeto').trim();
                const keyEncontrada = Object.keys(catalogo).find(k => utils.normalizar(k) === utils.normalizar(obj));
                if (!keyEncontrada) return interaction.reply({ content: `ℹ️ El objeto **${obj}** no está en el catálogo.`, ephemeral: true });
                delete catalogo[keyEncontrada];
                utils.guardarCatalogo(catalogo);
                await logic.sincronizarArchivosJSON();
                return interaction.reply({ content: `✅ Objeto **${keyEncontrada}** eliminado del catálogo.`, ephemeral: true });
            }
            if (sub === 'lista') {
                const items = Object.entries(catalogo).map(([objeto, categoria]) => ({ objeto, categoria })).sort((a, b) => a.objeto.localeCompare(b.objeto));
                if (items.length === 0) return interaction.reply({ content: 'ℹ️ El catálogo está vacío.', ephemeral: true });
                
                const payload = { catalogo: items, pagina: 1 };
                const id = guardarPendiente('catalogo-page', payload, interaction.user.id);
                
                const totalPaginas = Math.max(1, Math.ceil(items.length / 15));
                const slice = items.slice(0, 15);
                let out = `📖 **Catálogo de Objetos** (Página 1/${totalPaginas})\n\n`;
                for (const item of slice) out += `• **${item.objeto}** → ${item.categoria}\n`;
                
                const row = logic.construirBotonesPaginacion('catg', id, 1, totalPaginas);
                return interaction.reply({ content: out, components: [row], ephemeral: true });
            }
        }

        if (interaction.commandName === 'objeto') {
            const nombreBuscado = interaction.options.getString('nombre').trim();
            const periodo = interaction.options.getString('periodo') || 'Total';
            const formato = interaction.options.getString('formato') || 'Lista';
            const visibilidad = interaction.options.getString('visibilidad') || 'Privado';
            const ephemeral = visibilidad === 'Privado';

            const keyBuscado = utils.normalizar(nombreBuscado);
            const comprasFiltradas = utils.filtrarPorPeriodo(db.compras, periodo);
            const apariciones = comprasFiltradas.filter(c => c.objeto && utils.normalizar(c.objeto) === keyBuscado && c.ganadores.length > 0).sort(utils.ordenarComprasDesc);

            if (apariciones.length === 0) return interaction.reply({ content: `❌ No hay apariciones de **${nombreBuscado}** en ${periodo}.`, ephemeral });

            const nombreDisplay = apariciones[0].objeto;
            let items;
            if (formato === 'Clasificación') {
                const conteos = {};
                for (const c of apariciones) for (const g of c.ganadores) {
                    const { nombre, cantidad } = utils.parsearGanador(g);
                    const key = utils.claveJugador(nombre, miembros);
                    if (!conteos[key]) conteos[key] = { nombre: utils.aplicarCanonico(nombre, miembros), total: 0 };
                    conteos[key].total += cantidad;
                }
                items = Object.values(conteos).sort((a, b) => b.total - a.total);
            } else items = apariciones;

            const payload = { nombreDisplay, periodo, formato, items, pagina: 1 };
            const id = guardarPendiente('objeto-page', payload, interaction.user.id);
            const render = logic.renderObjetoPagina(payload, miembros);
            const row = logic.construirBotonesPaginacion('obj', id, render.paginaActual, render.totalPaginas);
            return interaction.reply({ content: render.content, components: [row], ephemeral });
        }

        if (interaction.commandName === 'categoria') {
            const categoria = interaction.options.getString('categoria');
            const jugadorFiltro = (interaction.options.getString('jugador') || '').trim();
            const periodo = interaction.options.getString('periodo') || 'Total';
            const visibilidad = interaction.options.getString('visibilidad') || 'Privado';
            const ephemeral = visibilidad === 'Privado';

            const comprasFiltradas = utils.filtrarPorPeriodo(db.compras, periodo);
            let apariciones = comprasFiltradas.filter(c => c.categoria === categoria);
            if (jugadorFiltro) apariciones = apariciones.filter(c => utils.contarGanador(c.ganadores, jugadorFiltro, miembros) > 0);
            apariciones = apariciones.sort(utils.ordenarComprasDesc);

            if (apariciones.length === 0) return interaction.reply({ content: `❌ No hay apariciones de **${categoria}**.`, ephemeral });

            const payload = { categoria, jugadorFiltro, periodo, items: apariciones, pagina: 1 };
            const id = guardarPendiente('categoria-page', payload, interaction.user.id);
            const render = logic.renderCategoriaPagina(payload, miembros);
            const row = logic.construirBotonesPaginacion('cat', id, render.paginaActual, render.totalPaginas);
            return interaction.reply({ content: render.content, components: [row], ephemeral });
        }

        if (interaction.commandName === 'alertas') {
            const visibilidad = interaction.options.getString('visibilidad') || 'Privado';
            const ephemeral = visibilidad === 'Privado';
            const recientes = utils.filtrarPorPeriodo(db.compras, '7d');
            const conteos = {};
            for (const c of recientes) for (const g of c.ganadores) {
                const { nombre, cantidad } = utils.parsearGanador(g);
                if (utils.esExcluido(nombre, miembros)) continue;
                const key = utils.claveJugador(nombre, miembros);
                if (!conteos[key]) { conteos[key] = { nombre: utils.aplicarCanonico(nombre, miembros) }; for (const cat of utils.CATEGORIAS) conteos[key][cat] = 0; }
                if (conteos[key][c.categoria] !== undefined) conteos[key][c.categoria] += cantidad;
            }
            const UMBRALES = { 'Emblemas Únicos': 3, 'Emblemas Generales': 5, 'Cajas 20k': 4, 'Accesorios': 3, 'Equipo': 3 };
            let out = `🚨 **Alertas (últimos 7d)**\n`;
            let total = 0;
            for (const [cat, umbral] of Object.entries(UMBRALES)) {
                const superan = Object.values(conteos).filter(v => (v[cat] || 0) >= umbral).sort((a, b) => b[cat] - a[cat]);
                if (superan.length === 0) continue;
                total += superan.length;
                out += `\n**${cat}** (umbral ${umbral}):\n` + superan.map(v => `   ${v.nombre}: ${v[cat]}`).join('\n') + '\n';
            }
            if (total === 0) out += `\n✅ Nadie supera los umbrales.`;
            return logic.responderLargo(interaction, out, ephemeral);
        }

        if (interaction.commandName === 'miembros') {
            const sub = interaction.options.getSubcommand();
            if (sub === 'lista') {
                const can = Object.entries(miembros.canonicos || {}).map(([k, v]) => `\`${k}\` → **${v}**`).join('\n') || '(ninguno)';
                const ex = miembros.excluidos.map(e => `• ${e}`).join('\n') || '(ninguno)';
                return interaction.reply({ content: `**Canónicos registrados:**\n${can}\n\n**Excluidos del ranking:**\n${ex}`, ephemeral: true });
            }
            if (sub === 'excluidos') {
                const ex = miembros.excluidos.map(e => `• ${e}`).join('\n') || '(ninguno)';
                return interaction.reply({ content: `**Excluidos del ranking:**\n${ex}`, ephemeral: true });
            }
            const nombreRaw = interaction.options.getString('nombre');
            const nombres = nombreRaw.split(',').map(s => s.trim()).filter(Boolean);

            if (sub === 'excluir') {
                const ag = [], ya = [], vistos = new Set();
                for (const n of nombres) {
                    const c = utils.aplicarCanonico(n, miembros);
                    const k = utils.claveJugador(c, miembros);
                    if (vistos.has(k)) continue; vistos.add(k);
                    if (utils.esExcluido(c, miembros)) ya.push(c);
                    else { miembros.excluidos.push(c); ag.push(c); }
                }
                if (ag.length === 0) return interaction.reply({ content: `ℹ️ Ya estaban excluidos: ${ya.join(', ')}`, ephemeral: true });
                utils.guardarMiembros(miembros);
                await logic.sincronizarArchivosJSON();
                let msg = `✅ **Excluidos:** ${ag.join(', ')}`;
                if (ya.length > 0) msg += `\nℹ️ Ya estaban: ${ya.join(', ')}`;
                return interaction.reply({ content: msg });
            }
            if (sub === 'incluir') {
                const quit = [], no = [], vistos = new Set();
                for (const n of nombres) {
                    const c = utils.aplicarCanonico(n, miembros);
                    const k = utils.claveJugador(c, miembros);
                    if (vistos.has(k)) continue; vistos.add(k);
                    const idx = miembros.excluidos.findIndex(e => utils.claveJugador(e, miembros) === k);
                    if (idx === -1) no.push(c);
                    else { miembros.excluidos.splice(idx, 1); quit.push(c); }
                }
                if (quit.length === 0) return interaction.reply({ content: `ℹ️ No estaban excluidos: ${no.join(', ')}`, ephemeral: true });
                utils.guardarMiembros(miembros);
                await logic.sincronizarArchivosJSON();
                let msg = `✅ **Reincluidos:** ${quit.join(', ')}`;
                if (no.length > 0) msg += `\nℹ️ No estaban: ${no.join(', ')}`;
                return interaction.reply({ content: msg });
            }
            if (sub === 'canonico') {
                const como = interaction.options.getString('como');
                for (const n of nombres) miembros.canonicos[utils.normalizarNombre(n)] = como;
                utils.guardarMiembros(miembros);
                await logic.sincronizarArchivosJSON();
                return interaction.reply({ content: `✅ ${nombres.join(', ')} se mostrarán como **${como}**.` });
            }
            if (sub === 'quitar-canonico') {
                const key = utils.normalizarNombre(nombres[0]);
                if (!miembros.canonicos[key]) return interaction.reply({ content: `ℹ️ No hay canónico para **${nombres[0]}**.`, ephemeral: true });
                const prev = miembros.canonicos[key];
                delete miembros.canonicos[key];
                utils.guardarMiembros(miembros);
                await logic.sincronizarArchivosJSON();
                return interaction.reply({ content: `✅ Canónico eliminado para **${prev}**.` });
            }
        }

        if (interaction.commandName === 'editar') {
            const sub = interaction.options.getSubcommand();
            const id = interaction.options.getInteger('id');
            const idx = db.compras.findIndex(c => c.id === id);
            if (idx === -1) return interaction.reply({ content: `❌ No existe entrada #${id}.`, ephemeral: true });
            const e = db.compras[idx];
            let cuerpo = '', payload = null;

            if (sub === 'ganador' || sub === 'perdedor') {
                const accion = interaction.options.getString('accion');
                const str = interaction.options.getString('jugador');
                const nombres = str.split(',').map(s => s.trim()).filter(Boolean).map(n => utils.aplicarCanonico(n, miembros));
                const lista = sub === 'ganador' ? e.ganadores : e.perdedores;
                const listaNombre = sub === 'ganador' ? 'ganadores' : 'perdedores';
                
                const ag = [], ya = [], vistos = new Set();
                for (const j of nombres) {
                    const k = utils.claveJugador(j, miembros);
                    if (vistos.has(k)) continue; vistos.add(k);
                    const enLista = utils.buscarJugadorEnLista(lista, j, miembros) !== -1;
                    if (accion === 'agregar' && !enLista) ag.push(j);
                    else if (accion === 'quitar' && enLista) ag.push(j);
                    else ya.push(j);
                }

                if (ag.length === 0) return interaction.reply({ content: `ℹ️ No se aplicaron cambios: ${ya.join(', ')}`, ephemeral: true });
                
                cuerpo = `${accion === 'agregar' ? 'Agregar' : 'Quitar'} **${ag.join(', ')}** a ${listaNombre} de #${id}.\n\n#${e.id} · ${e.cantidad}x ${e.objeto} (${e.categoria})`;
                payload = { id, sub, valor: { accion, nombres: ag } };
            }
            else if (sub === 'reemplazar-ganador' || sub === 'reemplazar-perdedor') {
                const q = interaction.options.getString('jugador').trim();
                const p = interaction.options.getString('por').trim();
                const lista = sub === 'reemplazar-ganador' ? e.ganadores : e.perdedores;
                const listaNombre = sub === 'reemplazar-ganador' ? 'ganadores' : 'perdedores';
                
                if (utils.buscarJugadorEnLista(lista, q, miembros) === -1) return interaction.reply({ content: `❌ **${q}** no está en ${listaNombre}.`, ephemeral: true });
                if (utils.buscarJugadorEnLista(lista, p, miembros) !== -1) return interaction.reply({ content: `❌ **${p}** ya está en ${listaNombre}.`, ephemeral: true });
                
                cuerpo = `Reemplazar a **${utils.aplicarCanonico(q, miembros)}** por **${utils.aplicarCanonico(p, miembros)}** en ${listaNombre} de #${id}.\n\n#${e.id} · ${e.cantidad}x ${e.objeto} (${e.categoria})`;
                payload = { id, sub, valor: { quitar: q, poner: p } };
            }
            else if (sub === 'set') {
                const obj = interaction.options.getString('objeto');
                const cant = interaction.options.getInteger('cantidad');
                const cat = interaction.options.getString('categoria');
                const ev = interaction.options.getString('evento');
                const fechaStr = interaction.options.getString('fecha');
                
                if (!obj && cant === null && !cat && !ev && !fechaStr) return interaction.reply({ content: '❌ Tenés que indicar al menos un campo para cambiar.', ephemeral: true });
                
                let cambios = [];
                let fConv = null;
                if (obj) cambios.push(`Objeto: **${obj}**`);
                if (cant !== null) cambios.push(`Cantidad: **${cant}**`);
                if (cat) cambios.push(`Categoría: **${cat}**`);
                if (ev) cambios.push(`Evento: **${ev}**`);
                if (fechaStr) {
                    fConv = utils.convertirFecha(fechaStr);
                    if (!fConv) return interaction.reply({ content: '❌ Fecha inválida.', ephemeral: true });
                    cambios.push(`Fecha: **${utils.formatearFecha(fConv)}**`);
                }
                
                if (obj && !cat) {
                    const catInferida = logic.inferirCategoria(obj, db);
                    cambios.push(`(Categoría inferida: **${catInferida}**)`);
                }
                
                cuerpo = `Cambiar en #${id}:\n` + cambios.join('\n');
                payload = { id, sub, valor: { objeto: obj, cantidad: cant, categoria: cat, evento: ev, fecha: fConv } };
            }
            else if (sub === 'set-nota') {
                cuerpo = `Cambiar nota de #${id} a:\n📝 ${interaction.options.getString('nota')}`;
                payload = { id, sub, valor: interaction.options.getString('nota') };
            }
            else if (sub === 'borrar-nota') {
                if (!e.notas) return interaction.reply({ content: `ℹ️ La entrada #${id} no tiene nota.`, ephemeral: true });
                cuerpo = `Borrar nota de #${id}.\nActual: 📝 ${e.notas}`;
                payload = { id, sub };
            }
            return mostrarPreview(interaction, 'Confirmar edición', cuerpo, 'editar', payload);
        }

        if (interaction.commandName === 'sub' || interaction.commandName === 'subf') {
            const evento = interaction.options.getString('evento') || '';
            const categoria = interaction.options.getString('categoria');
            const objeto = interaction.options.getString('objeto');
            const cantidad = interaction.options.getInteger('cantidad') || 1;
            const gStr = interaction.options.getString('ganadores') || '';
            const pStr = interaction.options.getString('perdedores') || '';
            let fecha;

            if (interaction.commandName === 'subf') {
                fecha = utils.convertirFecha(interaction.options.getString('fecha'));
                if (!fecha) return interaction.reply({ content: '❌ Fecha inválida.', ephemeral: true });
            } else fecha = utils.fechaHoyArgentina();

            if (utils.OBJETOS_PROHIBIDOS.some(o => utils.normalizar(o) === utils.normalizar(objeto))) return interaction.reply({ content: `❌ Objeto prohibido.`, ephemeral: true });

            const entrada = { fecha, evento, categoria, objeto, cantidad, ganadores: gStr.split(',').map(s => s.trim()).filter(Boolean), perdedores: pStr.split(',').map(s => s.trim()).filter(Boolean), notas: '' };
            let cuerpo = `📅 ${utils.formatearFecha(fecha)} ${utils.etiquetaDias(fecha)} · ${utils.nombreBonitoEvento(evento)}\n📦 ${cantidad}x ${objeto} (${categoria})\n🏆 ${entrada.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}`;
            if (entrada.perdedores.length > 0) cuerpo += `\n💔 ${entrada.perdedores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ')}`;
            return mostrarPreview(interaction, 'Confirmar registro', cuerpo, interaction.commandName, entrada);
        }

        if (interaction.commandName === 'dia') {
            const fecha = utils.convertirFechaDia(interaction.options.getString('fecha'));
            if (!fecha) return interaction.reply({ content: '❌ Fecha inválida.', ephemeral: true });
            const visibilidad = interaction.options.getString('visibilidad') || 'Privado';
            const ephemeral = visibilidad === 'Privado';

            let minDate = utils.fechaHoyArgentina(), maxDate = utils.fechaHoyArgentina();
            if (db.compras.length > 0) {
                const fechas = db.compras.map(c => c.fecha).filter(Boolean).sort();
                minDate = fechas[0]; maxDate = fechas[fechas.length - 1];
            }
            const payload = { fecha, visibilidad, minDate, maxDate };
            const id = guardarPendiente('dia-page', payload, interaction.user.id);
            const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`dia_first_${id}`).setLabel('⏮').setStyle(ButtonStyle.Secondary).setDisabled(fecha <= minDate),
                new ButtonBuilder().setCustomId(`dia_prev_${id}`).setLabel('◀').setStyle(ButtonStyle.Primary).setDisabled(fecha <= minDate),
                new ButtonBuilder().setCustomId(`dia_next_${id}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(fecha >= maxDate),
                new ButtonBuilder().setCustomId(`dia_last_${id}`).setLabel('⏭').setStyle(ButtonStyle.Secondary).setDisabled(fecha >= maxDate)
            );
            const comprasDia = db.compras.filter(c => c.fecha === fecha);
            let out = `📅 **Compras del ${utils.formatearFecha(fecha)}**\n`;
            if (comprasDia.length === 0) out = `📅 No hay compras registradas.`;
            else {
                const grupos = {};
                for (const c of comprasDia) { const k = utils.normalizar(c.evento || 'Sin evento'); if (!grupos[k]) grupos[k] = { nombre: utils.nombreBonitoEvento(c.evento), items: [] }; grupos[k].items.push(c); }
                const evOrd = Object.keys(grupos).sort((a, b) => utils.ordenEvento(a) - utils.ordenEvento(b));
                for (const k of evOrd) {
                    out += `\n**__${grupos[k].nombre}__**\n`;
                    const lista = grupos[k].items.sort((a, b) => utils.ordenCategoria(k, a.categoria) - utils.ordenCategoria(k, b.categoria));
                    let bloqueAct = null;
                    for (const c of lista) {
                        const b = utils.bloqueDeCategoria(k, c.categoria);
                        if (b && b !== bloqueAct) { out += `\n**${b}**\n`; bloqueAct = b; }
                        out += `\n#${c.id} · ${c.cantidad}x ${c.objeto} (${c.categoria})\n   🏆 ${c.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}\n`;
                        if (c.perdedores.length > 0) out += `   💔 ${c.perdedores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ')}\n`;
                        if (c.notas) out += `   📝 ${c.notas}\n`;
                    }
                }
            }
            out += `\n📅 **Compras del ${utils.formatearFecha(fecha)}**`;
            return interaction.reply({ content: out, components: [row], ephemeral });
        }

        if (interaction.commandName === 'historial' || interaction.commandName === 'historial2') {
            const ephemeral = interaction.commandName === 'historial';
            const jugadores = interaction.options.getString('jugadores').split(',').map(s => s.trim()).filter(Boolean);
            const categoria = interaction.options.getString('categoria') || 'Todas';
            const formato = interaction.options.getString('formato') || 'Resumido';

            if (formato === 'Detallado' && categoria !== 'Todas') return interaction.reply({ content: '❌ Detallado solo con Categoría = Todas.', ephemeral });

            let out = '';
            if (formato === 'Resumido') {
                const bloques = [];
                for (const j of jugadores) {
                    let comprasJ = db.compras.filter(c => utils.contarGanador(c.ganadores, j, miembros) > 0);
                    if (categoria !== 'Todas') comprasJ = comprasJ.filter(c => c.categoria === categoria);
                    comprasJ.sort(utils.ordenarComprasDesc);
                    const ultimas = comprasJ.slice(0, 5);
                    let bloque = `📜 **${utils.aplicarCanonico(j, miembros)}** (últimas ${ultimas.length})\n`;
                    for (const c of ultimas) {
                        const n = utils.contarGanador(c.ganadores, j, miembros);
                        bloque += `#${c.id} · ${utils.formatearFecha(c.fecha)} ${utils.etiquetaDias(c.fecha)} · ${n}x ${c.objeto} (${c.categoria})\n`;
                    }
                    bloques.push(bloque);
                }
                out = bloques.join('\n');
            } else {
                const bloques = [];
                for (const j of jugadores) {
                    let comprasJ = db.compras.filter(c => utils.contarGanador(c.ganadores, j, miembros) > 0).sort(utils.ordenarComprasDesc);
                    let bloque = `📜 **${utils.aplicarCanonico(j, miembros)}** (por categoría)\n`;
                    for (const cat of utils.CATEGORIAS) {
                        const filtradas = comprasJ.filter(c => c.categoria === cat).slice(0, 5);
                        if (filtradas.length === 0) continue;
                        bloque += `\n**${cat}** (últimas ${filtradas.length}):\n`;
                        for (const c of filtradas) {
                            const n = utils.contarGanador(c.ganadores, j, miembros);
                            bloque += `#${c.id} · ${utils.formatearFecha(c.fecha)} ${utils.etiquetaDias(c.fecha)} · ${n}x ${c.objeto}\n`;
                        }
                    }
                    bloques.push(bloque);
                }
                out = bloques.join('\n');
            }
            return logic.responderLargo(interaction, out, ephemeral);
        }

        if (interaction.commandName === 'total') {
            const jugadores = interaction.options.getString('jugadores').split(',').map(s => s.trim()).filter(Boolean);
            const visibilidad = interaction.options.getString('visibilidad') || 'Visible';
            const periodo = interaction.options.getString('periodo') || 'Total';
            const comprasFiltradas = utils.filtrarPorPeriodo(db.compras, periodo);

            let out = '';
            for (const j of jugadores) {
                const totales = {}; for (const cat of utils.CATEGORIAS) totales[cat] = 0;
                for (const c of comprasFiltradas) { const n = utils.contarGanador(c.ganadores, j, miembros); if (n > 0 && totales[c.categoria] !== undefined) totales[c.categoria] += n; }
                const total = Object.values(totales).reduce((a, b) => a + b, 0);
                const lineas = utils.CATEGORIAS_TOTAL.map(cat => `${cat}: ${totales[cat] || 0}`).join('\n');
                out += `📊 **Total de ${utils.aplicarCanonico(j, miembros)}** (${periodo})\n${lineas}\n────────────\n**TOTAL:** ${total}\n\n`;
            }
            return logic.responderLargo(interaction, out.trimEnd(), visibilidad === 'Privado');
        }

        if (interaction.commandName === 'ranking') {
            const visibilidad = interaction.options.getString('visibilidad') || 'Visible';
            const periodo = interaction.options.getString('periodo') || 'Total';
            const catFiltro = interaction.options.getString('categoria') || 'Todas';
            const comprasFiltradas = utils.filtrarPorPeriodo(db.compras, periodo);
            const jugadores = logic.construirRanking(comprasFiltradas, catFiltro, miembros);
            const payload = { jugadores, periodo, categoria: catFiltro, pagina: 1 };
            const id = guardarPendiente('ranking', payload, interaction.user.id);
            const render = logic.renderRankingPagina(payload);
            const row = logic.construirBotonesPaginacion('rank', id, render.paginaActual, render.totalPaginas);
            return interaction.reply({ content: render.content, components: [row], ephemeral: visibilidad === 'Privado' });
        }

        if (interaction.commandName === 'prioridad') {
            const categoria = interaction.options.getString('categoria');
            const jugadores = interaction.options.getString('jugadores').split(',').map(s => s.trim()).filter(Boolean);
            const visibilidad = interaction.options.getString('visibilidad') || 'Visible';
            const ephemeral = visibilidad === 'Privado';

            const resultados = jugadores.map(j => ({ jugador: j, ...logic.calcularPrioridad(j, categoria, db.compras, miembros) }));
            resultados.sort(logic.compararPrioridad);
            const payload = { categoria, jugadores, resultados, ventanaActual: 'prioridad' };
            const id = guardarPendiente('prioridad-page', payload, interaction.user.id);
            payload.id = id;

            const { content, components } = logic.renderPrioridad(payload, miembros);
            return interaction.reply({ content, components, ephemeral });
        }

        if (interaction.commandName === 'borrar') {
            const idsStr = interaction.options.getString('ids');
            const ids = idsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
            if (ids.length === 0) return interaction.reply({ content: '❌ No se encontraron IDs válidos.', ephemeral: true });
            
            const validos = db.compras.filter(c => ids.includes(c.id));
            const noExisten = ids.filter(id => !db.compras.some(c => c.id === id));
            
            if (validos.length === 0) return interaction.reply({ content: '❌ No existe ninguna entrada con esos IDs.', ephemeral: true });
            
            let cuerpo = `Se borrarán **${validos.length}** entradas:\n\n`;
            validos.forEach(c => {
                cuerpo += `#${c.id} · ${utils.formatearFecha(c.fecha)} ${utils.etiquetaDias(c.fecha)} · ${c.cantidad}x ${c.objeto} (${c.categoria})\n`;
                cuerpo += `   🏆 ${c.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}\n`;
                if (c.perdedores && c.perdedores.length > 0) {
                    cuerpo += `   💔 ${c.perdedores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ')}\n`;
                }
            });
            if (noExisten.length > 0) {
                cuerpo += `\n⚠️ **No existen:** ${noExisten.join(', ')}`;
            }
            
            return mostrarPreview(interaction, '⚠️ Confirmar BORRADO MÚLTIPLE', cuerpo, 'borrar', { ids: validos.map(c => c.id) });
        }

        if (interaction.commandName === 'ayuda') {
            return interaction.reply({
                content: `**Comandos:**\n\`/sub\` · registrar compra\n\`/subf\` · registrar con fecha\n\`/registro-rapido\` · registrar varias entradas (Admin)\n\`/historial\` · historial privado\n\`/historial2\` · historial público\n\`/dia\` · compras de un día\n\`/total\` · totales por categoría\n\`/ranking\` · tabla general\n\`/prioridad\` · calcular prioridad\n\`/alertas\` · alertas de acaparamiento\n\`/objeto\` · apariciones de un objeto\n\`/categoria\` · apariciones de una categoría\n\`/catalogo\` · gestionar catálogo de objetos (Líder)\n\`/backup\` · exportar CSV (Admin)\n\`/sync\` · sincronizar con GitHub (Admin)\n\`/miembros\` · gestionar nombres y exclusiones\n\`/editar\` · editar entrada\n\`/borrar\` · borrar por ID\n\`/ayuda\` · este mensaje\n\n**Paneles:**\n\`/panel crear\` · crear panel\n\`/panel ver\` · mostrar panel\n\`/panel objeto\` · cambiar objeto\n\`/panel interesado\` · añadir/quitar interesados\n\`/panel cancelar\` · cancelar subasta\n\`/panel indice\` · crear/actualizar índice\n\`/panel refresh\` · forzar actualización\n\n**Control:**\n\`/control agregar\` · añadir thread fijo\n\`/control quitar\` · quitar thread fijo\n\`/control panel\` · crear/actualizar Panel de Control`,
                ephemeral: true
            });
        }

    } catch (err) {
        console.error(err);
        if (!interaction.replied) {
            try { interaction.reply({ content: '❌ Error. Revisa los logs.', ephemeral: true }); } catch (e) {}
        }
    }
});

setupPanel(client, {
    cargarDB: utils.cargarDB,
    guardarDB: utils.guardarDB,
    sincronizarConGitHub: logic.sincronizarConGitHub,
    calcularPrioridad: logic.calcularPrioridad,
    compararPrioridad: logic.compararPrioridad,
    formatearNombreConCantidad: utils.formatearNombreConCantidad,
    aplicarCanonico: utils.aplicarCanonico,
    contarGanador: utils.contarGanador,
    obtenerNombresUnicos: logic.obtenerNombresUnicos,
    obtenerObjetosUnicos: logic.obtenerObjetosUnicos,
    cargarMiembros: utils.cargarMiembros,
    normalizar: utils.normalizar,
    fechaHoyArgentina: utils.fechaHoyArgentina,
    renderPrioridad: logic.renderPrioridad,
    guardarPendiente: guardarPendiente,
    formatearPingGanadores: logic.formatearPingGanadores,
    ROL_LIDER: utils.ROL_LIDER,
    ROL_HELPER: utils.ROL_HELPER
});

client.login(process.env.DISCORD_TOKEN);
