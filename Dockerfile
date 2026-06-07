FROM node:22-bookworm

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    aria2 \
    ca-certificates \
    curl \
    ffmpeg \
    python3 \
    python3-pip \
    unzip \
    wget \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --break-system-packages --no-cache-dir \
  gallery-dl \
  streamlink \
  you-get \
  yt-dlp

RUN curl -L "https://github.com/nilaoda/N_m3u8DL-RE/releases/download/v0.5.1-beta/N_m3u8DL-RE_v0.5.1-beta_linux-x64_20251029.tar.gz" \
  -o /tmp/n_m3u8dl_re.tar.gz \
  && mkdir -p /tmp/n_m3u8dl_re \
  && tar -xzf /tmp/n_m3u8dl_re.tar.gz -C /tmp/n_m3u8dl_re \
  && find /tmp/n_m3u8dl_re -type f -name "N_m3u8DL-RE" -exec install -m 755 {} /usr/local/bin/N_m3u8DL-RE \; \
  && rm -rf /tmp/n_m3u8dl_re /tmp/n_m3u8dl_re.tar.gz

COPY package*.json ./
RUN npm ci

RUN npx playwright install --with-deps chromium

COPY . .

ENV NODE_ENV=production
ENV PORT=5177
EXPOSE 5177

CMD ["npm", "start"]
