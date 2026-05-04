const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
} = require("discord.js");
const { resolveRequest } = require("./trackResolver");
const { createYouTubeAudioSource } = require("./youtubeAudioSource");

const EMPTY_CHANNEL_TIMEOUT_MS = 5 * 60 * 1000;
const EMBED_COLOR = 0x5865f2;
const QUEUE_PAGE_SIZE = 10;
const QUEUE_CONTROLS_TIMEOUT_MS = 60 * 1000;
const SKIP_TO_PROMPT_TIMEOUT_MS = 60 * 1000;

async function safeSend(channel, payload) {
  if (!channel) {
    return;
  }

  try {
    await channel.send(payload);
  } catch (error) {
    console.error("Failed to send message:", error);
  }
}

function buildNowPlayingEmbed(track) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(track.title)
    .setDescription("Now Playing");

  if (track.url) {
    embed.setURL(track.url);
  }

  return embed;
}

function buildQueuedTrackEmbed(track) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(track.title)
    .setDescription("Queued");

  if (track.url) {
    embed.setURL(track.url);
  }

  return embed;
}

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("Music Commands")
    .setDescription("Prefix: `!`")
    .addFields(
      {
        name: "Playback",
        value: [
          "`!play <query or url>`",
          "`!p <query or url>`",
          "`!skip`",
          "`!s`",
          "`!skipto [track number]`",
          "`!stop`",
          "`!pause`",
          "`!resume`",
          "`!loop`",
          "`!shuffle`",
        ].join("\n"),
      },
      {
        name: "Voice",
        value: ["`!join`", "`!leave`"].join("\n"),
      },
      {
        name: "Queue",
        value: ["`!queue`", "`!q`"].join("\n"),
      },
      {
        name: "Other",
        value: "`!help`",
      }
    );
}

function buildQueueControls(pageIndex, totalPages, disabled = false, prefix = "queue") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}-prev`)
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || pageIndex === 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}-next`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || pageIndex >= totalPages - 1)
  );
}

function buildQueueEmbed(session, tracks, pageIndex = 0) {
  const currentTrack = tracks[0];
  const upcomingTracks = tracks.slice(1);
  const totalPages = Math.max(1, Math.ceil(upcomingTracks.length / QUEUE_PAGE_SIZE));
  const clampedPageIndex = Math.min(Math.max(pageIndex, 0), totalPages - 1);
  const startIndex = clampedPageIndex * QUEUE_PAGE_SIZE;
  const visibleTracks = upcomingTracks.slice(startIndex, startIndex + QUEUE_PAGE_SIZE);
  const lines = [`**Now playing:** ${currentTrack.title}`, `**Loop:** ${session.isLoopEnabled() ? "on" : "off"}`];

  if (visibleTracks.length > 0) {
    lines.push("");
    lines.push("**Up next:**");

    visibleTracks.forEach((track, index) => {
      lines.push(`${startIndex + index + 1}. ${track.title}`);
    });
  } else if (upcomingTracks.length === 0) {
    lines.push("");
    lines.push("No upcoming tracks.");
  }

  if (totalPages > 1) {
    lines.push("");
    lines.push(`Page ${clampedPageIndex + 1}/${totalPages}`);
  }

  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("Queue")
    .setDescription(lines.join("\n"));
}

function buildSkipToEmbed(session, tracks, pageIndex = 0) {
  const currentTrack = tracks[0];
  const upcomingTracks = tracks.slice(1);
  const totalPages = Math.max(1, Math.ceil(upcomingTracks.length / QUEUE_PAGE_SIZE));
  const clampedPageIndex = Math.min(Math.max(pageIndex, 0), totalPages - 1);
  const startIndex = clampedPageIndex * QUEUE_PAGE_SIZE;
  const visibleTracks = upcomingTracks.slice(startIndex, startIndex + QUEUE_PAGE_SIZE);
  const lines = [`**Now playing:** ${currentTrack.title}`];

  if (visibleTracks.length > 0) {
    lines.push("");
    lines.push("**Choose a track number:**");

    visibleTracks.forEach((track, index) => {
      lines.push(`${startIndex + index + 1}. ${track.title}`);
    });
  }

  lines.push("");
  lines.push("Reply with the track number you want to skip to.");

  if (totalPages > 1) {
    lines.push(`Page ${clampedPageIndex + 1}/${totalPages}`);
  }

  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("Skip To")
    .setDescription(lines.join("\n"));
}

