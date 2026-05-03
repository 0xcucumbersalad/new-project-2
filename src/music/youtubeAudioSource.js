const { spawn } = require("node:child_process");
const { StreamType } = require("@discordjs/voice");
const { ensureYtDlpInstalled, getPythonPathEnv } = require("./ytDlp");

function createCleanup(processHandle) {
  let cleanedUp = false;

  return () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;

    if (!processHandle.killed) {
      processHandle.kill();
    }
  };
}

async function createYouTubeAudioSource(videoId) {
  const ytDlpPath = ensureYtDlpInstalled();
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const args = [
    "-f",
    "bestaudio[acodec=opus][ext=webm]/251/250/249",
    "--no-playlist",
    "--no-progress",
    "-o",
    "-",
    url,
  ];
  const child = spawn(ytDlpPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: getPythonPathEnv(),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const cleanup = createCleanup(child);
  let stderrOutput = "";

  child.stderr.on("data", (chunk) => {
    stderrOutput = `${stderrOutput}${chunk.toString()}`.slice(-4000);
  });

  child.once("error", (error) => {
    child.stdout.destroy(error);
  });

  child.once("close", (code) => {
    if (code && code !== 0 && !child.stdout.destroyed) {
      const message = stderrOutput.trim() || `yt-dlp exited with code ${code}.`;
      child.stdout.destroy(new Error(message));
    }
  });

  child.stdout.once("close", cleanup);
  child.stdout.once("end", cleanup);
  child.stdout.once("error", cleanup);

  return {
    stream: child.stdout,
    inputType: StreamType.WebmOpus,
    cleanup,
  };
}

module.exports = {
  createYouTubeAudioSource,
};
