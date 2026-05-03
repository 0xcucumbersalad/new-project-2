# Discord Music Bot

Simple Discord music bot built with `discord.js` v14, `@discordjs/voice`, `play-dl`, and a `youtubei.js` stream bridge for YouTube playback.

## Features

- Joins the voice channel of the user who runs the command
- Plays audio from a YouTube URL, a search term, a Spotify track link, a public Spotify playlist, or a YouTube playlist
- Supports a simple queue for multiple songs
- Announces the song title when playback starts
- Handles common errors such as missing voice channel or invalid links
- Keeps track resolution separate so Spotify support can be added later

## Setup

1. Install dependencies:

```bash
npm install
```

2. Open `.env` and set your bot token:

```env
DISCORD_TOKEN=your_bot_token_here
```

3. In the Discord Developer Portal:

- Create an application and bot
- Enable `Message Content Intent`
- Invite the bot to your server with permission to:
  - View channels
  - Send messages
  - Connect
  - Speak

4. Start the bot:

```bash
npm start
```

## Commands

- `!help`
- `!join`
- `!play <YouTube URL, YouTube playlist URL, Spotify track URL, Spotify playlist URL, or search term>`
- `!queue`
- `!q` as a shortcut for `!queue`
- `!shuffle`
- `!loop`
- `!pause`
- `!resume`
- `!skip`
- `!skipto [track number]`
- `!stop`
- `!leave`
- `!p` as a shortcut for `!play`
- `!s` as a shortcut for `!skip`

## Project Structure

- `src/index.js`: bot startup and message command routing
- `src/commands/musicCommands.js`: command handlers
- `src/music/MusicManager.js`: queue, voice connection, and playback logic
- `src/music/trackResolver.js`: track resolution layer for YouTube videos, YouTube playlists, Spotify track links, and public Spotify playlists

## Notes

- Spotify albums are not supported yet
- Public Spotify playlists currently queue the first 30 tracks Spotify exposes on the public page
- regular `watch?v=...&list=...` links still play the single linked video, but YouTube Mix/radio links such as `start_radio=1` now queue the playlist
- if no non-bot users remain in the bot's voice channel, it leaves automatically after 5 minutes
- Slash commands and embeds are intentionally not included yet
