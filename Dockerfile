FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
  nodejs \
  npm \
  ffmpeg \
  && pip install yt-dlp \
  && apt-get clean

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

EXPOSE 3001
CMD ["node", "server.js"]
