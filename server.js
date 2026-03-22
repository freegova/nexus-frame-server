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
} else if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(cookiesPath, process.env.YOUTUBE_COOKIES);
  console.log("YouTube cookies loaded from environment");
}

function extractVideoId(url) {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

async function downloadAndExtractFrames(videoId) {
  const tmpDir = "/tmp/" + videoId;
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const videoPath = tmpDir + "/video.mp4";
  const framesDir = tmpDir + "/frames";
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);
  const cookieFlag = fs.existsSync(cookiesPath) ? "--cookies " + cookiesPath : "";
  execSync("yt-dlp -f \"worst[ext=mp4]/worst\" --no-playlist " + cookieFlag + " -o \"" + videoPath + "\" \"https://www.youtube.com/watch?v=" + videoId + "\"", { timeout: 180000 });
  execSync("ffmpeg -i \"" + videoPath + "\" -vf \"fps=1/30,scale=640:360\" \"" + framesDir + "/frame_%03d.jpg\"", { timeout: 60000 });
  const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith(".jpg")).sort();
  const frames = frameFiles.slice(0, 12).map((file, i) => ({
    timestamp: "~" + (i * 30) + "s into fight",
    base64: fs.readFileSync(path.join(framesDir, file)).toString("base64")
  }));
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
