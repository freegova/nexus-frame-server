const express = require("express");
const cors = require("cors");
const ytdl = require("ytdl-core");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

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

  // Download video using yt-dlp
  execSync(`yt-dlp -f "worst[ext=mp4]/worst" --no-playlist -o "${videoPath}" "https://www.youtube.com/watch?v=${videoId}"`, {
    timeout: 120000
  });

  // Extract frames every 30 seconds using ffmpeg
  execSync(`ffmpeg -i "${videoPath}" -vf "fps=1/30,scale=640:360" "${framesDir}/frame_%03d.jpg"`, {
    timeout: 60000
  });

  // Read frames as base64
  const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith(".jpg")).sort();
  const frames = frameFiles.slice(0, 12).map((file, i) => ({
    timestamp: "~" + (i * 30) + "s",
    base64: fs.readFileSync(path.join(framesDir, file)).toString("base64")
  }));

  // Cleanup
  try { execSync(`rm -rf "${tmpDir}"`); } catch {}

  return frames;
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "nexus-frame-server" });
});

app.post("/frames", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

  try {
    console.log("Extracting frames for:", videoId);
    const frames = await downloadAndExtractFrames(videoId);
    
    if (frames.length === 0) {
      return res.status(404).json({ error: "No frames extracted" });
    }

    return res.json({
      frames,
      videoId,
      frameCount: frames.length,
      hasStoryboard: true
    });
  } catch (error) {
    console.error("Frame extraction error:", error.message);
    return res.status(500).json({ 
      error: "Failed to extract frames", 
      details: error.message 
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("Frame server running on port " + PORT);
});
