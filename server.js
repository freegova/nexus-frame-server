const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json());

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

function selectEvenlySpaced(arr, count) {
  if (arr.length <= count) return arr;
  const result = [];
  const step = (arr.length - 1) / (count - 1);
  for (let i = 0; i < count; i++) {
    result.push(arr[Math.round(i * step)]);
  }
  return result;
}

async function downloadAndExtractFrames(videoId) {
  const tmpDir = "/tmp/" + videoId;
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const videoPath = tmpDir + "/video.mp4";
  const framesDir = tmpDir + "/frames";
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);
  const cookieFlag = fs.existsSync(cookiesPath) ? "--cookies " + cookiesPath : "";
  execSync("yt-dlp -f \"worst[ext=mp4]/worst\" --no-playlist --remote-components ejs:github " + cookieFlag + " -o \"" + videoPath + "\" \"https://www.youtube.com/watch?v=" + videoId + "\"", { timeout: 300000 });
  execSync("ffmpeg -i \"" + videoPath + "\" -vf \"fps=1/10,scale=640:360\" \"" + framesDir + "/frame_%04d.jpg\"", { timeout: 180000 });
  const allFrameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith(".jpg")).sort();
  console.log("Total frames extracted:", allFrameFiles.length);
  const selectedFiles = selectEvenlySpaced(allFrameFiles, 20);
  const frames = selectedFiles.map((file, i) => {
    const frameIndex = allFrameFiles.indexOf(file);
    const timeSeconds = frameIndex * 10;
    const minutes = Math.floor(timeSeconds / 60);
    const seconds = timeSeconds % 60;
    const timestamp = minutes + ":" + String(seconds).padStart(2, "0");
    return {
      timestamp: timestamp,
      base64: fs.readFileSync(path.join(framesDir, file)).toString("base64")
    };
  });
  try { execSync("rm -rf \"" + tmpDir + "\""); } catch {}
  return frames;
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "nexus-frame-server", hasCookies: fs.existsSync(cookiesPath) });
});

app.post("/frames", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });
  try {
    console.log("Extracting frames for:", videoId);
    const frames = await downloadAndExtractFrames(videoId);
    if (frames.length === 0) return res.status(404).json({ error: "No frames extracted" });
    return res.json({ frames, videoId, frameCount: frames.length, hasStoryboard: true });
  } catch (error) {
    console.error("Frame extraction error:", error.message);
    return res.status(500).json({ error: "Failed to extract frames", details: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => { console.log("Frame server running on port " + PORT); });
