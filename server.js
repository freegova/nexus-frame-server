const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const cookiesPath = "/tmp/yt-cookies.txt";
if (process.env.YOUTUBE_COOKIES_B64) {
  const decoded = Buffer.from(process.env.YOUTUBE_COOKIES_B64, "base64").toString("utf8");
  fs.writeFileSync(cookiesPath, decoded);
  console.log("YouTube cookies decoded and loaded");
}

function extractVideoId(url) {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function timeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parseInt(timeStr) || 0;
}

function selectEvenlySpaced(arr, count) {
  if (arr.length <= count) return arr;
  const result = [];
  const step = (arr.length - 1) / (count - 1);
  for (let i = 0; i < count; i++) {
    result.push(arr[Math.round(i * step)]);
  }
  return result;
}

async function downloadVideo(videoId) {
  const tmpDir = "/tmp/" + videoId;
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const videoPath = tmpDir + "/video.mp4";
  if (!fs.existsSync(videoPath)) {
    const cookieFlag = fs.existsSync(cookiesPath) ? "--cookies " + cookiesPath : "";
    execSync("yt-dlp -f \"worst[ext=mp4]/worst\" --no-playlist --remote-components ejs:github " + cookieFlag + " -o \"" + videoPath + "\" \"https://www.youtube.com/watch?v=" + videoId + "\"", { timeout: 300000 });
  }
  return videoPath;
}

async function detectFightStart(videoId) {
  const tmpDir = "/tmp/" + videoId;
  const videoPath = await downloadVideo(videoId);
  const detectDir = tmpDir + "/detect";
  if (!fs.existsSync(detectDir)) fs.mkdirSync(detectDir);
  execSync("ffmpeg -i \"" + videoPath + "\" -vf \"fps=1/15,scale=320:180\" -frames:v 12 \"" + detectDir + "/frame_%03d.jpg\"", { timeout: 60000 });
  const frames = fs.readdirSync(detectDir).filter(f => f.endsWith(".jpg")).sort().slice(0, 6);
  const frameData = frames.map((file, i) => ({
    timestamp: (i * 15) + "s",
    base64: fs.readFileSync(path.join(detectDir, file)).toString("base64")
  }));
  return frameData;
}

async function extractFramesFromTime(videoId, startSeconds) {
  const tmpDir = "/tmp/" + videoId;
  const videoPath = await downloadVideo(videoId);
  const framesDir = tmpDir + "/frames_" + startSeconds;
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);
  const seekFlag = startSeconds > 0 ? "-ss " + startSeconds : "";
  execSync("ffmpeg -i \"" + videoPath + "\" " + seekFlag + " -vf \"fps=1/10,scale=640:360\" \"" + framesDir + "/frame_%04d.jpg\"", { timeout: 180000 });
  const allFrameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith(".jpg")).sort();
  console.log("Total frames extracted:", allFrameFiles.length);
  const selectedFiles = selectEvenlySpaced(allFrameFiles, 20);
  return selectedFiles.map((file) => {
    const frameIndex = allFrameFiles.indexOf(file);
    const timeSeconds = startSeconds + (frameIndex * 10);
    const minutes = Math.floor(timeSeconds / 60);
    const seconds = timeSeconds % 60;
    return {
      timestamp: minutes + ":" + String(seconds).padStart(2, "0"),
      base64: fs.readFileSync(path.join(framesDir, file)).toString("base64")
    };
  });
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "nexus-frame-server", hasCookies: fs.existsSync(cookiesPath) });
});

app.post("/detect-start", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });
  try {
    console.log("Detecting fight start for:", videoId);
    const frames = await detectFightStart(videoId);
    return res.json({ frames, videoId });
  } catch (error) {
    console.error("Detect start error:", error.message);
    return res.status(500).json({ error: "Failed to detect start", details: error.message });
  }
});

app.post("/frames", async (req, res) => {
  const { url, startTime } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });
  try {
    const startSeconds = timeToSeconds(startTime);
    console.log("Extracting frames for:", videoId, "from:", startSeconds + "s");
    const frames = await extractFramesFromTime(videoId, startSeconds);
    if (frames.length === 0) return res.status(404).json({ error: "No frames extracted" });
    return res.json({ frames, videoId, frameCount: frames.length, detectedStart: startTime || "0:00" });
  } catch (error) {
    console.error("Frame extraction error:", error.message);
    return res.status(500).json({ error: "Failed to extract frames", details: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => { console.log("Frame server running on port " + PORT); });
