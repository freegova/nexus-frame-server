const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

const cookiesPath = "/tmp/yt-cookies.txt";
if (process.env.YOUTUBE_COOKIES_B64) {
  const decoded = Buffer.from(process.env.YOUTUBE_COOKIES_B64, "base64").toString("utf8");
  fs.writeFileSync(cookiesPath, decoded);
  console.log("YouTube cookies loaded");
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
  for (let i = 0; i < count; i++) result.push(arr[Math.round(i * step)]);
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

async function extractFrames(videoId, startSeconds) {
  const tmpDir = "/tmp/" + videoId;
  const videoPath = await downloadVideo(videoId);
  const framesDir = tmpDir + "/frames_" + startSeconds;
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);
  const seekFlag = startSeconds > 0 ? "-ss " + startSeconds : "";
  execSync("ffmpeg -i \"" + videoPath + "\" " + seekFlag + " -vf \"fps=1/10,scale=640:360\" \"" + framesDir + "/frame_%04d.jpg\"", { timeout: 180000 });
  const allFiles = fs.readdirSync(framesDir).filter(f => f.endsWith(".jpg")).sort();
  console.log("Total frames:", allFiles.length);
  const selected = selectEvenlySpaced(allFiles, 20);
  return selected.map(file => {
    const idx = allFiles.indexOf(file);
    const secs = startSeconds + idx * 10;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return {
      timestamp: m + ":" + String(s).padStart(2, "0"),
      base64: fs.readFileSync(path.join(framesDir, file)).toString("base64")
    };
  });
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "nexus-frame-server", hasCookies: fs.existsSync(cookiesPath) });
});

app.post("/frames", async (req, res) => {
  const { url, startTime } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });
  try {
    const startSeconds = timeToSeconds(startTime);
    const frames = await extractFrames(videoId, startSeconds);
    if (frames.length === 0) return res.status(404).json({ error: "No frames extracted" });
    return res.json({ frames, videoId, frameCount: frames.length });
  } catch (error) {
    console.error("Frames error:", error.message);
    return res.status(500).json({ error: "Failed to extract frames", details: error.message });
  }
});

app.post("/analyze", async (req, res) => {
  const { urlA, urlB, startTimeA, startTimeB, fighterA, fighterB, sport, analysisType } = req.body;
  if (!urlA) return res.status(400).json({ error: "URL A is required" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Anthropic API key not configured" });
  try {
    const videoIdA = extractVideoId(urlA);
    const startSecsA = timeToSeconds(startTimeA);
    console.log("Extracting frames for Fighter A:", videoIdA, "from", startSecsA + "s");
    const framesA = await extractFrames(videoIdA, startSecsA);
    console.log("Got", framesA.length, "frames for Fighter A");
    let framesB = [];
    if (urlB) {
      const videoIdB = extractVideoId(urlB);
      const startSecsB = timeToSeconds(startTimeB);
      console.log("Extracting frames for Fighter B:", videoIdB, "from", startSecsB + "s");
      framesB = await extractFrames(videoIdB, startSecsB);
      console.log("Got", framesB.length, "frames for Fighter B");
    }
    const imageContent = [];
    if (framesA.length > 0) {
      imageContent.push({ type: "text", text: "FIGHT 1 - " + (fighterA?.name || "Fighter A") + " (" + (fighterA?.identifier || "") + ")  " + framesA.length + " frames from " + framesA[0].timestamp + " to " + framesA[framesA.length-1].timestamp + ":" });
      framesA.forEach(f => {
        imageContent.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.base64 } });
        imageContent.push({ type: "text", text: "[" + f.timestamp + "]" });
      });
    }
    if (framesB.length > 0) {
      imageContent.push({ type: "text", text: "FIGHT 2 - " + (fighterB?.name || "Fighter B") + " (" + (fighterB?.identifier || "") + ")  " + framesB.length + " frames from " + framesB[0].timestamp + " to " + framesB[framesB.length-1].timestamp + ":" });
      framesB.forEach(f => {
        imageContent.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.base64 } });
        imageContent.push({ type: "text", text: "[" + f.timestamp + "]" });
      });
    }
    imageContent.push({ type: "text", text: "You are an elite combat sports analyst. Analyze these " + (framesA.length + framesB.length) + " frames from actual fight footage.\n\nSport: " + (sport || "Muay Thai") + "\nFighter A: " + (fighterA?.name || "Fighter A") + " identified by: " + (fighterA?.identifier || "unknown") + "\nFighter B: " + (fighterB?.name || "Fighter B") + " identified by: " + (fighterB?.identifier || "unknown") + "\nAnalysis: " + (analysisType || "both") + "\n\nLabel each observation as [OBSERVED], [INFERRED], or [UNCERTAIN].\nNote corner/rest frames and exclude them from technical analysis.\nReturn ONLY raw JSON:\n{\"summary\":\"fight overview\",\"fighterA\":{\"style\":\"style\",\"strengths\":[\"s1\",\"s2\",\"s3\"],\"weaknesses\":[\"w1\",\"w2\",\"w3\"],\"tendencies\":[\"t1\",\"t2\",\"t3\"],\"defensiveHabits\":[\"d1\",\"d2\"],\"gamePlan\":[\"g1\",\"g2\",\"g3\"]},\"fighterB\":{\"style\":\"style\",\"strengths\":[\"s1\",\"s2\",\"s3\"],\"weaknesses\":[\"w1\",\"w2\",\"w3\"],\"tendencies\":[\"t1\",\"t2\",\"t3\"],\"defensiveHabits\":[\"d1\",\"d2\"],\"gamePlan\":[\"g1\",\"g2\",\"g3\"]},\"keyMoments\":[{\"timestamp\":\"5:30\",\"description\":\"what happened\"}],\"confidenceNote\":\"honest assessment\"}" });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 4000,
        messages: [{ role: "user", content: imageContent }]
      })
    });
    const aiData = await response.json();
    if (!response.ok) return res.status(500).json({ error: "AI analysis failed", details: aiData });
    const text = aiData.content[0].text;
    const clean = text.replace(/```json|```/g, "").trim();
    let analysis;
    try {
      analysis = JSON.parse(clean);
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) analysis = JSON.parse(match[0]);
      else return res.status(500).json({ error: "Could not parse AI response", raw: clean.slice(0, 500) });
    }
    return res.json({ analysis, frameCount: framesA.length + framesB.length });
  } catch (error) {
    console.error("Analyze error:", error.message);
    return res.status(500).json({ error: "Analysis failed", details: error.message });
  }
});

app.post("/detect-start", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });
  try {
    const tmpDir = "/tmp/" + videoId;
    const videoPath = await downloadVideo(videoId);
    const detectDir = tmpDir + "/detect";
    if (!fs.existsSync(detectDir)) fs.mkdirSync(detectDir);
    execSync("ffmpeg -i \"" + videoPath + "\" -vf \"fps=1/15,scale=320:180\" -frames:v 12 \"" + detectDir + "/frame_%03d.jpg\"", { timeout: 60000 });
    const frames = fs.readdirSync(detectDir).filter(f => f.endsWith(".jpg")).sort().slice(0, 8);
    const frameData = frames.map((file, i) => ({
      timestamp: Math.floor(i * 15 / 60) + ":" + String((i * 15) % 60).padStart(2, "0"),
      base64: fs.readFileSync(path.join(detectDir, file)).toString("base64")
    }));
    return res.json({ frames: frameData, videoId });
  } catch (error) {
    return res.status(500).json({ error: "Failed to detect start", details: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => { console.log("Frame server running on port " + PORT); });