class GuildMusicSession {
  constructor(guildId, onDispose) {
    this.guildId = guildId;
    this.onDispose = onDispose;
    this.queue = [];
    this.loopCurrentTrack = false;
    this.skipRequested = false;
    this.emptyChannelTimeout = null;
    this.connection = null;
    this.currentSourceCleanup = null;
    this.textChannel = null;
    this.voiceChannelId = null;
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    this.player.on(AudioPlayerStatus.Idle, (oldState) => {
      this.handleIdle(oldState).catch((error) => {
        console.error("Idle handler error:", error);
      });
    });

    this.player.on("error", (error) => {
      this.handlePlayerError(error).catch((handlerError) => {
        console.error("Audio player error handler failure:", handlerError);
      });
    });
  }

  async connect(voiceChannel, textChannel) {
    this.textChannel = textChannel;
    this.voiceChannelId = voiceChannel.id;
    this.clearEmptyChannelTimeout();
    const existingChannelId = this.connection?.joinConfig?.channelId || this.voiceChannelId;

    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      if (existingChannelId !== voiceChannel.id) {
        this.connection.rejoin({
          channelId: voiceChannel.id,
          selfDeaf: true,
        });
      }
    } else {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true,
      });

      connection.on(VoiceConnectionStatus.Disconnected, () => {
        this.handleDisconnect(connection).catch((error) => {
          console.error("Voice disconnect handler error:", error);
        });
      });

      connection.on("stateChange", (_, newState) => {
        console.log(`Voice connection ${this.guildId}: ${newState.status}`);
      });

      this.connection = connection;
    }

    try {
      if (this.connection.state.status !== VoiceConnectionStatus.Ready) {
        await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
      }

      this.connection.subscribe(this.player);

      await this.updateEmptyChannelState(voiceChannel);
    } catch (error) {
      const connection = this.connection;
      this.connection = null;
      this.voiceChannelId = null;

      if (connection) {
        connection.destroy();
      }

      throw new Error(
        "I couldn't fully connect to that voice channel. Check that the bot has Connect and Speak permissions, then try again in a normal voice channel."
      );
    }
  }

  async enqueue(track, voiceChannel, textChannel) {
    await this.connect(voiceChannel, textChannel);
    await this.enqueueResolvedTrack(track);
  }

  async enqueueMany(tracks, voiceChannel, textChannel) {
    await this.connect(voiceChannel, textChannel);
    await this.enqueueResolvedTracks(tracks);
  }

  async enqueueResolvedTrack(track) {
    this.queue.push(track);

    if (this.player.state.status === AudioPlayerStatus.Idle && this.queue.length === 1) {
      await this.playNext();
    }
  }

  async enqueueResolvedTracks(tracks) {
    this.queue.push(...tracks);

    if (this.player.state.status === AudioPlayerStatus.Idle && this.queue.length === tracks.length) {
      await this.playNext();
    }
  }

  stop() {
    this.queue.length = 0;
    this.loopCurrentTrack = false;
    this.skipRequested = false;
    this.cleanupCurrentSource();
    this.player.stop(true);
  }

  skip() {
    if (this.player.state.status === AudioPlayerStatus.Idle || this.queue.length === 0) {
      return false;
    }

    this.skipRequested = true;
    this.cleanupCurrentSource();
    this.player.stop(true);
    return true;
  }

  skipTo(trackNumber) {
    if (!Number.isInteger(trackNumber) || trackNumber < 1) {
      return { ok: false, reason: "invalid-number" };
    }

    if (this.queue.length <= 1) {
      return { ok: false, reason: "empty-upcoming" };
    }

    if (trackNumber >= this.queue.length) {
      return { ok: false, reason: "out-of-range", maxTrackNumber: this.queue.length - 1 };
    }

    this.loopCurrentTrack = false;
    this.skipRequested = true;
    this.queue.splice(1, trackNumber - 1);
    this.cleanupCurrentSource();
    this.player.stop(true);

    return {
      ok: true,
      track: this.queue[1] || this.queue[0],
    };
  }

  pause() {
    if (this.player.state.status !== AudioPlayerStatus.Playing) {
      return false;
    }

    return this.player.pause(true);
  }

  resume() {
    if (this.player.state.status !== AudioPlayerStatus.Paused) {
      return false;
    }

    return this.player.unpause();
  }

  getQueueSnapshot() {
    return [...this.queue];
  }

  isLoopEnabled() {
    return this.loopCurrentTrack;
  }

  toggleLoop() {
    this.loopCurrentTrack = !this.loopCurrentTrack;
    return this.loopCurrentTrack;
  }

  shuffleUpcoming() {
    if (this.queue.length < 3) {
      return false;
    }

    const currentTrack = this.queue[0];
    const upcomingTracks = this.queue.slice(1);

    for (let index = upcomingTracks.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [upcomingTracks[index], upcomingTracks[randomIndex]] = [upcomingTracks[randomIndex], upcomingTracks[index]];
    }

    this.queue = [currentTrack, ...upcomingTracks];
    return true;
  }

  async disconnect() {
    this.queue.length = 0;
    this.loopCurrentTrack = false;
    this.skipRequested = false;
    this.clearEmptyChannelTimeout();
    this.cleanupCurrentSource();
    this.player.stop(true);

    const connection = this.connection;
    this.connection = null;
    this.voiceChannelId = null;

    if (connection) {
      connection.destroy();
    }

    this.onDispose(this.guildId);
  }

  async handleIdle(oldState) {
    if (oldState.status !== AudioPlayerStatus.Idle) {
      this.cleanupCurrentSource();
      const shouldAdvanceQueue = this.skipRequested || !this.loopCurrentTrack;

      this.skipRequested = false;

      if (shouldAdvanceQueue) {
        this.queue.shift();
      }
    }

    if (this.queue.length > 0) {
      await this.playNext();
    }
  }

  async handlePlayerError(error) {
    console.error(`Audio player error in guild ${this.guildId}:`, error);
    await safeSend(this.textChannel, `Playback error: ${error.message}`);
    this.cleanupCurrentSource();
    this.skipRequested = false;

    if (this.queue.length > 0) {
      this.queue.shift();
    }

    if (this.queue.length > 0) {
      await this.playNext();
    }
  }

  async handleDisconnect(connection) {
    if (!this.connection || this.connection !== connection) {
      return;
    }

    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      await this.disconnect();
    }
  }

  cleanupCurrentSource() {
    if (this.currentSourceCleanup) {
      this.currentSourceCleanup();
      this.currentSourceCleanup = null;
    }
  }

  clearEmptyChannelTimeout() {
    if (this.emptyChannelTimeout) {
      clearTimeout(this.emptyChannelTimeout);
      this.emptyChannelTimeout = null;
    }
  }

  getNonBotMemberCount(voiceChannel) {
    if (!voiceChannel?.members) {
      return 0;
    }

    return voiceChannel.members.filter((member) => !member.user.bot).size;
  }

  async updateEmptyChannelState(voiceChannel) {
    if (!voiceChannel || voiceChannel.id !== this.voiceChannelId) {
      this.clearEmptyChannelTimeout();
      return;
    }

    if (this.getNonBotMemberCount(voiceChannel) > 0) {
      this.clearEmptyChannelTimeout();
      return;
    }

    if (this.emptyChannelTimeout) {
      return;
    }

    await safeSend(this.textChannel, "Everyone left the voice channel. I'll leave in 5 minutes if nobody comes back.");

    this.emptyChannelTimeout = setTimeout(() => {
      this.handleEmptyChannelTimeout(voiceChannel.guild.id, voiceChannel.id).catch((error) => {
        console.error("Empty voice channel timeout handler error:", error);
      });
    }, EMPTY_CHANNEL_TIMEOUT_MS);
  }

  async handleEmptyChannelTimeout(guildId, channelId) {
    this.emptyChannelTimeout = null;

    if (!this.connection || this.connection.state.status === VoiceConnectionStatus.Destroyed || this.voiceChannelId !== channelId) {
      return;
    }

    const guild = this.textChannel?.guild;
    const voiceChannel = guild?.channels?.cache?.get(channelId);

    if (!voiceChannel || this.getNonBotMemberCount(voiceChannel) > 0) {
      return;
    }

    await safeSend(this.textChannel, "No one came back, so I left the voice channel.");
    await this.disconnect();
  }

  async playNext() {
    const nextTrack = this.queue[0];

    if (!nextTrack) {
      return;
    }

    if (!nextTrack.videoId) {
      await safeSend(this.textChannel, `Could not resolve a playable YouTube video for "${nextTrack.title}".`);
      this.queue.shift();

      if (this.queue.length > 0) {
        await this.playNext();
      }

      return;
    }

    try {
      this.cleanupCurrentSource();
      const source = await createYouTubeAudioSource(nextTrack.videoId);
      const resource = createAudioResource(source.stream, {
        inputType: source.inputType,
      });
      this.currentSourceCleanup = source.cleanup;

      this.player.play(resource);
      await safeSend(this.textChannel, { embeds: [buildNowPlayingEmbed(nextTrack)] });
    } catch (error) {
      console.error(`Failed to play track in guild ${this.guildId}:`, error);
      await safeSend(this.textChannel, `Could not play "${nextTrack.title}". Skipping it.`);
      this.queue.shift();

      if (this.queue.length > 0) {
        await this.playNext();
      }
    }
  }
}

