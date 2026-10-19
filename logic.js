const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');

const utils = require('./utils');

// ====== CSV Y GITHUB ======
function huella(c) {
    return [c.fecha || '', c.evento || '', c.categoria || '', c.objeto || '', c.cantidad || 0, (c.ganadores || []).join(','), (c.perdedores || []).join(',')].join('|');
}

function generarCSV(db) {
    const comprasOrdenadas = [...db.compras].sort((a, b) => {
        if (!a.fecha) return 1;
        if (!b.fecha) return -1;
        return a.fecha.localeCompare(b.fecha);
    });
    const lineas = ['fecha,evento,categoria,objeto,cantidad,ganadores,perdedores,notas'];
    for (const c of comprasOrdenadas) {
        const esc = (s) => `"${(s || '').replace(/"/g, '""')}"`;
        lineas.push([
            utils.formatearFecha(c.fecha),
            c.evento || '',
            c.categoria || '',
            esc(c.objeto || ''),
            c.cantidad || 1,
            esc((c.ganadores || []).join(',')),
            esc((c.perdedores || []).join(',')),
            esc(c.notas || '')
        ].join(','));
    }
    return lineas.join('\n') + '\n';
}

function mergeCSVEnDB(contenidoCSV, db) {
    if (!contenidoCSV || !contenidoCSV.trim()) return { agregadas: 0 };
    const existentes = new Set(db.compras.map(huella));
    let agregadas = 0;
    try {
        const filas = parse(contenidoCSV, { columns: true, skip_empty_lines: true, trim: true });
        for (const fila of filas) {
            const fechaConv = utils.convertirFecha(fila.fecha);
            if (!fechaConv) continue;
            const ganadores = fila.ganadores ? fila.ganadores.split(',').map(s => s.trim()).filter(Boolean) : [];
            const perdedores = fila.perdedores ? fila.perdedores.split(',').map(s => s.trim()).filter(Boolean) : [];
            const nueva = {
                id: db.nextId, fecha: fechaConv, evento: fila.evento || '', categoria: fila.categoria || '',
                objeto: fila.objeto || '', cantidad: parseInt(fila.cantidad) || 1, ganadores, perdedores, notas: fila.notas || ''
            };
            const fp = huella(nueva);
            if (!existentes.has(fp)) {
                db.compras.push(nueva);
                existentes.add(fp);
                db.nextId++;
                agregadas++;
            }
        }
    } catch (e) { console.error('Error parseando CSV:', e.message); }
    return { agregadas };
}

async function sincronizarConGitHub(conMerge = true) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const filePath = process.env.GITHUB_CSV_PATH || 'historial.csv';

    if (!token || !repo) return { ok: false, motivo: 'GitHub no configurado.' };
    if (typeof fetch !== 'function') return { ok: false, motivo: 'Node.js no soporta fetch.' };

    try {
        const urlGet = `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`;
        const rGet = await fetch(urlGet, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'bot-subastas' } });

        let sha = null;
        let csvRemoto = '';
        if (rGet.ok) {
            const data = await rGet.json();
            sha = data.sha;
            csvRemoto = Buffer.from(data.content, 'base64').toString('utf8');
        } else if (rGet.status !== 404) {
            const txt = await rGet.text();
            return { ok: false, motivo: `GET ${rGet.status}: ${txt.slice(0, 150)}` };
        }

        const db = utils.cargarDB();
        let agregadas = 0;
        if (conMerge) {
            const resMerge = mergeCSVEnDB(csvRemoto, db);
            agregadas = resMerge.agregadas;
            if (agregadas > 0) utils.guardarDB(db);
        }

        const contenido = generarCSV(db);
        const contenidoB64 = Buffer.from(contenido, 'utf8').toString('base64');

        try { fs.writeFileSync(utils.CSV_FILE, contenido); } catch (e) { console.error(e.message); }

        const urlPut = `https://api.github.com/repos/${repo}/contents/${filePath}`;
        const body = { message: `Sync historial.csv desde bot (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`, content: contenidoB64, branch };
        if (sha) body.sha = sha;

        const rPut = await fetch(urlPut, { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'bot-subastas' }, body: JSON.stringify(body) });
        if (!rPut.ok) {
            const txt = await rPut.text();
            return { ok: false, motivo: `PUT ${rPut.status}: ${txt.slice(0, 150)}` };
        }
        return { ok: true, agregadas, total: db.compras.length };
    } catch (err) { return { ok: false, motivo: err.message }; }
}

