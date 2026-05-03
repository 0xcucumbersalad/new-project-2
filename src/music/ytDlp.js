const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function getYtDlpBinaryPath() {
  const executableName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";

  return path.join(process.cwd(), ".python_packages", "bin", executableName);
}

function getPythonPathEnv() {
  const projectPythonPackages = path.join(process.cwd(), ".python_packages");

  return [projectPythonPackages, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
}

function ensureYtDlpInstalled() {
  const ytDlpPath = getYtDlpBinaryPath();

  if (!fs.existsSync(ytDlpPath)) {
    throw new Error(
      "yt-dlp is not installed for this project. Reinstall the bot dependencies and local downloader setup."
    );
  }

  return ytDlpPath;
}

function runYtDlp(args) {
  const ytDlpPath = ensureYtDlpInstalled();

  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpPath, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONPATH: getPythonPathEnv(),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);

    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}.`));
        return;
      }

      resolve({
        stdout,
        stderr,
      });
    });
  });
}

async function searchYouTube(query, limit = 5) {
  const { stdout } = await runYtDlp([
    "--flat-playlist",
    "--dump-single-json",
    `ytsearch${limit}:${query}`,
  ]);
  const data = JSON.parse(stdout);

  if (!Array.isArray(data.entries)) {
    return [];
  }

  return data.entries.map((entry) => ({
    id: entry.id,
    url: entry.url,
    title: entry.title,
    duration: entry.duration,
    live: entry.live_status === "is_live" || entry.live_status === "post_live",
    availability: entry.availability,
    channel: entry.channel || entry.uploader || null,
  }));
}

async function getYouTubePlaylist(target) {
  const { stdout } = await runYtDlp([
    "--flat-playlist",
    "--dump-single-json",
    target,
  ]);
  const data = JSON.parse(stdout);

  return {
    id: data.id || null,
    title: data.title || null,
    playlistCount: data.playlist_count || (Array.isArray(data.entries) ? data.entries.length : 0),
    entries: Array.isArray(data.entries)
      ? data.entries.map((entry) => ({
          id: entry.id,
          url: entry.url,
          title: entry.title,
          duration: entry.duration,
          live: entry.live_status === "is_live" || entry.live_status === "post_live",
          availability: entry.availability,
          channel: entry.channel || entry.uploader || null,
        }))
      : [],
  };
}

module.exports = {
  ensureYtDlpInstalled,
  getYouTubePlaylist,
  getYtDlpBinaryPath,
  getPythonPathEnv,
  runYtDlp,
  searchYouTube,
};