class MusicManager {
  constructor() {
    this.sessions = new Map();
  }

  getSession(guildId) {
    if (!this.sessions.has(guildId)) {
      this.sessions.set(guildId, new GuildMusicSession(guildId, this.disposeSession.bind(this)));
    }

    return this.sessions.get(guildId);
  }

  disposeSession(guildId) {
    this.sessions.delete(guildId);
  }

  getMemberVoiceChannel(message) {
    const voiceChannel = message.member?.voice?.channel;

    if (!voiceChannel) {
      throw new Error("You need to be in a voice channel to use this command.");
    }

    return voiceChannel;
  }

  getBotVoiceChannelId(message, session) {
    const guildMemberVoiceChannelId = message.guild.members.me?.voice?.channelId;

    if (guildMemberVoiceChannelId) {
      return guildMemberVoiceChannelId;
    }

    const cachedVoiceStateChannelId = message.guild.voiceStates.cache.get(message.client.user.id)?.channelId;

    if (cachedVoiceStateChannelId) {
      return cachedVoiceStateChannelId;
    }

    const activeConnectionChannelId = getVoiceConnection(message.guild.id)?.joinConfig?.channelId;

    if (activeConnectionChannelId) {
      return activeConnectionChannelId;
    }

    if (
      !session ||
      !session.connection ||
      session.connection.state.status === VoiceConnectionStatus.Destroyed ||
      !session.voiceChannelId
    ) {
      return null;
    }

    return session.voiceChannelId;
  }