function leerCSVInicial() {
    if (!fs.existsSync(utils.CSV_FILE)) return;
    if (fs.existsSync(utils.DB_FILE)) {
        const dbActual = JSON.parse(fs.readFileSync(utils.DB_FILE, 'utf8'));
        if (dbActual.compras && dbActual.compras.length > 0) return;
    }
    console.log('Cargando CSV inicial...');
    const contenido = fs.readFileSync(utils.CSV_FILE, 'utf8');
    const filas = parse(contenido, { columns: true, skip_empty_lines: true, trim: true });
    const db = { compras: [], nextId: 1 };
    for (const fila of filas) {
        const ganadores = fila.ganadores ? fila.ganadores.split(',').map(s => s.trim()).filter(Boolean) : [];
        const perdedores = fila.perdedores ? fila.perdedores.split(',').map(s => s.trim()).filter(Boolean) : [];
        db.compras.push({
            id: db.nextId++, fecha: utils.convertirFecha(fila.fecha), evento: fila.evento || '', categoria: fila.categoria || '',
            objeto: fila.objeto || '', cantidad: parseInt(fila.cantidad) || 1, ganadores, perdedores, notas: fila.notas || ''
        });
    }
    utils.guardarDB(db);
    console.log(`Cargadas ${db.compras.length} entradas del CSV.`);
}

// ====== PRIORIDAD Y RANKING ======
function calcularPrioridad(jugador, categoria, compras, miembros) {
    const pesosCategoria = utils.PESOS[categoria] || {};
    let impacto = 0, unidades7d = 0, historico = 0;
    const desglose = {};

    for (const c of compras) {
        const n = utils.contarGanador(c.ganadores, jugador, miembros);
        if (n === 0) continue;
        const peso = pesosCategoria[c.categoria];
        if (peso === undefined) continue;
        const dias = utils.diasDesde(c.fecha);
        if (c.categoria === 'Emblemas Únicos' && (categoria === 'Equipo' || categoria === 'Accesorios') && dias > 2) continue;
        
        impacto += n * peso * utils.getFactorTemporal(dias);
        if (dias <= 6) {
            unidades7d += n;
            desglose[c.categoria] = (desglose[c.categoria] || 0) + n;
        }
    }
    for (const c of compras) {
        if (c.categoria !== categoria) continue;
        historico += utils.contarGanador(c.ganadores, jugador, miembros);
    }
    const historicoTotal = {};
    for (const cat of utils.CATEGORIAS) historicoTotal[cat] = 0;
    for (const c of compras) {
        const n = utils.contarGanador(c.ganadores, jugador, miembros);
        if (n > 0 && historicoTotal[c.categoria] !== undefined) historicoTotal[c.categoria] += n;
    }
    return { impacto, unidades7d, historico, desglose, historicoTotal };
}

function compararPrioridad(a, b) {
    if (Math.abs(a.impacto - b.impacto) > 0.001) return a.impacto - b.impacto;
    if (a.unidades7d !== b.unidades7d) return a.unidades7d - b.unidades7d;
    if (a.historico !== b.historico) return a.historico - b.historico;
    return 0;
}

