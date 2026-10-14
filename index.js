// Bot mínimo de prueba
require('dotenv').config(); // Carga las variables de entorno
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent // Necesario para leer mensajes
    ]
});

client.on('ready', () => {
    console.log(`¡Bot listo! Conectado como ${client.user.tag}`);
});

client.on('messageCreate', (message) => {
    // Ignora mensajes de otros bots o mensajes vacíos
    if (message.author.bot) return;

    // Comando !ping
    if (message.content.toLowerCase() === '!ping') {
        message.reply('pong');
    }
});

// Inicia sesión con el token del bot
client.login(process.env.DISCORD_TOKEN);
