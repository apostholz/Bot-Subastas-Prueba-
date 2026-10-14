require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const CATEGORIAS = [
    'Cajas 20k',
    'Caja 10k',
    'Emblemas Generales',
    'Emblemas Únicos',
    'Emblemas Azules',
    'Equipo',
    'Accesorios'
];

const commands = [
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

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Registrando comandos...');
        await rest.put(
            Routes.applicationCommands(process.env.DISCORD_APP_ID),
            { body: commands.map(c => c.toJSON()) }
        );
        console.log('✅ Comandos registrados.');
    } catch (err) {
        console.error(err);
    }
})();
