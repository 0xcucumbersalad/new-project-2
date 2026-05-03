/**
 * Installation:
 * 1. Run: npm install
 * 2. Create a .env file with DISCORD_TOKEN=your_bot_token
 * 3. In the Discord Developer Portal, enable the Message Content Intent
 * 4. Invite the bot to your server with bot + message permissions
 * 5. Start the bot with: npm start
 *
 * Commands:
 * !help
 * !join
 * !play <YouTube URL, YouTube playlist URL, Spotify track URL, Spotify playlist URL, or search term>
 * !queue
 * !q = !queue
 * !shuffle
 * !loop
 * !pause
 * !resume
 * !skip
 * !skipto [track number]
 * !stop
 * !leave
 * !p = !play
 * !s = !skip
 */

require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const { PREFIX, TOKEN } = require("./config");
const { MusicManager } = require("./music/MusicManager");
const { createMusicCommands } = require("./commands/musicCommands");

if (!TOKEN) {
  throw new Error("Missing DISCORD_TOKEN in your environment.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const musicManager = new MusicManager();
const commands = createMusicCommands(musicManager);

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) {
    return;
  }

  if (!message.content.startsWith(PREFIX)) {
    return;
  }

  const withoutPrefix = message.content.slice(PREFIX.length).trim();

  if (!withoutPrefix) {
    return;
  }

  const [commandName, ...args] = withoutPrefix.split(/\s+/);
  const command = commands[commandName.toLowerCase()];

  if (!command) {
    return;
  }

  try {
    await command(message, args);
  } catch (error) {
    console.error(`Command "${commandName}" failed:`, error);
    await message.reply(error.message || "Something went wrong while handling that command.");
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    await musicManager.handleVoiceStateUpdate(oldState, newState);
  } catch (error) {
    console.error("Voice state handler failed:", error);
  }
});

client.login(TOKEN);
