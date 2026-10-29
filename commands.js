const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const utils = require('./utils');

const catChoices = utils.CATEGORIAS.map(cat => ({ name: cat, value: cat }));
const catChoicesTodo = [...catChoices, { name: 'Todas', value: 'Todas' }];
const visibilidadChoices = [{ name: 'Privado', value: 'Privado' }, { name: 'Visible', value: 'Visible' }];
const periodoChoices = [{ name: '7 días', value: '7d' }, { name: 'Total', value: 'Total' }];
const formatoObjetoChoices = [{ name: 'Clasificación', value: 'Clasificación' }, { name: 'Lista', value: 'Lista' }];
const formatoHistorialChoices = [{ name: 'Detallado', value: 'Detallado' }, { name: 'Resumido', value: 'Resumido' }];
const eventoChoices = [{ name: 'Invasión diurna', value: 'Invasión diurna' }, { name: 'Invasión nocturna', value: 'Invasión nocturna' }, { name: 'Banquete', value: 'Banquete' }];

const commandsData = [
    new SlashCommandBuilder().setName('sub').setDescription('Registrar compra de hoy')
        .addStringOption(o => o.setName('evento').setDescription('Evento al que pertenece').setRequired(true).addChoices(...eventoChoices))
        .addStringOption(o => o.setName('categoria').setDescription('Categoría').setRequired(true).addChoices(...catChoices))
        .addStringOption(o => o.setName('objeto').setDescription('Nombre del ítem').setRequired(true).setAutocomplete(true))
        .addIntegerOption(o => o.setName('cantidad').setDescription('Cantidad').setRequired(true))
        .addStringOption(o => o.setName('ganadores').setDescription('Ganadores separados por coma').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('perdedores').setDescription('Perdedores separados por coma').setRequired(false).setAutocomplete(true)),

    new SlashCommandBuilder().setName('subf').setDescription('Registrar compra con fecha específica')
        .addStringOption(o => o.setName('fecha').setDescription('DD/MM/YY o "hoy"').setRequired(true))
        .addStringOption(o => o.setName('evento').setDescription('Evento al que pertenece').setRequired(true).addChoices(...eventoChoices))
        .addStringOption(o => o.setName('categoria').setDescription('Categoría').setRequired(true).addChoices(...catChoices))
        .addStringOption(o => o.setName('objeto').setDescription('Nombre del ítem').setRequired(true).setAutocomplete(true))
        .addIntegerOption(o => o.setName('cantidad').setDescription('Cantidad').setRequired(true))
        .addStringOption(o => o.setName('ganadores').setDescription('Ganadores separados por coma').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('perdedores').setDescription('Perdedores separados por coma').setRequired(false).setAutocomplete(true)),

    new SlashCommandBuilder().setName('registro-rapido').setDescription('Registrar varias entradas pegando texto CSV').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(o => o.setName('texto').setDescription('Líneas CSV: fecha,evento,categoria,objeto,cantidad,ganadores,perdedores,notas').setRequired(true)),

    new SlashCommandBuilder().setName('historial').setDescription('Historial privado de compras de uno o varios jugadores')
        .addStringOption(o => o.setName('jugadores').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('categoria').setDescription('Filtrar por categoría').setRequired(false).addChoices(...catChoicesTodo))
        .addStringOption(o => o.setName('formato').setDescription('Tipo de salida').setRequired(false).addChoices(...formatoHistorialChoices)),

    new SlashCommandBuilder().setName('historial2').setDescription('Historial público de compras de uno o varios jugadores')
        .addStringOption(o => o.setName('jugadores').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('categoria').setDescription('Filtrar por categoría').setRequired(false).addChoices(...catChoicesTodo))
        .addStringOption(o => o.setName('formato').setDescription('Tipo de salida').setRequired(false).addChoices(...formatoHistorialChoices)),

    new SlashCommandBuilder().setName('dia').setDescription('Ver todas las compras de un día específico')
        .addStringOption(o => o.setName('fecha').setDescription('DD/MM/YY, "hoy" o "ayer"').setRequired(true))
        .addStringOption(o => o.setName('visibilidad').setDescription('Visibilidad del mensaje').setRequired(false).addChoices(...visibilidadChoices)),

    new SlashCommandBuilder().setName('compra').setDescription('Ver compras específicas por ID')
        .addStringOption(o => o.setName('ids').setDescription('IDs separados por coma (ej: 301,302)').setRequired(true))
        .addStringOption(o => o.setName('visibilidad').setDescription('Visibilidad del mensaje').setRequired(false).addChoices(...visibilidadChoices)),

    new SlashCommandBuilder().setName('total').setDescription('Totales por categoría de uno o varios jugadores')
        .addStringOption(o => o.setName('jugadores').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('periodo').setDescription('Periodo a considerar').setRequired(false).addChoices(...periodoChoices))
        .addStringOption(o => o.setName('visibilidad').setDescription('Visibilidad del mensaje').setRequired(false).addChoices(...visibilidadChoices)),

    new SlashCommandBuilder().setName('ranking').setDescription('Tabla general de todos los jugadores')
        .addStringOption(o => o.setName('periodo').setDescription('Periodo a considerar').setRequired(false).addChoices(...periodoChoices))
        .addStringOption(o => o.setName('categoria').setDescription('Ordenar por categoría específica').setRequired(false).addChoices(...catChoicesTodo))
        .addStringOption(o => o.setName('visibilidad').setDescription('Visibilidad del mensaje').setRequired(false).addChoices(...visibilidadChoices)),

    new SlashCommandBuilder().setName('prioridad').setDescription('Calcular prioridad para una categoría')
        .addStringOption(o => o.setName('categoria').setDescription('Categoría a evaluar').setRequired(true).addChoices(...catChoices))
        .addStringOption(o => o.setName('jugadores').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('visibilidad').setDescription('Visibilidad del mensaje').setRequired(false).addChoices(...visibilidadChoices)),

    new SlashCommandBuilder().setName('alertas').setDescription('Jugadores que superan umbrales de acaparamiento en 7 días')
        .addStringOption(o => o.setName('visibilidad').setDescription('Visibilidad del mensaje').setRequired(false).addChoices(...visibilidadChoices)),

    new SlashCommandBuilder().setName('objeto').setDescription('Ver apariciones de un objeto específico')
        .addStringOption(o => o.setName('nombre').setDescription('Nombre del objeto').setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName('periodo').setDescription('Periodo a considerar').setRequired(false).addChoices(...periodoChoices))
        .addStringOption(o => o.setName('formato').setDescription('Tipo de salida').setRequired(false).addChoices(...formatoObjetoChoices))
        .addStringOption(o => o.setName('visibilidad').setDescription('Visibilidad del mensaje').setRequired(false).addChoices(...visibilidadChoices)),

    new SlashCommandBuilder().setName('categoria').setDescription('Ver todas las apariciones de una categoría (filtrado opcional)')
        .addStringOption(o => o.setName('categoria').setDescription('Categoría a listar').setRequired(true).addChoices(...catChoices))
        .addStringOption(o => o.setName('jugador').setDescription('Filtrar por un jugador (opcional)').setRequired(false).setAutocomplete(true))
        .addStringOption(o => o.setName('periodo').setDescription('Periodo a considerar').setRequired(false).addChoices(...periodoChoices))
        .addStringOption(o => o.setName('visibilidad').setDescription('Visibilidad del mensaje').setRequired(false).addChoices(...visibilidadChoices)),

    new SlashCommandBuilder().setName('catalogo').setDescription('Gestionar catálogo de objetos')
        .addSubcommand(sub => sub.setName('agregar').setDescription('Agregar o actualizar objeto en el catálogo')
            .addStringOption(o => o.setName('objeto').setDescription('Nombre del objeto').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('categoria').setDescription('Categoría del objeto').setRequired(true).addChoices(...catChoices)))
        .addSubcommand(sub => sub.setName('quitar').setDescription('Quitar objeto del catálogo')
            .addStringOption(o => o.setName('objeto').setDescription('Nombre del objeto').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('lista').setDescription('Listar catálogo (15 por página)')),

    new SlashCommandBuilder().setName('backup').setDescription('Exportar todas las compras a un CSV').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('sync').setDescription('Sincronizar la base local con GitHub').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder().setName('miembros').setDescription('Gestionar nombres y exclusiones')
        .addSubcommand(sub => sub.setName('canonico').setDescription('Definir canónicos')
            .addStringOption(o => o.setName('nombre').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('como').setDescription('Forma correcta').setRequired(true)))
        .addSubcommand(sub => sub.setName('quitar-canonico').setDescription('Eliminar canónico')
            .addStringOption(o => o.setName('nombre').setDescription('Nombre').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('lista').setDescription('Listar canónicos registrados'))
        .addSubcommand(sub => sub.setName('excluir').setDescription('Excluir nombres')
            .addStringOption(o => o.setName('nombre').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('excluidos').setDescription('Listar excluidos'))
        .addSubcommand(sub => sub.setName('incluir').setDescription('Reincluir nombres')
            .addStringOption(o => o.setName('nombre').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true))),

    new SlashCommandBuilder().setName('editar').setDescription('Editar una entrada existente')
        .addSubcommand(sub => sub.setName('ganador').setDescription('Agregar o quitar ganadores')
            .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))
            .addStringOption(o => o.setName('accion').setDescription('Acción a realizar').setRequired(true).addChoices({ name: 'Agregar', value: 'agregar' }, { name: 'Quitar', value: 'quitar' }))
            .addStringOption(o => o.setName('jugador').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('perdedor').setDescription('Agregar o quitar perdedores')
            .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))
            .addStringOption(o => o.setName('accion').setDescription('Acción a realizar').setRequired(true).addChoices({ name: 'Agregar', value: 'agregar' }, { name: 'Quitar', value: 'quitar' }))
            .addStringOption(o => o.setName('jugador').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('reemplazar-ganador').setDescription('Reemplazar un ganador por otro')
            .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))
            .addStringOption(o => o.setName('jugador').setDescription('Nombre actual a quitar').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('por').setDescription('Nombre nuevo a poner').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('reemplazar-perdedor').setDescription('Reemplazar un perdedor por otro')
            .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))
            .addStringOption(o => o.setName('jugador').setDescription('Nombre actual a quitar').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('por').setDescription('Nombre nuevo a poner').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('set').setDescription('Cambiar objeto, cantidad, categoría, evento o fecha')
            .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))
            .addStringOption(o => o.setName('objeto').setDescription('Nuevo objeto (opcional)').setRequired(false).setAutocomplete(true))
            .addIntegerOption(o => o.setName('cantidad').setDescription('Nueva cantidad (opcional)').setRequired(false))
            .addStringOption(o => o.setName('categoria').setDescription('Nueva categoría (opcional)').setRequired(false).addChoices(...catChoices))
            .addStringOption(o => o.setName('evento').setDescription('Nuevo evento (opcional)').setRequired(false).addChoices(...eventoChoices))
            .addStringOption(o => o.setName('fecha').setDescription('Nueva fecha (DD/MM/YY o hoy)').setRequired(false)))
        .addSubcommand(sub => sub.setName('set-nota').setDescription('Establecer nota de una entrada')
            .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))
            .addStringOption(o => o.setName('nota').setDescription('Texto de la nota').setRequired(true)))
        .addSubcommand(sub => sub.setName('borrar-nota').setDescription('Borrar nota de una entrada')
            .addIntegerOption(o => o.setName('id').setDescription('ID de la entrada').setRequired(true))),

    new SlashCommandBuilder().setName('borrar').setDescription('Borrar entradas por ID')
        .addStringOption(o => o.setName('ids').setDescription('IDs separados por coma (ej: 301,302)').setRequired(true)),

    new SlashCommandBuilder().setName('ayuda').setDescription('Lista los comandos'),

    new SlashCommandBuilder().setName('panel').setDescription('Gestionar panel de subasta')
        .addSubcommand(sub => sub.setName('crear').setDescription('Crear panel en el thread actual (categoría automática)')
            .addStringOption(o => o.setName('objeto').setDescription('Nombre del objeto').setRequired(true).setAutocomplete(true))
            .addIntegerOption(o => o.setName('cantidad').setDescription('Cantidad').setRequired(true))
            .addStringOption(o => o.setName('evento').setDescription('Evento (opcional)').setRequired(false).addChoices(...eventoChoices)))
        .addSubcommand(sub => sub.setName('ver').setDescription('Mostrar el panel activo de este thread'))
        .addSubcommand(sub => sub.setName('objeto').setDescription('Cambiar el objeto del panel activo')
            .addStringOption(o => o.setName('nombre').setDescription('Nuevo nombre del objeto').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('interesado').setDescription('Añadir o quitar interesado')
            .addStringOption(o => o.setName('jugador').setDescription('Nombre del jugador').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('accion').setDescription('Añadir o Quitar').setRequired(false).addChoices({ name: 'Añadir', value: 'añadir' }, { name: 'Quitar', value: 'quitar' })))
        .addSubcommand(sub => sub.setName('indice').setDescription('Crear/actualizar índice privado en este canal')),

    new SlashCommandBuilder().setName('control').setDescription('Gestionar el Panel de Control de Subastas')
        .addSubcommand(sub => sub.setName('refresh').setDescription('Refrescar todos los paneles de control e índice'))
        .addSubcommand(sub => sub.setName('agregar').setDescription('Añadir un thread a la lista fija')
            .addStringOption(o => o.setName('objeto').setDescription('Objeto por defecto para este thread').setRequired(false).setAutocomplete(true))
            .addStringOption(o => o.setName('categoria').setDescription('Categoría por defecto para este thread').setRequired(false).addChoices(...catChoices))
            .addChannelOption(o => o.setName('canal').setDescription('Thread a fijar (o usa este mismo)').setRequired(false)))
        .addSubcommand(sub => sub.setName('quitar').setDescription('Quitar un thread de la lista fija')
            .addChannelOption(o => o.setName('canal').setDescription('Thread a quitar (o usa este mismo)').setRequired(false)))
        .addSubcommand(sub => sub.setName('panel').setDescription('Crear/actualizar el Panel de Control en este canal')),

    new SlashCommandBuilder().setName('control-boss').setDescription('Gestionar anuncios automáticos para subastas')
        .addSubcommand(sub => sub.setName('canal').setDescription('Configurar canal fijo de anuncios')
            .addChannelOption(o => o.setName('canal').setDescription('Canal de anuncios').setRequired(true)))
        .addSubcommandGroup(group => group.setName('objeto').setDescription('Gestionar slots de objetos')
            .addSubcommand(sub => sub.setName('set').setDescription('Configurar un slot')
                .addIntegerOption(o => o.setName('slot').setDescription('Slot 1 a 4').setRequired(true).setMinValue(1).setMaxValue(4))
                .addStringOption(o => o.setName('objeto').setDescription('Objeto del catálogo').setRequired(true).setAutocomplete(true))
                .addStringOption(o => o.setName('texto').setDescription('Texto del anuncio / título del thread').setRequired(true))
                .addAttachmentOption(o => o.setName('imagen').setDescription('Imagen del anuncio').setRequired(true)))
            .addSubcommand(sub => sub.setName('quitar').setDescription('Liberar un slot')
                .addIntegerOption(o => o.setName('slot').setDescription('Slot 1 a 4').setRequired(true).setMinValue(1).setMaxValue(4)))
            .addSubcommand(sub => sub.setName('lista').setDescription('Listar slots configurados')))
        .addSubcommand(sub => sub.setName('panel').setDescription('Crear/actualizar Panel de Control de Anuncios en este canal'))
        .addSubcommand(sub => sub.setName('estado').setDescription('Ver estado de anuncios pendientes')),

    new SlashCommandBuilder().setName('dado').setDescription('Tirar un dado de 25 caras en la subasta actual')
        .addStringOption(o => o.setName('jugador').setDescription('Nombre del jugador (opcional)').setRequired(false).setAutocomplete(true)),

    new SlashCommandBuilder().setName('dados').setDescription('Ver y gestionar la lista de dados tirados en este thread')
        .addSubcommand(sub => sub.setName('lista').setDescription('Mostrar la lista de dados actualizada'))
        .addSubcommand(sub => sub.setName('limpiar-lista').setDescription('Limpiar dados de uno o varios jugadores de este thread')
            .addStringOption(o => o.setName('tipo').setDescription('Limpiar todos o uno/varios jugadores').setRequired(true).addChoices({ name: 'Todos', value: 'todos' }, { name: 'Jugador', value: 'jugador' }))
            .addStringOption(o => o.setName('jugador').setDescription('Jugador(es) separados por coma (requerido si tipo=jugador)').setRequired(false).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('tirar-todos').setDescription('Tirar dados por todos los interesados anotados en el panel'))
        .addSubcommand(sub => sub.setName('tirar-varios').setDescription('Tirar dados por varios jugadores')
            .addStringOption(o => o.setName('jugadores').setDescription('Nombres separados por coma').setRequired(true).setAutocomplete(true)))
        .addSubcommand(sub => sub.setName('borrar-valor').setDescription('Borrar números específicos de un jugador')
            .addStringOption(o => o.setName('jugador').setDescription('Nombre del jugador').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('valores').setDescription('Números separados por coma (ej: 5,17)').setRequired(true)))
        .addSubcommand(sub => sub.setName('bloquear').setDescription('Bloquear el uso de /dado en este thread (solo roles mayores)')
            .addIntegerOption(o => o.setName('minutos').setDescription('Duración en minutos (default 60)').setRequired(false).setMinValue(1).setMaxValue(1440)))
        .addSubcommand(sub => sub.setName('desbloquear').setDescription('Desbloquear el uso de /dado en este thread (solo roles mayores)'))
];

module.exports = { commandsData };
