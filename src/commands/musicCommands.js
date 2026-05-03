function createMusicCommands(musicManager) {
  const handlePlay = async (message, args) => {
    const query = args.join(" ").trim();

    if (!query) {
      throw new Error("Provide a YouTube URL or search term after !play.");
    }

    await musicManager.play(message, query);
  };

  return {
    help: async (message) => {
      await musicManager.help(message);
    },
    join: async (message) => {
      await musicManager.join(message);
    },
    play: handlePlay,
    p: handlePlay,
    stop: async (message) => {
      await musicManager.stop(message);
    },
    skip: async (message) => {
      await musicManager.skip(message);
    },
    s: async (message) => {
      await musicManager.skip(message);
    },
    skipto: async (message, args) => {
      const rawValue = args[0]?.trim();

      if (!rawValue) {
        await musicManager.skipTo(message);
        return;
      }

      const trackNumber = Number.parseInt(rawValue, 10);

      if (!Number.isInteger(trackNumber) || trackNumber < 1) {
        throw new Error("Use !skipto <track number>, for example !skipto 3.");
      }

      await musicManager.skipTo(message, trackNumber);
    },
    pause: async (message) => {
      await musicManager.pause(message);
    },
    resume: async (message) => {
      await musicManager.resume(message);
    },
    queue: async (message) => {
      await musicManager.queue(message);
    },
    q: async (message) => {
      await musicManager.queue(message);
    },
    shuffle: async (message) => {
      await musicManager.shuffle(message);
    },
    loop: async (message) => {
      await musicManager.loop(message);
    },
    leave: async (message) => {
      await musicManager.leave(message);
    },
  };
}

module.exports = {
  createMusicCommands,
};