function construirRanking(comprasFiltradas, categoriaFiltro, miembros) {
    const ranking = {};
    for (const c of comprasFiltradas) {
        for (const g of c.ganadores) {
            const { nombre, cantidad } = utils.parsearGanador(g);
            if (utils.esExcluido(nombre, miembros)) continue;
            const key = utils.claveJugador(nombre, miembros);
            if (!ranking[key]) {
                ranking[key] = { nombre: utils.aplicarCanonico(nombre, miembros), total: 0 };
                for (const cat of utils.CATEGORIAS) ranking[key][cat] = 0;
            }
            if (ranking[key][c.categoria] !== undefined) {
                ranking[key][c.categoria] += cantidad;
                ranking[key].total += cantidad;
            }
        }
    }
    if (categoriaFiltro === 'Todas') return Object.values(ranking).sort((a, b) => b.total - a.total);
    return Object.values(ranking).filter(d => (d[categoriaFiltro] || 0) > 0).sort((a, b) => b[categoriaFiltro] - a[categoriaFiltro]);
}

function obtenerCategoriasAfectantes(categoria) {
    const orden = {
        'Emblemas Únicos': ['Emblemas Únicos', 'Cajas 20k', 'Emblemas Generales'],
        'Cajas 20k': ['Cajas 20k', 'Emblemas Únicos', 'Emblemas Generales'],
        'Emblemas Generales': ['Emblemas Generales', 'Emblemas Únicos', 'Cajas 20k'],
        'Equipo': ['Equipo', 'Accesorios', 'Emblemas Únicos'],
        'Accesorios': ['Accesorios', 'Equipo', 'Emblemas Únicos']
    };
    return orden[categoria] || [categoria];
}

function calcularPerdedores7d(jugadores, categoria, db, miembros) {
    const cats = obtenerCategoriasAfectantes(categoria);
    const res = {};
    cats.forEach(c => res[c] = {});
    const jks = jugadores.map(j => ({ nombre: j, key: utils.claveJugador(j, miembros) }));
    const recientes = utils.filtrarPorPeriodo(db.compras, '7d');
    for (const c of recientes) {
        if (!cats.includes(c.categoria)) continue;
        for (const p of c.perdedores) {
            const pk = utils.claveJugador(p, miembros);
            const match = jks.find(j => j.key === pk);
            if (match) res[c.categoria][match.nombre] = (res[c.categoria][match.nombre] || 0) + 1;
        }
    }
    return res;
}

// ====== RENDERIZADO ======
function construirBotonesPaginacion(prefijo, id, paginaActual, totalPaginas) {
    const alInicio = paginaActual <= 1;
    const alFinal = paginaActual >= totalPaginas;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${prefijo}_first_${id}`).setLabel('⏮').setStyle(ButtonStyle.Secondary).setDisabled(alInicio),
        new ButtonBuilder().setCustomId(`${prefijo}_prev_${id}`).setLabel('◀').setStyle(ButtonStyle.Primary).setDisabled(alInicio),
        new ButtonBuilder().setCustomId(`${prefijo}_next_${id}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(alFinal),
        new ButtonBuilder().setCustomId(`${prefijo}_last_${id}`).setLabel('⏭').setStyle(ButtonStyle.Secondary).setDisabled(alFinal)
    );
}

function renderPrioridad(payload, miembros) {
    const { categoria, resultados } = payload;
    let out = `🏆 **Prioridad — ${categoria}**\n\n`;
    resultados.forEach((r, i) => {
        let desgloseStr = '';
        if (r.unidades7d > 0) {
            const partes = Object.entries(r.desglose).filter(([_, n]) => n > 0).map(([cat, n]) => `${utils.ABREVIATURAS[cat] || cat}: ${n}`);
            if (partes.length > 0) desgloseStr = ` (${partes.join(', ')})`;
        }
        const histPartes = Object.entries(r.historicoTotal).filter(([_, n]) => n > 0).map(([cat, n]) => `${utils.ABREVIATURAS[cat] || cat}: ${n}`);
        const sumaHist = Object.values(r.historicoTotal).reduce((a, b) => a + b, 0);
        const histTotalStr = histPartes.length > 0 ? `Total histórico (${sumaHist}): ${histPartes.join(', ')}` : 'Total histórico: —';
        out += `**${i + 1}. ${utils.aplicarCanonico(r.jugador, miembros)}**\n`;
        out += `   Impacto reciente: ${r.impacto.toFixed(2)}\n`;
        out += `   Unidades 7d: ${r.unidades7d}${desgloseStr}\n`;
        out += `   Total en categoría: ${r.historico}\n`;
        out += `   ${histTotalStr}\n`;
    });
    out += `\n**Recomendación:** ${utils.aplicarCanonico(resultados[0].jugador, miembros)}`;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`prio_perdedores_${payload.id}`).setLabel('💔 Ver perdedores 7d').setStyle(ButtonStyle.Danger)
    );
    return { content: out, components: [row] };
}

