require("dotenv").config({
  path: require("path").join(__dirname, ".env"),
});

const {
  Client,
  Events,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require("discord.js");
const path = require("path");
const fs = require("fs");
const {
  listKiwiDonatForSteam,
  normalizeSteamId64,
  getKiwiDonatRootPath,
  uploadBufferToFtp,
} = require("./lib/ftpClient");

function loadDonatItems() {
  const p = path.join(__dirname, "donatItems.json");
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
  }
  return [
    {
      id: "med_kit",
      label: "Medical Kit",
      description: "Бинти + морфін + салін",
      Items: [
        {
          className: "BandageDressing",
          quantity: 5,
          attachments: [],
          contains: [],
        },
      ],
    },
    {
      id: "ammo_556",
      label: "5.56 Ammo",
      description: "60 патронів 5.56x45",
      Items: [
        {
          className: "Ammo_556x45",
          quantity: 60,
          attachments: [],
          contains: [],
        },
      ],
    },
  ];
}

function makeSelectCustomId(steamId) {
  return `donat_item_select:${steamId}`;
}

function parseSelectCustomId(customId) {
  const prefix = "donat_item_select:";
  if (!customId || !customId.startsWith(prefix)) return null;
  const steamId = customId.slice(prefix.length);
  try {
    return normalizeSteamId64(steamId);
  } catch {
    return null;
  }
}

function safeFilenamePart(s) {
  return String(s || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 64);
}

function normalizeOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return items.map((it) => ({
    className: String(it.className || "").trim(),
    quantity: Number.isFinite(Number(it.quantity))
      ? Math.max(1, Math.floor(Number(it.quantity)))
      : 1,
    attachments: Array.isArray(it.attachments)
      ? it.attachments.map(String)
      : [],
    contains: Array.isArray(it.contains) ? it.contains.map(String) : [],
  }));
}

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error(".env: DISCORD_TOKEN");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log("Discord:", c.user.tag);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Step 1: /donat <steamId> -> show item select
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName !== "donat") return;
    await interaction.deferReply({ ephemeral: true });

    const steamRaw = interaction.options.getString("steam_id", true);
    let steamId;
    try {
      steamId = normalizeSteamId64(steamRaw);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      await interaction.editReply({ content: `SteamID невірний: ${msg}` });
      return;
    }

    try {
      // Validate that player folder exists / accessible
      await listKiwiDonatForSteam(steamId);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      await interaction.editReply({
        content: `Не вдалося відкрити папку гравця на FTP для **${steamId}**.\nПомилка: ${msg}`,
      });
      return;
    }

    const items = loadDonatItems();
    if (!items.length) {
      await interaction.editReply({
        content:
          "Список предметів порожній. Додай `donatItems.json` (масив items).",
      });
      return;
    }

    const options = items.slice(0, 25).map((it) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(String(it.label || it.id).slice(0, 100))
        .setValue(String(it.id))
        .setDescription(
          it.description ? String(it.description).slice(0, 100) : undefined,
        ),
    );

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(makeSelectCustomId(steamId))
        .setPlaceholder("Вибери предмет…")
        .addOptions(options),
    );

    await interaction.editReply({
      content: `SteamID: **${steamId}**\nОбери предмет, і я відправлю JSON на сервер.`,
      components: [row],
    });
    return;
  }

  // Step 2: select item -> upload JSON to FTP
  if (interaction.isStringSelectMenu()) {
    const steamId = parseSelectCustomId(interaction.customId);
    if (!steamId) return;

    if (interaction.user?.id && interaction.message?.interaction?.user?.id) {
      // Only allow the user who ran the original command to use the menu.
      if (interaction.user.id !== interaction.message.interaction.user.id) {
        await interaction.reply({
          ephemeral: true,
          content: "Це меню не для тебе.",
        });
        return;
      }
    }

    await interaction.deferReply({ ephemeral: true });

    const selectedItemId = interaction.values && interaction.values[0];
    const allItems = loadDonatItems();
    const item = allItems.find((x) => String(x.id) === String(selectedItemId));
    if (!item) {
      await interaction.editReply({
        content: "Не знайшов предмет у списку (можливо оновили конфіг).",
      });
      return;
    }

    const now = new Date();
    const orderItems = normalizeOrderItems(item.Items);
    if (!orderItems || orderItems.some((x) => !x.className)) {
      await interaction.editReply({
        content:
          "Конфіг предмета неправильний: потрібен `Items` (масив) з `className`/`quantity`/`attachments`/`contains`.",
      });
      return;
    }
    const payload = { Items: orderItems };

    const root = getKiwiDonatRootPath();
    const ts = now.toISOString().replace(/[:.]/g, "-");
    const fileName = `${ts}_${safeFilenamePart(item.id)}.json`;
    const remotePath = `${root}/${steamId}/${fileName}`.replace(/\\/g, "/");

    try {
      const buf = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
      const res = await uploadBufferToFtp(buf, remotePath);
      await interaction.editReply({
        content: `Готово. JSON відправлено на FTP:\n**${res.remotePath}**`,
      });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      await interaction.editReply({
        content: `Не вдалося відправити JSON: ${msg}`,
      });
    }
  }
});

client.login(token);