  async clearStaleVoiceSession(message, session, channelId) {
    if (!channelId) {
      return false;
    }

    const existingChannel = message.guild.channels.cache.get(channelId);

    if (existingChannel) {
      return false;
    }

    if (session) {
      try {
        await session.disconnect();
      } catch (error) {
        console.error("Failed to clear stale voice session:", error);
      }
    } else {
      const connection = getVoiceConnection(message.guild.id);

      if (connection) {
        connection.destroy();
      }
    }

    return true;
  }

  async ensureSameVoiceChannel(message, session, memberVoiceChannel) {
    const botVoiceChannelId = this.getBotVoiceChannelId(message, session);

    if (await this.clearStaleVoiceSession(message, session, botVoiceChannelId)) {
      return true;
    }

    if (!botVoiceChannelId || botVoiceChannelId === memberVoiceChannel.id) {
      return true;
    }

    await message.reply("I'm already in another voice channel.");
    return false;
  }

  async join(message) {
    const voiceChannel = this.getMemberVoiceChannel(message);
    const session = this.getSession(message.guild.id);

    if (!(await this.ensureSameVoiceChannel(message, session, voiceChannel))) {
      return;
    }

    await session.connect(voiceChannel, message.channel);
    await message.reply(`Joined ${voiceChannel.name}.`);
  }

  async help(message) {
    await message.reply({ embeds: [buildHelpEmbed()] });
  }