function renderPerdedores(payload, db, miembros) {
    const { categoria, jugadores, id } = payload;
    const catsAfectantes = obtenerCategoriasAfectantes(categoria);
    const conteos = calcularPerdedores7d(jugadores, categoria, db, miembros);
    let out = `💔 **Perdedores — ${categoria} (últimos 7d)**\n\n`;
    catsAfectantes.forEach((cat, idx) => {
        out += idx === 0 ? `**${cat}** (categoría pedida)\n` : `\n**${cat}**\n`;
        const mapa = conteos[cat] || {};
        const arr = Object.entries(mapa).filter(([_, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        if (arr.length === 0) out += `Sin registros.\n`;
        else arr.forEach(([jug, count]) => { out += `- ${utils.aplicarCanonico(jug, miembros)}: ${count} ${count === 1 ? 'vez' : 'veces'}\n`; });
    });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`prio_volver_${id}`).setLabel('🔙 Volver a prioridad').setStyle(ButtonStyle.Primary)
    );
    return { content: out, components: [row] };
}

function renderRankingPagina(payload) {
    const { jugadores, periodo, categoria, pagina } = payload;
    const porPagina = categoria === 'Todas' ? 10 : 15;
    const totalPaginas = Math.max(1, Math.ceil(jugadores.length / porPagina));
    const paginaActual = Math.min(Math.max(1, pagina), totalPaginas);
    const inicio = (paginaActual - 1) * porPagina;
    const slice = jugadores.slice(inicio, inicio + porPagina);
    const titulo = categoria === 'Todas' ? `🏆 **Ranking general** (${periodo})` : `🏆 **Ranking — ${categoria}** (${periodo})`;
    let out = `${titulo}\n_Página ${paginaActual}/${totalPaginas} · ${jugadores.length} jugador${jugadores.length === 1 ? '' : 'es'}_\n\n`;
    if (slice.length === 0) out += `No hay jugadores para mostrar.`;
    else {
        slice.forEach((d, i) => {
            const num = inicio + i + 1;
            if (categoria === 'Todas') out += `${num}. **${d.nombre}** · ${d.total} | 20k: ${d['Cajas 20k']} | Ún: ${d['Emblemas Únicos']} | Gen: ${d['Emblemas Generales']} | Eq: ${d['Equipo']} | Acc: ${d['Accesorios']}\n`;
            else out += `${num}. **${d.nombre}** · ${d[categoria]}\n`;
        });
    }
    return { content: out.trimEnd(), totalPaginas, paginaActual };
}

function renderObjetoPagina(payload, miembros) {
    const { nombreDisplay, periodo, formato, items, pagina } = payload;
    const porPagina = formato === 'Clasificación' ? 15 : 10;
    const totalPaginas = Math.max(1, Math.ceil(items.length / porPagina));
    const paginaActual = Math.min(Math.max(1, pagina), totalPaginas);
    const inicio = (paginaActual - 1) * porPagina;
    const slice = items.slice(inicio, inicio + porPagina);
    let out = `📦 **${nombreDisplay}** — ${formato} (${periodo})\n_Página ${paginaActual}/${totalPaginas} · ${items.length} ${formato === 'Clasificación' ? 'jugador' : 'aparición'}${items.length === 1 ? '' : 'es'}_\n\n`;
    if (slice.length === 0) out += 'Sin resultados.';
    else if (formato === 'Clasificación') {
        slice.forEach((d, i) => { out += `${inicio + i + 1}. **${d.nombre}** · ${d.total}\n`; });
    } else {
        for (const c of slice) {
            out += `#${c.id} · ${utils.formatearFecha(c.fecha)} ${utils.etiquetaDias(c.fecha)} · ${utils.nombreBonitoEvento(c.evento)} · ${c.cantidad}x (${c.categoria})\n   🏆 ${c.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}\n`;
            if (c.perdedores && c.perdedores.length > 0) out += `   💔 ${c.perdedores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ')}\n`;
            out += `\n`;
        }
    }
    return { content: out.trimEnd(), totalPaginas, paginaActual };
}

function renderCategoriaPagina(payload, miembros) {
    const { categoria, jugadorFiltro, periodo, items, pagina } = payload;
    const porPagina = 10;
    const totalPaginas = Math.max(1, Math.ceil(items.length / porPagina));
    const paginaActual = Math.min(Math.max(1, pagina), totalPaginas);
    const inicio = (paginaActual - 1) * porPagina;
    const slice = items.slice(inicio, inicio + porPagina);
    let titulo = `📂 **${categoria}**`;
    if (jugadorFiltro) titulo += ` — ${utils.aplicarCanonico(jugadorFiltro, miembros)}`;
    titulo += ` — Lista (${periodo})`;
    let out = `${titulo}\n_Página ${paginaActual}/${totalPaginas} · ${items.length} aparición${items.length === 1 ? '' : 'es'}_\n\n`;
    if (slice.length === 0) out += 'Sin resultados.';
    else {
        for (const c of slice) {
            out += `#${c.id} · ${utils.formatearFecha(c.fecha)} ${utils.etiquetaDias(c.fecha)} · ${utils.nombreBonitoEvento(c.evento)} · ${c.cantidad}x ${c.objeto}\n   🏆 ${c.ganadores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ') || 'nadie'}\n`;
            if (c.perdedores && c.perdedores.length > 0) out += `   💔 ${c.perdedores.map(g => utils.formatearNombreConCantidad(g, miembros)).join(', ')}\n`;
            out += `\n`;
        }
    }
    return { content: out.trimEnd(), totalPaginas, paginaActual };
}

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
    for (let i = 1; i < chunks.length; i++) await interaction.followUp({ content: chunks[i], ephemeral });
}

