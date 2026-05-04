# syntax=docker/dockerfile:1.6

# ---------- Builder ----------
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Build tools for native node modules (@discordjs/opus) + python/pip for yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        make \
        g++ \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# Install node deps (compiles @discordjs/opus native bindings)
RUN npm install --omit=dev

# Install yt-dlp into project-local .python_packages (matches src/music/ytDlp.js layout)
RUN pip3 install --break-system-packages --target=/app/.python_packages yt-dlp \
    && test -x /app/.python_packages/bin/yt-dlp \
    && PYTHONPATH=/app/.python_packages /app/.python_packages/bin/yt-dlp --version

# ---------- Runtime ----------
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

# ffmpeg for audio transcoding, python3 to execute the yt-dlp launcher, tini for clean signal handling
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/*

# Copy installed deps from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.python_packages ./.python_packages

# Copy app source
COPY package*.json ./
COPY src ./src

# Drop privileges
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PYTHONPATH=/app/.python_packages

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