  async play(message, query) {
    const voiceChannel = this.getMemberVoiceChannel(message);
    const session = this.getSession(message.guild.id);

    if (!(await this.ensureSameVoiceChannel(message, session, voiceChannel))) {
      return;
    }

    const shouldSendQueuedMessage =
      session.queue.length > 0 || session.player.state.status !== AudioPlayerStatus.Idle;
    const hadActiveConnection = Boolean(this.getBotVoiceChannelId(message, session));
    const connectPromise = session.connect(voiceChannel, message.channel);
    let resolved;

    try {
      [resolved] = await Promise.all([resolveRequest(query), connectPromise]);
    } catch (error) {
      await connectPromise.catch(() => {});

      if (!hadActiveConnection && session.queue.length === 0 && session.player.state.status === AudioPlayerStatus.Idle) {
        try {
          await session.disconnect();
        } catch (disconnectError) {
          console.error("Failed to clean up voice connection after play error:", disconnectError);
        }
      }

      throw error;
    }

    if (!resolved.tracks.length) {
      throw new Error("I couldn't find any playable tracks for that request.");
    }

    if (resolved.tracks.length === 1) {
      const track = resolved.tracks[0];

      await session.enqueueResolvedTrack(track);

      if (shouldSendQueuedMessage) {
        await message.reply({ embeds: [buildQueuedTrackEmbed(track)] });
      }

      return;
    }

    await session.enqueueResolvedTracks(resolved.tracks);

    const responseParts = [`Queued ${resolved.tracks.length} tracks`];

    if (resolved.sourceType === "spotify-playlist" && resolved.sourceTitle) {
      responseParts.push(`from Spotify playlist "${resolved.sourceTitle}"`);
    }

    if (resolved.sourceType === "youtube-playlist" && resolved.sourceTitle) {
      responseParts.push(`from YouTube playlist "${resolved.sourceTitle}"`);
    }

    if (resolved.skippedCount > 0) {
      const skipReason = resolved.skipReason ? ` ${resolved.skipReason}` : "";
      responseParts.push(`and skipped ${resolved.skippedCount} track${resolved.skippedCount === 1 ? "" : "s"}${skipReason}`);
    }

    if (resolved.truncated) {
      responseParts.push("Spotify only exposed the first 30 public tracks for this playlist");
    }

    await message.reply(`${responseParts.join(" ")}.`);
  }

  async stop(message) {
    const session = this.sessions.get(message.guild.id);

    if (!session || (session.queue.length === 0 && session.player.state.status === AudioPlayerStatus.Idle)) {
      await message.reply("There is nothing playing right now.");
      return;
    }

    const voiceChannel = this.getMemberVoiceChannel(message);

    if (!(await this.ensureSameVoiceChannel(message, session, voiceChannel))) {
      return;
    }

    session.stop();
    await message.reply("Stopped playback and cleared the queue.");
  }

  async skip(message) {
    const session = this.sessions.get(message.guild.id);

    if (session) {
      const voiceChannel = this.getMemberVoiceChannel(message);

      if (!(await this.ensureSameVoiceChannel(message, session, voiceChannel))) {
        return;
      }
    }

    if (!session || !session.skip()) {
      await message.reply("There is nothing to skip right now.");
      return;
    }

    await message.reply("Skipped the current track.");
  }

