// Voice Video Editor — Render Server
// Express + ffmpeg. POST a video + edit plan, get back a rendered MP4.
import express from "express";
import cors from "cors";
import multer from "multer";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const app = express();
app.use(cors());
const upload = multer({ limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB

app.get("/health", (_req, res) => res.json({ ok: true }));

function escapeDrawText(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function buildFilter(plan, duration) {
  // Compose: trim, cut, drawtext.
  // 1. Build kept ranges from trim_start, trim_end, cut_range.
  let start = 0;
  let end = duration;
  const cuts = [];
  const texts = [];
  for (const a of plan.actions ?? []) {
    if (a.type === "trim_start") start = Math.max(start, Number(a.seconds) || 0);
    else if (a.type === "trim_end") end = Math.min(end, duration - (Number(a.seconds) || 0));
    else if (a.type === "cut_range") cuts.push({ start: Number(a.start), end: Number(a.end) });
    else if (a.type === "add_text") texts.push(a);
  }
  cuts.sort((a, b) => a.start - b.start);
  // Compute kept segments
  const segments = [];
  let cursor = start;
  for (const c of cuts) {
    if (c.end <= cursor || c.start >= end) continue;
    if (c.start > cursor) segments.push({ start: cursor, end: Math.min(c.start, end) });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < end) segments.push({ start: cursor, end });

  // Build filter_complex
  const vParts = [];
  const aParts = [];
  segments.forEach((s, i) => {
    vParts.push(`[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`);
    aParts.push(`[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}]`);
  });
  const n = segments.length || 1;
  const concat =
    segments.length > 0
      ? `${segments.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${n}:v=1:a=1[vc][ac]`
      : `[0:v]copy[vc];[0:a]anull[ac]`;

  // drawtext on concatenated video
  let textChain = "[vc]";
  let lastLabel = "vc";
  if (texts.length) {
    texts.forEach((t, i) => {
      const newDur = segments.reduce((acc, s) => acc + (s.end - s.start), 0);
      const tEnd = t.end === "video_end" ? newDur : Number(t.end);
      const yExpr =
        t.position === "top" ? "h*0.08" : t.position === "bottom" ? "h-(text_h+h*0.08)" : "(h-text_h)/2";
      const enable = `between(t,${Number(t.start)},${tEnd})`;
      textChain += `drawtext=text='${escapeDrawText(t.text)}':fontcolor=white:fontsize=h/16:borderw=3:bordercolor=black:x=(w-text_w)/2:y=${yExpr}:enable='${enable}'`;
      const out = `vt${i}`;
      textChain += `[${out}]`;
      lastLabel = out;
      if (i < texts.length - 1) textChain += `;[${out}]`;
    });
  }

  const filter = [...vParts, ...aParts, concat, textChain].filter(Boolean).join(";");
  return { filter, vOut: lastLabel === "vc" && !texts.length ? "vc" : lastLabel, aOut: "ac" };
}

function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      if (code === 0) resolve(parseFloat(out.trim()));
      else reject(new Error("ffprobe failed"));
    });
  });
}

app.post("/render", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Missing 'video' file" });
  let plan;
  try {
    plan = JSON.parse(req.body.plan ?? "{}");
  } catch {
    return res.status(400).json({ error: "Invalid 'plan' JSON" });
  }

  const dir = await mkdtemp(path.join(tmpdir(), "vve-"));
  const inFile = path.join(dir, "in" + path.extname(req.file.originalname || ".mp4"));
  const outFile = path.join(dir, "out.mp4");
  await writeFile(inFile, req.file.buffer);

  try {
    const duration = await probeDuration(inFile);
    const { filter, vOut, aOut } = buildFilter(plan, duration);
    const args = [
      "-y",
      "-i", inFile,
      "-filter_complex", filter,
      "-map", `[${vOut}]`,
      "-map", `[${aOut}]`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-c:a", "aac",
      outFile,
    ];
    console.log("ffmpeg", args.join(" "));
    await new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", args);
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
    const data = await readFile(outFile);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="edited.mp4"');
    res.send(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Render server on :${port}`));