// ====== AUTOCOMPLETADO ======
function obtenerNombresUnicos(db, miembros) {
    const map = new Map();
    const agregar = (nombreConSufijo) => {
        if (!nombreConSufijo) return;
        const match = nombreConSufijo.match(/^(.+?)(?:\s+x(\d+))?$/);
        const nombre = match ? match[1].trim() : nombreConSufijo.trim();
        if (!nombre) return;
        const key = utils.claveJugador(nombre, miembros);
        if (!map.has(key)) map.set(key, utils.aplicarCanonico(nombre, miembros));
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
        if (!c.objeto || utils.OBJETOS_PROHIBIDOS.some(o => utils.normalizar(o) === utils.normalizar(c.objeto))) continue;
        const key = utils.normalizar(c.objeto);
        if (!map.has(key)) map.set(key, c.objeto);
    }
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
}
function sugerirNombresMultiples(valorActual, nombres) {
    const valor = valorActual || '';
    const partes = valor.split(',');
    const prefijo = partes.slice(0, -1).map(s => s.trim()).filter(Boolean);
    const ultima = (partes[partes.length - 1] || '').trim();
    const q = utils.normalizar(ultima);
    return nombres.filter(n => utils.normalizar(n).includes(q)).slice(0, 25).map(n => ({ name: n, value: [...prefijo, n].join(', ') }));
}

module.exports = {
    generarCSV, sincronizarConGitHub, leerCSVInicial,
    calcularPrioridad, compararPrioridad, construirRanking,
    obtenerCategoriasAfectantes, calcularPerdedores7d,
    construirBotonesPaginacion, renderPrioridad, renderPerdedores,
    renderRankingPagina, renderObjetoPagina, renderCategoriaPagina,
    responderLargo, obtenerNombresUnicos, obtenerObjetosUnicos, sugerirNombresMultiples,
    huella // <-- La función que faltaba
};