  async skipTo(message, trackNumber = null) {
    const session = this.sessions.get(message.guild.id);

    if (!session || session.queue.length <= 1) {
      await message.reply("There are no upcoming tracks to skip to.");
      return;
    }

    const voiceChannel = this.getMemberVoiceChannel(message);

    if (!(await this.ensureSameVoiceChannel(message, session, voiceChannel))) {
      return;
    }

    if (trackNumber !== null) {
      const result = session.skipTo(trackNumber);

      if (!result.ok) {
        if (result.reason === "out-of-range") {
          await message.reply(`That track number is out of range. Choose a number from 1 to ${result.maxTrackNumber}.`);
          return;
        }

        await message.reply("Use !skipto <track number>, for example !skipto 3.");
        return;
      }

      await message.reply(`Skipping to track ${trackNumber}.`);
      return;
    }

    const tracks = session.getQueueSnapshot();
    let totalPages = Math.max(1, Math.ceil(Math.max(0, tracks.length - 1) / QUEUE_PAGE_SIZE));
    let pageIndex = 0;
    let promptClosed = false;
    const promptMessage = await message.reply({
      embeds: [buildSkipToEmbed(session, tracks, pageIndex)],
      components: totalPages > 1 ? [buildQueueControls(pageIndex, totalPages, false, "skipto")] : [],
    });

    void (async () => {
      if (totalPages <= 1) {
        return;
      }

      while (!promptClosed) {
        try {
          const interaction = await promptMessage.awaitMessageComponent({
            componentType: ComponentType.Button,
            time: SKIP_TO_PROMPT_TIMEOUT_MS,
            filter: (componentInteraction) => {
              if (componentInteraction.user.id === message.author.id) {
                return true;
              }

              componentInteraction
                .reply({
                  content: "Only the person who opened this skip prompt can flip pages.",
                  ephemeral: true,
                })
                .catch(() => {});

              return false;
            },
          });

          if (interaction.customId === "skipto-prev") {
            pageIndex = Math.max(0, pageIndex - 1);
          }

          if (interaction.customId === "skipto-next") {
            pageIndex = Math.min(totalPages - 1, pageIndex + 1);
          }

          totalPages = Math.max(1, Math.ceil(Math.max(0, session.getQueueSnapshot().length - 1) / QUEUE_PAGE_SIZE));
          pageIndex = Math.min(pageIndex, totalPages - 1);

          await interaction.update({
            embeds: [buildSkipToEmbed(session, session.getQueueSnapshot(), pageIndex)],
            components: totalPages > 1 ? [buildQueueControls(pageIndex, totalPages, false, "skipto")] : [],
          });
        } catch {
          break;
        }
      }
    })();

    try {
      const collected = await message.channel.awaitMessages({
        filter: (candidate) =>
          candidate.author.id === message.author.id &&
          candidate.channel.id === message.channel.id &&
          /^\d+$/.test(candidate.content.trim()),
        max: 1,
        time: SKIP_TO_PROMPT_TIMEOUT_MS,
        errors: ["time"],
      });
      const selectedTrackNumber = Number.parseInt(collected.first().content.trim(), 10);
      const latestTracks = session.getQueueSnapshot();
      totalPages = Math.max(1, Math.ceil(Math.max(0, latestTracks.length - 1) / QUEUE_PAGE_SIZE));
      pageIndex = Math.min(pageIndex, totalPages - 1);

      if (selectedTrackNumber < 1 || selectedTrackNumber >= latestTracks.length) {
        promptClosed = true;
        await promptMessage.edit({
          embeds: [
            buildSkipToEmbed(session, latestTracks, pageIndex).setFooter({
              text: `That track number is out of range. Choose 1 to ${Math.max(1, latestTracks.length - 1)}.`,
            }),
          ],
          components: totalPages > 1 ? [buildQueueControls(pageIndex, totalPages, true, "skipto")] : [],
        });
        return;
      }

      const result = session.skipTo(selectedTrackNumber);

      if (!result.ok) {
        promptClosed = true;
        await message.reply("That skip target is no longer available.");
        return;
      }

      promptClosed = true;
      await promptMessage.edit({
        embeds: [
          buildSkipToEmbed(session, session.getQueueSnapshot(), pageIndex).setFooter({
            text: `Skipping to track ${selectedTrackNumber}.`,
          }),
        ],
        components: totalPages > 1 ? [buildQueueControls(pageIndex, totalPages, true, "skipto")] : [],
      });
      await message.reply(`Skipping to track ${selectedTrackNumber}.`);
    } catch {
      promptClosed = true;
      await promptMessage
        .edit({
          embeds: [
            buildSkipToEmbed(session, tracks, pageIndex).setFooter({
              text: "Skip prompt timed out.",
            }),
          ],
          components: totalPages > 1 ? [buildQueueControls(pageIndex, totalPages, true, "skipto")] : [],
        })
        .catch(() => {});
    }
  }

  async pause(message) {
    const session = this.sessions.get(message.guild.id);

    if (!session) {
      await message.reply("There is nothing playing right now.");
      return;
    }

    const voiceChannel = this.getMemberVoiceChannel(message);

    if (!(await this.ensureSameVoiceChannel(message, session, voiceChannel))) {
      return;
    }

    if (session.player.state.status === AudioPlayerStatus.Paused) {
      await message.reply("Playback is already paused.");
      return;
    }

    if (!session.pause()) {
      await message.reply("There is nothing playing right now.");
      return;
    }

    await message.reply("Paused playback.");
  }

  async resume(message) {
    const session = this.sessions.get(message.guild.id);

    if (!session) {
      await message.reply("There is nothing paused right now.");
      return;
    }

    const voiceChannel = this.getMemberVoiceChannel(message);

    if (!(await this.ensureSameVoiceChannel(message, session, voiceChannel))) {
      return;
    }

    if (session.player.state.status === AudioPlayerStatus.Playing) {
      await message.reply("Playback is already running.");
      return;
    }

    if (!session.resume()) {
      await message.reply("There is nothing paused right now.");
      return;
    }

    await message.reply("Resumed playback.");
  }

