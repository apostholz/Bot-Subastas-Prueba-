require('dotenv').config();
const { Client, GatewayIntentBits, Events, REST, Routes, PermissionFlagsBits } = require('discord.js');
const { parse } = require('csv-parse/sync');

const utils = require('./utils');
const logic = require('./logic');
const { commandsData } = require('./commands');
const { setupPanel } = require('./panel');

// ====== PENDIENTES (Confirmaciones) ======
const pendingActions = new Map();
function guardarPendiente(tipo, payload, userId) {
    const id = Math.random().toString(36).slice(2, 10);
    pendingActions.set(id, { tipo, payload, userId, expira: Date.now() + 5 * 60 * 1000 });
    for (const [k, v] of pendingActions.entries()) {
        if (v.expira < Date.now()) pendingActions.delete(k);
    }
    return id;
}

// ====== CLIENTE ======
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
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

// ====== HELPERS DE CONFIRMACIÓN ======
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

// ====== INTERACCIONES ======
client.on(Events.InteractionCreate, async (interaction) => {
    // 1. Autocompletado
    if (interaction.isAutocomplete()) {
        const db = utils.cargarDB();
        const miembros = utils.cargarMiembros();
        const focused = interaction.options.getFocused(true);
        const cmd = interaction.commandName;

        if (['panel', 'control'].includes(cmd)) return;

        if ((cmd === 'sub' || cmd === 'subf') && focused.name === 'objeto') {
            const objetos = logic.obtenerObjetosUnicos(db);
            const q = utils.normalizar(focused.value);
            return interaction.respond(objetos.filter(n => utils.normalizar(n).includes(q)).slice(0, 25).map(n => ({ name: n, value: n })));
        }

        if (cmd === 'objeto' && focused.name === 'nombre') {
            const objetos = logic.obtenerObjetosUnicos(db);
            const q = utils.normalizar(focused.value);
            return interaction.respond(objetos.filter(n => utils.normalizar(n).includes(q)).slice(0, 25).map(n => ({ name: n, value: n })));
        }

        if (['jugadores', 'ganadores', 'perdedores', 'quitar', 'poner'].includes(focused.name)) {
            const nombres = logic.obtenerNombresUnicos(db, miembros);
            return interaction.respond(logic.sugerirNombresMultiples(focused.value, nombres));
        }

        if (focused.name === 'jugador' || (cmd === 'miembro' && focused.name === 'nombre')) {
            const nombres = logic.obtenerNombresUnicos(db, miembros);
            if (cmd === 'editar' || cmd === 'miembro') return interaction.respond(logic.sugerirNombresMultiples(focused.value, nombres));
            const q = utils.normalizar(focused.value);
            return interaction.respond(nombres.filter(n => utils.normalizar(n).includes(q)).slice(0, 25).map(n => ({ name: n, value: n })));
        }
        return;
    }

    // 2. Botones (Paginación y Confirmaciones)
    if (interaction.isButton()) {
        const cid = interaction.customId;

        // Prioridad
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

        // Navegación de días
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
            const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`dia_first_${id}`).setLabel('⏮').setStyle(ButtonStyle.Secondary).setDisabled(nuevaFecha <= p.payload.minDate),
                new ButtonBuilder().setCustomId(`dia_prev_${id}`).setLabel('◀').setStyle(ButtonStyle.Primary).setDisabled(nuevaFecha <= p.payload.minDate),
                new ButtonBuilder().setCustomId(`dia_next_${id}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(nuevaFecha >= p.payload.maxDate),
                new ButtonBuilder().setCustomId(`dia_last_${id}`).setLabel('⏭').setStyle(ButtonStyle.Secondary).setDisabled(nuevaFecha >= p.payload.maxDate)
            );
            return interaction.update({ content: out, components: [row] });
        }

        // Paginación genérica
        const pagMatch = cid.match(/^(rank|obj|cat)_(first|prev|next|last)_(.+)$/);
        if (pagMatch) {
            const [_, prefijo, accion, id] = pagMatch;
            const p = pendingActions.get(id);
            const tipoEsperado = prefijo === 'rank' ? 'ranking' : (prefijo === 'obj' ? 'objeto-page' : 'categoria-page');
            if (!p || p.tipo !== tipoEsperado || p.userId !== interaction.user.id) return interaction.reply({ content: '❌ Sesión expirada.', ephemeral: true });

            const payload = p.payload;
            let porPagina = prefijo === 'rank' ? (payload.categoria === 'Todas' ? 10 : 15) : (prefijo === 'obj' ? (payload.formato === 'Clasificación' ? 15 : 10) : 10);
            const totalItems = payload.items ? payload.items.length : payload.jugadores.length;
            const totalPaginas = Math.max(1, Math.ceil(totalItems / porPagina));

            if (accion === 'first') payload.pagina = 1;
            else if (accion === 'prev') payload.pagina = Math.max(1, payload.pagina - 1);
            else if (accion === 'next') payload.pagina = Math.min(totalPaginas, payload.pagina + 1);
            else if (accion === 'last') payload.pagina = totalPaginas;
            p.expira = Date.now() + 5 * 60 * 1000;

            const miembros = utils.cargarMiembros();
            let render;
            if (tipoEsperado === 'ranking') render = logic.renderRankingPagina(payload);
            else if (tipoEsperado === 'objeto-page') render = logic.renderObjetoPagina(payload, miembros);
            else render = logic.renderCategoriaPagina(payload, miembros);

            const row = logic.construirBotonesPaginacion(prefijo, id, render.paginaActual, render.totalPaginas);
            return interaction.update({ content: render.content, components: [row] });
        }

        // Confirmaciones pendientes
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

            if (p.tipo === 'sub' || p.tipo === 'subf') {
                const e = { id: db.nextId++, ...p.payload };
                db.compras.push(e);
                utils.guardarDB(db);
                resultado = `✅ #${e.id} · 📅 ${utils.formatearFecha(e.fecha)} · ${utils.nombreBonitoEvento(e.evento)}\n📦 ${e.cantidad}x ${e.objeto} (${e.categoria})\n🏆 ${e.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}${e.perdedores.length ? `\n💔 ${e.perdedores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ')}` : ''}`;
                requiereSync = true;
            }
            else if (p.tipo === 'borrar') {
                const idx = db.compras.findIndex(c => c.id === p.payload.id);
                if (idx === -1) resultado = '❌ La entrada ya no existe.';
                else {
                    const el = db.compras.splice(idx, 1)[0];
                    utils.guardarDB(db);
                    resultado = `🗑️ Borrada #${el.id}: ${el.cantidad}x ${el.objeto}`;
                    requiereSync = true;
                }
            }
            else if (p.tipo === 'editar') {
                const idx = db.compras.findIndex(c => c.id === p.payload.id);
                if (idx === -1) resultado = '❌ La entrada ya no existe.';
                else {
                    const e = db.compras[idx];
                    const { sub, valor } = p.payload;
                    if (sub === 'agregar-ganador') for (const j of valor) e.ganadores.push(j);
                    else if (sub === 'quitar-ganador') for (const j of valor) { const pos = utils.buscarJugadorEnLista(e.ganadores, j, miembros); if (pos !== -1) e.ganadores.splice(pos, 1); }
                    else if (sub === 'cambiar-ganador') { const pos = utils.buscarJugadorEnLista(e.ganadores, valor.quitar, miembros); if (pos !== -1) e.ganadores.splice(pos, 1, valor.poner); }
                    else if (sub === 'agregar-perdedor') for (const j of valor) e.perdedores.push(j);
                    else if (sub === 'quitar-perdedor') for (const j of valor) { const pos = utils.buscarJugadorEnLista(e.perdedores, j, miembros); if (pos !== -1) e.perdedores.splice(pos, 1); }
                    else if (sub === 'set-nota') e.notas = valor;
                    else if (sub === 'borrar-nota') e.notas = '';
                    else if (sub === 'set-evento') e.evento = valor;
                    else if (sub === 'set-categoria') e.categoria = valor;
                    else if (sub === 'set-cantidad') e.cantidad = valor;

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
                }
                utils.guardarDB(db);
                resultado = `✅ **${agregadas}** entradas registradas.`;
                if (duplicados > 0) resultado += `\n⚠️ ${duplicados} duplicadas ignoradas.`;
                resultado += `\nTotal en la base: **${db.compras.length}**.`;
                requiereSync = true;
            }

            pendingActions.delete(id);
            if (requiereSync) {
                const syncRes = await logic.sincronizarConGitHub(false);
                resultado += textoEstadoSync(syncRes);
            }

            try {
                await interaction.editReply({ content: '✅ Acción completada.', components: [] });
                await interaction.followUp({ content: resultado, ephemeral: false }); // Punto 6: Público
            } catch (e) { console.error(e); }
            return;
        }

        return;
    }

    // 3. Comandos Slash
    if (!interaction.isChatInputCommand()) return;
    
    // Permisos (Punto 12)
    const comandosLider = ['miembro', 'backup', 'sync'];
    const comandosHelper = ['borrar', 'editar', 'registro-rapido', 'sub', 'subf'];
    
    if (comandosLider.includes(interaction.commandName) || comandosHelper.includes(interaction.commandName)) {
        const esDueño = interaction.guild && interaction.guild.ownerId === interaction.user.id;
        const tieneLider = interaction.member && interaction.member.roles.cache.has(utils.ROL_LIDER);
        const tieneHelper = interaction.member && interaction.member.roles.cache.has(utils.ROL_HELPER);
        const esAdmin = interaction.member && interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        
        const puedeLider = esDueño || tieneLider || esAdmin;
        const puedeHelper = puedeLider || tieneHelper;

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
        // ---------- /sync ----------
        if (interaction.commandName === 'sync') {
            await interaction.deferReply({ ephemeral: true });
            const res = await logic.sincronizarConGitHub(true);
            let msg = res.ok ? `✅ Sync OK\n📤 CSV actualizado con ${res.total} entradas.` : `❌ Sync falló: ${res.motivo}`;
            if (res.ok && res.agregadas > 0) msg += `\n📥 ${res.agregadas} nuevas absorvidas.`;
            return interaction.editReply({ content: msg });
        }

        // ---------- /registro-rapido ----------
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
                preview += `**${i+1}.** ${utils.formatearFecha(v.fecha)} · ${utils.nombreBonitoEvento(v.evento)} · ${v.cantidad}x ${v.objeto} (${v.categoria})\n   🏆 ${v.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}\n`;
            });
            if (validas.length > 5) preview += `... y ${validas.length - 5} más.\n`;
            if (errores.length > 0) preview += `\n⚠️ **${errores.length} errores:**\n${errores.slice(0, 5).join('\n')}`;

            return mostrarPreview(interaction, 'Confirmar registro rápido', preview, 'registro-rapido', { entradas: validas });
        }

        // ---------- /backup ----------
        if (interaction.commandName === 'backup') {
            const fs = require('fs');
            const { AttachmentBuilder } = require('discord.js');
            const contenido = logic.generarCSV(db);
            fs.writeFileSync(utils.BACKUP_FILE, contenido);
            const adjunto = new AttachmentBuilder(Buffer.from(contenido, 'utf8'), { name: 'backup.csv' });
            return interaction.reply({ content: `✅ Respaldo guardado. Total: **${db.compras.length}**.`, files: [adjunto] });
        }

        // ---------- /objeto ----------
        if (interaction.commandName === 'objeto') {
            const nombreBuscado = interaction.options.getString('nombre').trim();
            const periodo = interaction.options.getString('periodo') || 'Total';
            const formato = interaction.options.getString('formato') || 'Clasificación';
            const visibilidad = interaction.options.getString('visibilidad') || 'Privado';
            const ephemeral = visibilidad === 'Privado';

            const keyBuscado = utils.normalizar(nombreBuscado);
            const comprasFiltradas = utils.filtrarPorPeriodo(db.compras, periodo);
            const apariciones = comprasFiltradas.filter(c => c.objeto && utils.normalizar(c.objeto) === keyBuscado && c.ganadores.length > 0).sort((a, b) => b.fecha.localeCompare(a.fecha));

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

        // ---------- /categoria ----------
        if (interaction.commandName === 'categoria') {
            const categoria = interaction.options.getString('categoria');
            const jugadorFiltro = (interaction.options.getString('jugador') || '').trim();
            const periodo = interaction.options.getString('periodo') || 'Total';
            const visibilidad = interaction.options.getString('visibilidad') || 'Privado';
            const ephemeral = visibilidad === 'Privado';

            const comprasFiltradas = utils.filtrarPorPeriodo(db.compras, periodo);
            let apariciones = comprasFiltradas.filter(c => c.categoria === categoria);
            if (jugadorFiltro) apariciones = apariciones.filter(c => utils.contarGanador(c.ganadores, jugadorFiltro, miembros) > 0);
            apariciones = apariciones.sort((a, b) => b.fecha.localeCompare(a.fecha));

            if (apariciones.length === 0) return interaction.reply({ content: `❌ No hay apariciones de **${categoria}**.`, ephemeral });

            const payload = { categoria, jugadorFiltro, periodo, items: apariciones, pagina: 1 };
            const id = guardarPendiente('categoria-page', payload, interaction.user.id);
            const render = logic.renderCategoriaPagina(payload, miembros);
            const row = logic.construirBotonesPaginacion('cat', id, render.paginaActual, render.totalPaginas);
            return interaction.reply({ content: render.content, components: [row], ephemeral });
        }

        // ---------- /alertas ----------
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

        // ---------- /miembro ----------
        if (interaction.commandName === 'miembro') {
            const sub = interaction.options.getSubcommand();
            if (sub === 'canonicos') {
                const can = Object.entries(miembros.canonicos || {}).map(([k, v]) => `\`${k}\` → **${v}**`).join('\n') || '(ninguno)';
                return interaction.reply({ content: `**Canónicos registrados:**\n${can}`, ephemeral: true });
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
                let msg = `✅ **Reincluidos:** ${quit.join(', ')}`;
                if (no.length > 0) msg += `\nℹ️ No estaban: ${no.join(', ')}`;
                return interaction.reply({ content: msg });
            }
            if (sub === 'canonico') {
                const como = interaction.options.getString('como');
                for (const n of nombres) miembros.canonicos[utils.normalizarNombre(n)] = como;
                utils.guardarMiembros(miembros);
                return interaction.reply({ content: `✅ ${nombres.join(', ')} se mostrarán como **${como}**.` });
            }
            if (sub === 'quitar-canonico') {
                const key = utils.normalizarNombre(nombres[0]);
                if (!miembros.canonicos[key]) return interaction.reply({ content: `ℹ️ No hay canónico para **${nombres[0]}**.`, ephemeral: true });
                const prev = miembros.canonicos[key];
                delete miembros.canonicos[key];
                utils.guardarMiembros(miembros);
                return interaction.reply({ content: `✅ Canónico eliminado para **${prev}**.` });
            }
        }

        // ---------- /editar ----------
        if (interaction.commandName === 'editar') {
            const sub = interaction.options.getSubcommand();
            const id = interaction.options.getInteger('id');
            const idx = db.compras.findIndex(c => c.id === id);
            if (idx === -1) return interaction.reply({ content: `❌ No existe entrada #${id}.`, ephemeral: true });
            const e = db.compras[idx];
            let cuerpo = '', payload = null;

            if (sub === 'agregar-ganador') {
                const str = interaction.options.getString('jugador');
                const ag = [], sa = [], vistos = new Set();
                for (const j of str.split(',').map(s => s.trim()).filter(Boolean)) {
                    if (vistos.has(j.toLowerCase())) { sa.push(j); continue; } vistos.add(j.toLowerCase());
                    if (utils.buscarJugadorEnLista(e.ganadores, j, miembros) !== -1) sa.push(j); else ag.push(j);
                }
                if (ag.length === 0) return interaction.reply({ content: `ℹ️ Ninguno se agregó (ya estaban): ${sa.join(', ')}`, ephemeral: true });
                cuerpo = `Agregar **${ag.join(', ')}** a ganadores de #${id}.\n\n#${e.id} · ${e.cantidad}x ${e.objeto} (${e.categoria})`;
                payload = { id, sub, valor: ag };
            } else if (sub === 'quitar-ganador') {
                const str = interaction.options.getString('jugador');
                const qu = [], sa = [], vistos = new Set();
                for (const j of str.split(',').map(s => s.trim()).filter(Boolean)) {
                    if (vistos.has(j.toLowerCase())) { sa.push(j); continue; } vistos.add(j.toLowerCase());
                    if (utils.buscarJugadorEnLista(e.ganadores, j, miembros) === -1) sa.push(j); else qu.push(j);
                }
                if (qu.length === 0) return interaction.reply({ content: `ℹ️ Ninguno se quitó (no estaban): ${sa.join(', ')}`, ephemeral: true });
                cuerpo = `Quitar **${qu.join(', ')}** de ganadores de #${id}.\n\n#${e.id} · ${e.cantidad}x ${e.objeto} (${e.categoria})`;
                payload = { id, sub, valor: qu };
            } else if (sub === 'cambiar-ganador') {
                const q = interaction.options.getString('quitar').trim();
                const p = interaction.options.getString('poner').trim();
                if (utils.buscarJugadorEnLista(e.ganadores, q, miembros) === -1) return interaction.reply({ content: `❌ **${q}** no está en ganadores.`, ephemeral: true });
                if (utils.buscarJugadorEnLista(e.ganadores, p, miembros) !== -1) return interaction.reply({ content: `❌ **${p}** ya está en ganadores.`, ephemeral: true });
                cuerpo = `Cambiar **${utils.aplicarCanonico(q, miembros)}** por **${utils.aplicarCanonico(p, miembros)}** en ganadores de #${id}.`;
                payload = { id, sub, valor: { quitar: q, poner: p } };
            } else if (sub === 'agregar-perdedor') {
                const str = interaction.options.getString('jugador');
                const ag = [], sa = [], vistos = new Set();
                for (const j of str.split(',').map(s => s.trim()).filter(Boolean)) {
                    if (vistos.has(j.toLowerCase())) { sa.push(j); continue; } vistos.add(j.toLowerCase());
                    if (utils.buscarJugadorEnLista(e.perdedores, j, miembros) !== -1) sa.push(j); else ag.push(j);
                }
                if (ag.length === 0) return interaction.reply({ content: `ℹ️ Ninguno se agregó (ya estaban): ${sa.join(', ')}`, ephemeral: true });
                cuerpo = `Agregar **${ag.join(', ')}** a perdedores de #${id}.\n\n#${e.id} · ${e.cantidad}x ${e.objeto} (${e.categoria})`;
                payload = { id, sub, valor: ag };
            } else if (sub === 'quitar-perdedor') {
                const str = interaction.options.getString('jugador');
                const qu = [], sa = [], vistos = new Set();
                for (const j of str.split(',').map(s => s.trim()).filter(Boolean)) {
                    if (vistos.has(j.toLowerCase())) { sa.push(j); continue; } vistos.add(j.toLowerCase());
                    if (utils.buscarJugadorEnLista(e.perdedores, j, miembros) === -1) sa.push(j); else qu.push(j);
                }
                if (qu.length === 0) return interaction.reply({ content: `ℹ️ Ninguno se quitó (no estaban): ${sa.join(', ')}`, ephemeral: true });
                cuerpo = `Quitar **${qu.join(', ')}** de perdedores de #${id}.\n\n#${e.id} · ${e.cantidad}x ${e.objeto} (${e.categoria})`;
                payload = { id, sub, valor: qu };
            } else if (sub === 'set-nota') {
                cuerpo = `Cambiar nota de #${id} a:\n📝 ${interaction.options.getString('nota')}`;
                payload = { id, sub, valor: interaction.options.getString('nota') };
            } else if (sub === 'borrar-nota') {
                if (!e.notas) return interaction.reply({ content: `ℹ️ La entrada #${id} no tiene nota.`, ephemeral: true });
                cuerpo = `Borrar nota de #${id}.\nActual: 📝 ${e.notas}`;
                payload = { id, sub };
            } else if (sub === 'set-evento') {
                const ev = interaction.options.getString('evento');
                cuerpo = `Cambiar evento de #${id} a **${ev}**.\nActual: ${utils.nombreBonitoEvento(e.evento)}`;
                payload = { id, sub, valor: ev };
            } else if (sub === 'set-categoria') {
                const cat = interaction.options.getString('categoria');
                cuerpo = `Cambiar categoría de #${id} a **${cat}**.\nActual: ${e.categoria}`;
                payload = { id, sub, valor: cat };
            } else if (sub === 'set-cantidad') {
                const cant = interaction.options.getInteger('cantidad');
                if (cant < 0) return interaction.reply({ content: '❌ Cantidad inválida.', ephemeral: true });
                cuerpo = `Cambiar cantidad de #${id} a **${cant}**.\nActual: ${e.cantidad}`;
                payload = { id, sub, valor: cant };
            }
            return mostrarPreview(interaction, 'Confirmar edición', cuerpo, 'editar', payload);
        }

        // ---------- /sub y /subf ----------
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
            let cuerpo = `📅 ${utils.formatearFecha(fecha)} · ${utils.nombreBonitoEvento(evento)}\n📦 ${cantidad}x ${objeto} (${categoria})\n🏆 ${entrada.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}`;
            if (entrada.perdedores.length > 0) cuerpo += `\n💔 ${entrada.perdedores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ')}`;
            return mostrarPreview(interaction, 'Confirmar registro', cuerpo, interaction.commandName, entrada);
        }

        // ---------- /dia ----------
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
            return interaction.reply({ content: out, components: [row], ephemeral });
        }

        // ---------- /historial y /historial2 ----------
        if (interaction.commandName === 'historial' || interaction.commandName === 'historial2') {
            const ephemeral = interaction.commandName === 'historial';
            const jugadores = interaction.options.getString('jugadores').split(',').map(s => s.trim()).filter(Boolean);
            const categoria = interaction.options.getString('categoria') || 'Todas';
            const formato = interaction.options.getString('formato') || 'Recientes';

            if (formato === 'Detallado' && categoria !== 'Todas') return interaction.reply({ content: '❌ Detallado solo con Categoría = Todas.', ephemeral });

            let out = '';
            if (formato === 'Recientes') {
                const bloques = [];
                for (const j of jugadores) {
                    let comprasJ = db.compras.filter(c => utils.contarGanador(c.ganadores, j, miembros) > 0);
                    if (categoria !== 'Todas') comprasJ = comprasJ.filter(c => c.categoria === categoria);
                    comprasJ.sort((a, b) => b.fecha.localeCompare(a.fecha));
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
                    let comprasJ = db.compras.filter(c => utils.contarGanador(c.ganadores, j, miembros) > 0).sort((a, b) => b.fecha.localeCompare(a.fecha));
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

        // ---------- /total ----------
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

        // ---------- /ranking ----------
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

        // ---------- /prioridad (Punto 7) ----------
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

        // ---------- /borrar ----------
        if (interaction.commandName === 'borrar') {
            const id = interaction.options.getInteger('id');
            const idx = db.compras.findIndex(c => c.id === id);
            if (idx === -1) return interaction.reply({ content: `❌ No existe entrada #${id}.`, ephemeral: true });
            const e = db.compras[idx];
            let cuerpo = `#${e.id} · ${utils.formatearFecha(e.fecha)} ${utils.etiquetaDias(e.fecha)} · ${utils.nombreBonitoEvento(e.evento)}\n📦 ${e.cantidad}x ${e.objeto} (${e.categoria})\n🏆 ${e.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}`;
            if (e.perdedores.length > 0) cuerpo += `\n💔 ${e.perdedores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ')}`;
            if (e.notas) cuerpo += `\n📝 ${e.notas}`;
            return mostrarPreview(interaction, '⚠️ Confirmar BORRADO', cuerpo, 'borrar', { id });
        }

        // ---------- /ayuda ----------
        if (interaction.commandName === 'ayuda') {
            return interaction.reply({
                content: `**Comandos:**\n\`/sub\` · registrar compra\n\`/subf\` · registrar con fecha\n\`/registro-rapido\` · registrar varias entradas\n\`/historial\` · historial privado\n\`/historial2\` · historial público\n\`/dia\` · compras de un día\n\`/total\` · totales por categoría\n\`/ranking\` · tabla general\n\`/prioridad\` · calcular prioridad\n\`/alertas\` · alertas de acaparamiento\n\`/objeto\` · apariciones de un objeto\n\`/categoria\` · apariciones de una categoría\n\`/backup\` · exportar CSV\n\`/sync\` · sincronizar con GitHub\n\`/miembro\` · gestionar nombres y exclusiones\n\`/editar\` · editar entrada\n\`/borrar\` · borrar por ID\n\`/ayuda\` · este mensaje\n\n**Paneles:**\n\`/panel crear\` · crear panel\n\`/panel ver\` · mostrar panel\n\`/panel objeto\` · cambiar objeto\n\`/panel interesado\` · añadir/quitar interesados\n\`/panel cancelar\` · cancelar subasta\n\`/panel indice\` · crear/actualizar índice\n\`/panel refresh\` · forzar actualización\n\n**Control:**\n\`/control agregar\` · añadir thread fijo\n\`/control quitar\` · quitar thread fijo\n\`/control panel\` · crear/actualizar Panel de Control`,
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

// ====== SETUP PANEL ======
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
    ROL_LIDER: utils.ROL_LIDER,
    ROL_HELPER: utils.ROL_HELPER
});

client.login(process.env.DISCORD_TOKEN);
