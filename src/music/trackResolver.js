const play = require("play-dl");
const { getYouTubePlaylist, searchYouTube } = require("./ytDlp");

function isSpotifyLink(query) {
  return /spotify\.com|spotify\.link|spotify:/i.test(query);
}

function looksLikeUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeYouTubeVideoUrl(value) {
  if (!looksLikeUrl(value)) {
    return value;
  }

  const url = new URL(value);
  const host = url.hostname.toLowerCase();

  if (host === "youtu.be") {
    const videoId = url.pathname.replace(/^\/+/, "").trim();

    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
  }

  if (host === "www.youtube.com" || host === "youtube.com" || host === "m.youtube.com") {
    const videoId = url.searchParams.get("v");

    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
  }

  return value;
}

function isYouTubeHost(hostname) {
  const host = hostname.toLowerCase();

  return host === "youtu.be" || host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com" || host === "music.youtube.com";
}

function isYouTubeAutoPlaylist(url, playlistId) {
  if (!playlistId) {
    return false;
  }

  const normalizedPlaylistId = playlistId.toUpperCase();

  return (
    url.searchParams.get("start_radio") === "1" ||
    normalizedPlaylistId.startsWith("RD") ||
    normalizedPlaylistId.startsWith("RDEM")
  );
}

function getYouTubePlaylistTarget(value) {
  const youtubeType = play.yt_validate(value);

  if (!looksLikeUrl(value)) {
    if (youtubeType === "playlist") {
      return `https://www.youtube.com/playlist?list=${value.trim()}`;
    }

    return null;
  }

  const url = new URL(value);

  if (!isYouTubeHost(url.hostname)) {
    return null;
  }

  const playlistId = url.searchParams.get("list");

  if (!playlistId) {
    return null;
  }

  const pathname = url.pathname.toLowerCase();

  if (pathname === "/playlist") {
    return `https://www.youtube.com/playlist?list=${playlistId}`;
  }

  if (pathname === "/watch" && !url.searchParams.get("v")) {
    return `https://www.youtube.com/playlist?list=${playlistId}`;
  }

  if (pathname === "/watch" && url.searchParams.get("v") && isYouTubeAutoPlaylist(url, playlistId)) {
    return value.trim();
  }

  return null;
}

function normalizeSpotifyUrl(value) {
  const trimmedValue = value.trim();

  if (/^spotify:/i.test(trimmedValue)) {
    const match = trimmedValue.match(/^spotify:(track|album|playlist):([A-Za-z0-9]+)$/i);

    if (match) {
      return `https://open.spotify.com/${match[1].toLowerCase()}/${match[2]}`;
    }
  }

  return trimmedValue;
}

function getSpotifyResourceType(value) {
  if (!looksLikeUrl(value)) {
    return null;
  }

  const url = new URL(value);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const spotifyPrefixIndex = pathParts[0] === "intl-us" || pathParts[0]?.startsWith("intl-") ? 1 : 0;

  return pathParts[spotifyPrefixIndex] || null;
}

function getSpotifyResourceId(value) {
  if (!looksLikeUrl(value)) {
    return null;
  }

  const url = new URL(value);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const spotifyPrefixIndex = pathParts[0] === "intl-us" || pathParts[0]?.startsWith("intl-") ? 1 : 0;

  return pathParts[spotifyPrefixIndex + 1] || null;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtmlTags(value) {
  return value.replace(/<[^>]+>/g, "");
}

function extractHtmlTitle(html) {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);

  return titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : "";
}

function parseSpotifyTrackTitle(pageTitle) {
  const normalizedTitle = decodeHtmlEntities(pageTitle).replace(/\s+\|\s+Spotify$/i, "").trim();
  const patterns = [
    /^(.*?)\s+-\s+song and lyrics by\s+(.*)$/i,
    /^(.*?)\s+-\s+song by\s+(.*)$/i,
  ];

  for (const pattern of patterns) {
    const match = normalizedTitle.match(pattern);

    if (match) {
      return {
        trackTitle: match[1].trim(),
        artistText: match[2].trim(),
      };
    }
  }

  return {
    trackTitle: normalizedTitle,
    artistText: "",
  };
}

function parseSpotifyCollectionTitle(pageTitle) {
  return decodeHtmlEntities(pageTitle)
    .replace(/\s+\|\s+Spotify\s+Playlist$/i, "")
    .replace(/\s+\|\s+Spotify\s+Album$/i, "")
    .replace(/\s+\|\s+Spotify$/i, "")
    .trim();
}