  async queue(message) {
    const session = this.sessions.get(message.guild.id);

    if (!session) {
      await message.reply("The queue is empty.");
      return;
    }

    const tracks = session.getQueueSnapshot();

    if (tracks.length === 0) {
      await message.reply("The queue is empty.");
      return;
    }

    const totalPages = Math.max(1, Math.ceil(Math.max(0, tracks.length - 1) / QUEUE_PAGE_SIZE));
    let pageIndex = 0;
    const replyPayload = {
      embeds: [buildQueueEmbed(session, tracks, pageIndex)],
    };

    if (totalPages > 1) {
      replyPayload.components = [buildQueueControls(pageIndex, totalPages)];
    }

    const queueMessage = await message.reply(replyPayload);

    if (totalPages <= 1) {
      return;
    }

    while (true) {
      try {
        const interaction = await queueMessage.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: QUEUE_CONTROLS_TIMEOUT_MS,
          filter: (componentInteraction) => {
            if (componentInteraction.user.id === message.author.id) {
              return true;
            }

            componentInteraction
              .reply({
                content: "Only the person who opened this queue can flip pages.",
                ephemeral: true,
              })
              .catch(() => {});

            return false;
          },
        });

        if (interaction.customId === "queue-prev") {
          pageIndex = Math.max(0, pageIndex - 1);
        }

        if (interaction.customId === "queue-next") {
          pageIndex = Math.min(totalPages - 1, pageIndex + 1);
        }

        await interaction.update({
          embeds: [buildQueueEmbed(session, tracks, pageIndex)],
          components: [buildQueueControls(pageIndex, totalPages)],
        });
      } catch {
        await queueMessage
          .edit({
            embeds: [buildQueueEmbed(session, tracks, pageIndex)],
            components: [buildQueueControls(pageIndex, totalPages, true)],
          })
          .catch(() => {});
        break;
      }
    }
  }

  async shuffle(message) {
    const session = this.sessions.get(message.guild.id);

    if (!session || session.queue.length === 0) {
      await message.reply("The queue is empty.");
      return;
    }

    const voiceChannel = this.getMemberVoiceChannel(message);

    if (!(await this.ensureSameVoiceChannel(message, session, voiceChannel))) {
      return;
    }

    if (!session.shuffleUpcoming()) {
      await message.reply("Add at least two upcoming tracks before shuffling.");
      return;
    }

    await message.reply("Shuffled the upcoming queue.");
  }

  async loop(message) {
    const session = this.sessions.get(message.guild.id);

    if (!session || session.queue.length === 0) {
      await message.reply("There is nothing playing right now.");
      return;
    }

    const voiceChannel = this.getMemberVoiceChannel(message);

    if (!(await this.ensureSameVoiceChannel(message, session, voiceChannel))) {
      return;
    }

    const loopEnabled = session.toggleLoop();
    await message.reply(`Loop is now ${loopEnabled ? "on" : "off"}.`);
  }

  async leave(message) {
    const session = this.sessions.get(message.guild.id);

    if (!session) {
      await message.reply("I am not connected to a voice channel.");
      return;
    }

    const voiceChannel = this.getMemberVoiceChannel(message);

    if (!(await this.ensureSameVoiceChannel(message, session, voiceChannel))) {
      return;
    }

    await session.disconnect();
    await message.reply("Left the voice channel.");
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const guild = newState.guild || oldState.guild;
    const session = this.sessions.get(guild.id);

    if (!session) {
      return;
    }

    const clientUserId = newState.client.user?.id;
    const botVoiceChannelId =
      guild.members.me?.voice?.channelId ||
      (clientUserId ? guild.voiceStates.cache.get(clientUserId)?.channelId : null) ||
      getVoiceConnection(guild.id)?.joinConfig?.channelId ||
      session.voiceChannelId;

    if (!botVoiceChannelId) {
      return;
    }

    if (oldState.channelId !== botVoiceChannelId && newState.channelId !== botVoiceChannelId) {
      return;
    }

    const botVoiceChannel = guild.channels.cache.get(botVoiceChannelId);
    await session.updateEmptyChannelState(botVoiceChannel);
  }
}

module.exports = {
  MusicManager,
};
