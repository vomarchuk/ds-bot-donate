require("dotenv").config({
  path: require("path").join(__dirname, ".env"),
});

const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("donat")
    .setDescription("Вибір предмета і відправка JSON на сервер (за Steam64)")
    .addStringOption((o) =>
      o
        .setName("steam_id")
        .setDescription("Steam64 — 17 цифр")
        .setRequired(true)
    )
    .toJSON(),
];

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !clientId) {
    console.error(".env: DISCORD_TOKEN, DISCORD_CLIENT_ID");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(token);

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
    console.log("Команди зареєстровано для гільдії", guildId);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("Глобальні команди (оновлення до ~1 год)");
  }
}

main().catch(console.error);
