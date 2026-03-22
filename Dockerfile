FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
  curl \
  nodejs \
  npm \
  ffmpeg \
  unzip \
  ca-certificates \
  && pip install -U yt-dlp \
  && apt-get clean

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

ENV PATH="/usr/local/bin:$PATH"

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3001
CMD ["node", "server.js"]