function parseSpotifyCollectionItemCount(html) {
  const descriptionMatch = html.match(/<meta\s+name="description"\s+content="[^"]*?([\d,]+)\s+items?\b/i);

  if (!descriptionMatch) {
    return null;
  }

  return Number.parseInt(descriptionMatch[1].replace(/,/g, ""), 10) || null;
}

function extractSpotifyTrackUrlsFromMeta(html) {
  return [...html.matchAll(/<meta\s+name="music:song"\s+content="([^"]+)"/gi)].map((match) => match[1]);
}

function parseSpotifyPlaylistRows(html) {
  const rowsById = new Map();
  const rowSegments = html.split('data-testid="track-row"').slice(1);

  for (const segment of rowSegments) {
    const idMatch = segment.match(/href="\/track\/([A-Za-z0-9]+)"/i);

    if (!idMatch) {
      continue;
    }

    const trackId = idMatch[1];

    if (rowsById.has(trackId)) {
      continue;
    }

    const titleMatch =
      segment.match(/data-encore-id="listRowTitle"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) ||
      segment.match(/href="\/track\/[A-Za-z0-9]+"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    const detailsMatch = segment.match(/data-encore-id="listRowDetails"[^>]*>([\s\S]*?)<\/p>/i);
    const artistMatches = detailsMatch
      ? [...detailsMatch[1].matchAll(/href="\/artist\/[^"]+"[^>]*>([^<]+)<\/a>/gi)]
      : [];
    const trackTitle = titleMatch
      ? normalizeWhitespace(stripHtmlTags(decodeHtmlEntities(titleMatch[1])))
      : "";
    const artists = artistMatches.map((match) => normalizeWhitespace(decodeHtmlEntities(match[1]))).filter(Boolean);

    if (!trackTitle) {
      continue;
    }

    rowsById.set(trackId, {
      trackTitle,
      artistText: artists.join(", "),
      url: `https://open.spotify.com/track/${trackId}`,
    });
  }

  return rowsById;
}

async function fetchSpotifyPage(url) {
  const response = await fetch(url, {
    headers: {
      "accept-language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`Spotify returned ${response.status} while resolving that link.`);
  }

  return {
    finalUrl: response.url,
    html: await response.text(),
    resourceType: getSpotifyResourceType(response.url),
  };
}

function parseSpotifyTrackPage(page) {
  if (page.resourceType !== "track") {
    throw new Error("That Spotify link type is not supported yet. Use a Spotify track link.");
  }

  const metadata = parseSpotifyTrackTitle(extractHtmlTitle(page.html));

  if (!metadata.trackTitle) {
    throw new Error("Could not extract a track title from that Spotify link.");
  }

  return metadata;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;

      if (currentIndex >= items.length) {
        return;
      }

      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return results;
}

async function resolveSearchMetadataList(searchItems) {
  const resolvedTracks = await mapWithConcurrency(searchItems, 3, async (item) => {
    try {
      return await resolveYouTubeTrack([item.trackTitle, item.artistText].filter(Boolean).join(" "));
    } catch (error) {
      return null;
    }
  });

  return resolvedTracks.filter(Boolean);
}

async function resolveSpotifyPlaylistPage(page) {
  if (page.resourceType === "album") {
    throw new Error("Spotify album links are not supported yet. Use a Spotify track or playlist link.");
  }

  if (page.resourceType !== "playlist") {
    throw new Error("That Spotify link type is not supported yet. Use a Spotify playlist link.");
  }

  const playlistTitle = parseSpotifyCollectionTitle(extractHtmlTitle(page.html)) || "Spotify playlist";
  const totalCount = parseSpotifyCollectionItemCount(page.html);
  const trackUrls = extractSpotifyTrackUrlsFromMeta(page.html);
  const playlistRows = parseSpotifyPlaylistRows(page.html);
  const searchItems = [];
  const seenTrackIds = new Set();

  for (const trackUrl of trackUrls) {
    const normalizedTrackUrl = normalizeSpotifyUrl(trackUrl);
    const trackId = getSpotifyResourceId(normalizedTrackUrl);

    if (!trackId || seenTrackIds.has(trackId)) {
      continue;
    }

    seenTrackIds.add(trackId);

    if (playlistRows.has(trackId)) {
      searchItems.push(playlistRows.get(trackId));
      continue;
    }

    try {
      const metadata = parseSpotifyTrackPage(await fetchSpotifyPage(normalizedTrackUrl));
      searchItems.push({
        ...metadata,
        url: normalizedTrackUrl,
      });
    } catch {
      // Skip tracks we cannot resolve from Spotify's public page data.
    }
  }

  if (!searchItems.length) {
    throw new Error("Could not read any playable tracks from that Spotify playlist.");
  }

  const tracks = await resolveSearchMetadataList(searchItems);

  if (!tracks.length) {
    throw new Error("I could read that Spotify playlist, but I couldn't match any of its tracks on YouTube.");
  }

  return {
    tracks,
    sourceType: "spotify-playlist",
    sourceTitle: playlistTitle,
    sourceCount: searchItems.length,
    totalCount,
    skippedCount: searchItems.length - tracks.length,
    skipReason: "I couldn't match on YouTube",
    truncated: totalCount !== null && searchItems.length < totalCount,
  };
}

async function resolveSpotifyTrackPage(page) {
  const metadata = parseSpotifyTrackPage(page);
  const track = await resolveYouTubeTrack([metadata.trackTitle, metadata.artistText].filter(Boolean).join(" "));

  return {
    tracks: [track],
    sourceType: "spotify-track",
    sourceTitle: metadata.trackTitle,
    sourceCount: 1,
    totalCount: 1,
    skippedCount: 0,
    truncated: false,
  };
}

async function resolveYouTubePlaylist(query) {
  const playlistTarget = getYouTubePlaylistTarget(query);

  if (!playlistTarget) {
    throw new Error("That is not a supported YouTube playlist link.");
  }

  const playlist = await getYouTubePlaylist(playlistTarget);
  const tracks = playlist.entries
    .filter((entry) => entry.id && entry.url && entry.title && entry.availability !== "private")
    .map((entry) => ({
      title: entry.title,
      url: entry.url,
      videoId: entry.id,
    }));

  if (!tracks.length) {
    throw new Error("That YouTube playlist did not expose any playable videos.");
  }

  return {
    tracks,
    sourceType: "youtube-playlist",
    sourceTitle: playlist.title || "YouTube playlist",
    sourceCount: tracks.length,
    totalCount: playlist.playlistCount || tracks.length,
    skippedCount: Math.max(0, (playlist.playlistCount || 0) - tracks.length),
    skipReason: "were unavailable or private",
    truncated: false,
  };
}

async function resolveRequest(query) {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    throw new Error("Provide a YouTube URL or search term.");
  }

  if (isSpotifyLink(trimmedQuery)) {
    const spotifyPage = await fetchSpotifyPage(normalizeSpotifyUrl(trimmedQuery));

    if (spotifyPage.resourceType === "playlist") {
      return resolveSpotifyPlaylistPage(spotifyPage);
    }

    if (spotifyPage.resourceType === "album") {
      throw new Error("Spotify album links are not supported yet. Use a Spotify track or playlist link.");
    }

    return resolveSpotifyTrackPage(spotifyPage);
  }

  const youtubePlaylistTarget = getYouTubePlaylistTarget(trimmedQuery);

  if (youtubePlaylistTarget) {
    return resolveYouTubePlaylist(youtubePlaylistTarget);
  }

  const track = await resolveYouTubeTrack(normalizeYouTubeVideoUrl(trimmedQuery));

  return {
    tracks: [track],
    sourceType: "direct",
    sourceTitle: track.title,
    sourceCount: 1,
    totalCount: 1,
    skippedCount: 0,
    truncated: false,
  };
}

async function resolveYouTubeTrack(query) {
  const youtubeType = play.yt_validate(query);

  if (youtubeType === "video") {
    const info = await play.video_basic_info(query);

    return {
      title: info.video_details.title,
      url: info.video_details.url,
      videoId: info.video_details.id || play.extractID(query),
    };
  }

  if (youtubeType === "playlist") {
    throw new Error("Playlist URLs are not supported yet. Use a single YouTube video.");
  }

  if (looksLikeUrl(query)) {
    throw new Error("That link is not a valid supported YouTube video URL.");
  }

  const results = await searchTrackChoices(query, 3);

  if (!results.length) {
    throw new Error("No YouTube results were found for that search.");
  }

  const selectedResult = results.find((result) => !result.live && result.videoId) || results[0];

  return {
    title: selectedResult.title,
    url: selectedResult.url,
    videoId: selectedResult.videoId,
  };
}

async function searchTrackChoices(query, limit = 3) {
  const results = await searchYouTube(query, limit);

  return results
    .filter((result) => result.id && result.title && result.availability !== "private")
    .map((result) => ({
      title: result.title,
      url: result.url,
      videoId: result.id || play.extractID(result.url),
      duration: result.duration || null,
      channel: result.channel || null,
      live: Boolean(result.live),
    }));
}

async function resolveTrack(query) {
  const resolved = await resolveRequest(query);

  return resolved.tracks[0];
}

module.exports = {
  resolveRequest,
  resolveTrack,
};
