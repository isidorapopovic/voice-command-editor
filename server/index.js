// Voice Video Editor — Render Server
// Express + ffmpeg. POST a video + edit plan, get back a rendered MP4.

import express from "express";
import cors from "cors";
import multer from "multer";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, copyFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const app = express();
app.use(cors());

const upload = multer({
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

const SUPPORTED_ACTIONS = new Set([
  "trim_start",
  "trim_end",
  "cut_range",
  "keep_range",
  "add_text",
  "add_image",
  "change_speed",
  "fade_in",
  "fade_out",
  "mute_range",
  "mute_all",
  "add_audio",
  "crop",
  "rotate",
  "brightness",
]);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function runCommand(command, args) {
  console.log(command, args.join(" "));

  return new Promise((resolve, reject) => {
    const child = spawn(command, args);

    let stderr = "";

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `${command} failed with code ${code}`));
      }
    });
  });
}

async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ]);

    let output = "";
    let error = "";

    child.stdout.on("data", (data) => {
      output += data.toString();
    });

    child.stderr.on("data", (data) => {
      error += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(parseFloat(output.trim()));
      } else {
        reject(new Error(error || "ffprobe failed"));
      }
    });
  });
}

async function hasAudioStream(file) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      file,
    ]);

    let output = "";

    child.stdout.on("data", (data) => {
      output += data.toString();
    });

    child.on("close", () => {
      resolve(Boolean(output.trim()));
    });
  });
}

function normaliseTime(value, duration) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    if (value === "video_end") {
      return duration;
    }

    if (value.startsWith("video_end_minus_")) {
      const seconds = Number(value.replace("video_end_minus_", ""));
      return Math.max(0, duration - seconds);
    }

    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  throw new Error(`Unsupported time value: ${value}`);
}

function escapeDrawText(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%");
}

async function runFilter(inputFile, outputFile, { videoFilter = null, audioFilter = null } = {}) {
  const hasAudio = await hasAudioStream(inputFile);

  const args = ["-y", "-i", inputFile];

  if (videoFilter) {
    args.push("-vf", videoFilter);
  }

  if (audioFilter && hasAudio) {
    args.push("-af", audioFilter);
  }

  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23");

  if (hasAudio) {
    args.push("-c:a", "aac");
  } else {
    args.push("-an");
  }

  args.push("-movflags", "+faststart", outputFile);

  await runCommand("ffmpeg", args);
}

// ─── Editing Actions ────────────────────────────────────────────────────────

async function trimStart(inputFile, outputFile, action) {
  const seconds = Number(action.seconds);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("trim_start seconds must be greater than 0.");
  }

  const hasAudio = await hasAudioStream(inputFile);

  const args = [
    "-y",
    "-ss",
    String(seconds),
    "-i",
    inputFile,
    "-c:v",
    "libx264",
  ];

  if (hasAudio) {
    args.push("-c:a", "aac");
  } else {
    args.push("-an");
  }

  args.push("-movflags", "+faststart", outputFile);

  await runCommand("ffmpeg", args);
}

async function trimEnd(inputFile, outputFile, action) {
  const seconds = Number(action.seconds);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("trim_end seconds must be greater than 0.");
  }

  const duration = await probeDuration(inputFile);
  const newDuration = duration - seconds;

  if (newDuration <= 0) {
    throw new Error("trim_end removes the whole video. Use fewer seconds.");
  }

  const hasAudio = await hasAudioStream(inputFile);

  const args = [
    "-y",
    "-i",
    inputFile,
    "-t",
    String(newDuration),
    "-c:v",
    "libx264",
  ];

  if (hasAudio) {
    args.push("-c:a", "aac");
  } else {
    args.push("-an");
  }

  args.push("-movflags", "+faststart", outputFile);

  await runCommand("ffmpeg", args);
}

async function keepRange(inputFile, outputFile, action) {
  const duration = await probeDuration(inputFile);

  const start = normaliseTime(action.start, duration);
  const end = normaliseTime(action.end, duration);

  if (start < 0) {
    throw new Error("keep_range start cannot be negative.");
  }

  if (end <= start) {
    throw new Error("keep_range end must be greater than start.");
  }

  if (start >= duration) {
    throw new Error("keep_range start is beyond the video duration.");
  }

  const finalEnd = Math.min(end, duration);
  const clipDuration = finalEnd - start;
  const hasAudio = await hasAudioStream(inputFile);

  const args = [
    "-y",
    "-ss",
    String(start),
    "-i",
    inputFile,
    "-t",
    String(clipDuration),
    "-c:v",
    "libx264",
  ];

  if (hasAudio) {
    args.push("-c:a", "aac");
  } else {
    args.push("-an");
  }

  args.push("-movflags", "+faststart", outputFile);

  await runCommand("ffmpeg", args);
}

async function cutRange(inputFile, outputFile, action, tempDir) {
  const duration = await probeDuration(inputFile);

  const start = normaliseTime(action.start, duration);
  const end = normaliseTime(action.end, duration);

  if (start < 0) {
    throw new Error("cut_range start cannot be negative.");
  }

  if (end <= start) {
    throw new Error("cut_range end must be greater than start.");
  }

  if (start >= duration) {
    throw new Error("cut_range start is beyond the video duration.");
  }

  const finalEnd = Math.min(end, duration);
  const hasAudio = await hasAudioStream(inputFile);

  const part1 = path.join(tempDir, `part1-${Date.now()}.mp4`);
  const part2 = path.join(tempDir, `part2-${Date.now()}.mp4`);
  const concatFile = path.join(tempDir, `concat-${Date.now()}.txt`);

  const parts = [];

  if (start > 0) {
    const args = [
      "-y",
      "-i",
      inputFile,
      "-t",
      String(start),
      "-c:v",
      "libx264",
    ];

    if (hasAudio) {
      args.push("-c:a", "aac");
    } else {
      args.push("-an");
    }

    args.push(part1);

    await runCommand("ffmpeg", args);
    parts.push(part1);
  }

  if (finalEnd < duration) {
    const args = [
      "-y",
      "-ss",
      String(finalEnd),
      "-i",
      inputFile,
      "-c:v",
      "libx264",
    ];

    if (hasAudio) {
      args.push("-c:a", "aac");
    } else {
      args.push("-an");
    }

    args.push(part2);

    await runCommand("ffmpeg", args);
    parts.push(part2);
  }

  if (parts.length === 0) {
    throw new Error("cut_range would remove the whole video.");
  }

  const concatText = parts
    .map((part) => `file '${part.replace(/\\/g, "/")}'`)
    .join("\n");

  await writeFile(concatFile, concatText, "utf8");

  const args = [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
    "-c:v",
    "libx264",
  ];

  if (hasAudio) {
    args.push("-c:a", "aac");
  } else {
    args.push("-an");
  }

  args.push("-movflags", "+faststart", outputFile);

  await runCommand("ffmpeg", args);
}

async function muteAll(inputFile, outputFile) {
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputFile,
    "-c:v",
    "copy",
    "-an",
    "-movflags",
    "+faststart",
    outputFile,
  ]);
}

async function muteRange(inputFile, outputFile, action) {
  const hasAudio = await hasAudioStream(inputFile);

  if (!hasAudio) {
    await copyFile(inputFile, outputFile);
    return;
  }

  const duration = await probeDuration(inputFile);

  const start = normaliseTime(action.start, duration);
  const end = normaliseTime(action.end, duration);

  if (end <= start) {
    throw new Error("mute_range end must be greater than start.");
  }

  const audioFilter = `volume=enable='between(t,${start},${end})':volume=0`;

  await runFilter(inputFile, outputFile, { audioFilter });
}

async function addText(inputFile, outputFile, action) {
  const duration = await probeDuration(inputFile);

  const text = escapeDrawText(action.text ?? "");
  const position = action.position ?? "top";
  const start = normaliseTime(action.start ?? 0, duration);
  const end = normaliseTime(action.end ?? "video_end", duration);
  const fontSize = Number(action.font_size ?? 48);
  const colour = action.color ?? "white";

  if (!text) {
    throw new Error("add_text requires text.");
  }

  if (end <= start) {
    throw new Error("add_text end must be greater than start.");
  }

  let x = "(w-text_w)/2";
  let y = "40";

  if (position === "bottom") {
    y = "h-text_h-40";
  } else if (position === "center") {
    y = "(h-text_h)/2";
  }

  const videoFilter =
    "drawtext=" +
    `text='${text}':` +
    `x=${x}:` +
    `y=${y}:` +
    `fontsize=${fontSize}:` +
    `fontcolor=${colour}:` +
    "box=1:" +
    "boxcolor=black@0.45:" +
    "boxborderw=12:" +
    `enable='between(t,${start},${end})'`;

  await runFilter(inputFile, outputFile, { videoFilter });
}

async function addImage(inputFile, outputFile, action) {
  const imagePath = path.resolve(String(action.path ?? ""));

  if (!imagePath || !(await fileExists(imagePath))) {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  const duration = await probeDuration(inputFile);

  const position = action.position ?? "center";
  const start = normaliseTime(action.start ?? 0, duration);
  const end = normaliseTime(action.end ?? "video_end", duration);
  const opacity = Math.max(0, Math.min(1, Number(action.opacity ?? 1)));

  if (end <= start) {
    throw new Error("add_image end must be greater than start.");
  }

  let overlayPosition = "(W-w)/2:(H-h)/2";

  if (position === "top-left") {
    overlayPosition = "30:30";
  } else if (position === "top-right") {
    overlayPosition = "W-w-30:30";
  } else if (position === "bottom-left") {
    overlayPosition = "30:H-h-30";
  } else if (position === "bottom-right") {
    overlayPosition = "W-w-30:H-h-30";
  }

  const hasAudio = await hasAudioStream(inputFile);

  const filterComplex =
    `[1:v]format=rgba,colorchannelmixer=aa=${opacity}[img];` +
    `[0:v][img]overlay=${overlayPosition}:enable='between(t,${start},${end})'[v]`;

  const args = [
    "-y",
    "-i",
    inputFile,
    "-i",
    imagePath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[v]",
  ];

  if (hasAudio) {
    args.push("-map", "0:a:0?", "-c:a", "aac");
  }

  args.push("-c:v", "libx264", "-movflags", "+faststart", outputFile);

  await runCommand("ffmpeg", args);
}

function buildAtempoFilter(factor) {
  const filters = [];
  let remaining = factor;

  while (remaining > 2.0) {
    filters.push("atempo=2.0");
    remaining = remaining / 2.0;
  }

  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining = remaining / 0.5;
  }

  filters.push(`atempo=${remaining}`);

  return filters.join(",");
}

async function changeSpeed(inputFile, outputFile, action) {
  const factor = Number(action.factor);

  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error("change_speed factor must be greater than 0.");
  }

  const hasAudio = await hasAudioStream(inputFile);
  const videoFilter = `setpts=PTS/${factor}`;

  if (!hasAudio) {
    await runFilter(inputFile, outputFile, { videoFilter });
    return;
  }

  const audioFilter = buildAtempoFilter(factor);

  const filterComplex = `[0:v]${videoFilter}[v];[0:a]${audioFilter}[a]`;

  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputFile,
    "-filter_complex",
    filterComplex,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputFile,
  ]);
}

async function fadeIn(inputFile, outputFile, action) {
  const duration = Number(action.duration);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("fade_in duration must be greater than 0.");
  }

  await runFilter(inputFile, outputFile, {
    videoFilter: `fade=t=in:st=0:d=${duration}`,
  });
}

async function fadeOut(inputFile, outputFile, action) {
  const fadeDuration = Number(action.duration);

  if (!Number.isFinite(fadeDuration) || fadeDuration <= 0) {
    throw new Error("fade_out duration must be greater than 0.");
  }

  const videoDuration = await probeDuration(inputFile);
  const start = Math.max(0, videoDuration - fadeDuration);

  await runFilter(inputFile, outputFile, {
    videoFilter: `fade=t=out:st=${start}:d=${fadeDuration}`,
  });
}

async function addAudio(inputFile, outputFile, action) {
  const audioPath = path.resolve(String(action.path ?? ""));

  if (!audioPath || !(await fileExists(audioPath))) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const volume = Math.max(0, Math.min(1, Number(action.volume ?? 0.8)));
  const hasAudio = await hasAudioStream(inputFile);

  if (hasAudio) {
    const filterComplex =
      `[1:a]volume=${volume}[newaudio];` +
      "[0:a][newaudio]amix=inputs=2:duration=first:dropout_transition=2[a]";

    await runCommand("ffmpeg", [
      "-y",
      "-i",
      inputFile,
      "-i",
      audioPath,
      "-filter_complex",
      filterComplex,
      "-map",
      "0:v:0",
      "-map",
      "[a]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outputFile,
    ]);
  } else {
    await runCommand("ffmpeg", [
      "-y",
      "-i",
      inputFile,
      "-i",
      audioPath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      outputFile,
    ]);
  }
}

async function cropVideo(inputFile, outputFile, action) {
  const x1 = Number(action.x1);
  const y1 = Number(action.y1);
  const x2 = Number(action.x2);
  const y2 = Number(action.y2);

  for (const value of [x1, y1, x2, y2]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error("crop values must be between 0.0 and 1.0.");
    }
  }

  if (x2 <= x1) {
    throw new Error("crop x2 must be greater than x1.");
  }

  if (y2 <= y1) {
    throw new Error("crop y2 must be greater than y1.");
  }

  const width = x2 - x1;
  const height = y2 - y1;

  await runFilter(inputFile, outputFile, {
    videoFilter: `crop=iw*${width}:ih*${height}:iw*${x1}:ih*${y1}`,
  });
}

async function rotateVideo(inputFile, outputFile, action) {
  const degrees = Number(action.degrees);
  const normalised = ((degrees % 360) + 360) % 360;

  if (!Number.isFinite(degrees)) {
    throw new Error("rotate degrees must be a number.");
  }

  if (normalised === 0) {
    await copyFile(inputFile, outputFile);
    return;
  }

  let videoFilter;

  if (normalised === 90) {
    videoFilter = "transpose=1";
  } else if (normalised === 180) {
    videoFilter = "transpose=1,transpose=1";
  } else if (normalised === 270) {
    videoFilter = "transpose=2";
  } else {
    const radians = degrees * Math.PI / 180;
    videoFilter = `rotate=${radians}:ow=rotw(${radians}):oh=roth(${radians})`;
  }

  await runFilter(inputFile, outputFile, { videoFilter });
}

async function brightness(inputFile, outputFile, action) {
  const factor = Number(action.factor);

  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error("brightness factor must be greater than 0.");
  }

  const ffmpegBrightness = Math.max(-1, Math.min(1, factor - 1));

  await runFilter(inputFile, outputFile, {
    videoFilter: `eq=brightness=${ffmpegBrightness}`,
  });
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

async function applyAction(inputFile, outputFile, action, tempDir) {
  const actionType = action?.type;

  if (!SUPPORTED_ACTIONS.has(actionType)) {
    console.log(`Skipping unsupported action: ${actionType}`);
    await copyFile(inputFile, outputFile);
    return;
  }

  console.log(`Applying action: ${actionType}`);

  if (actionType === "trim_start") {
    await trimStart(inputFile, outputFile, action);
    return;
  }

  if (actionType === "trim_end") {
    await trimEnd(inputFile, outputFile, action);
    return;
  }

  if (actionType === "cut_range") {
    await cutRange(inputFile, outputFile, action, tempDir);
    return;
  }

  if (actionType === "keep_range") {
    await keepRange(inputFile, outputFile, action);
    return;
  }

  if (actionType === "add_text") {
    await addText(inputFile, outputFile, action);
    return;
  }

  if (actionType === "add_image") {
    await addImage(inputFile, outputFile, action);
    return;
  }

  if (actionType === "change_speed") {
    await changeSpeed(inputFile, outputFile, action);
    return;
  }

  if (actionType === "fade_in") {
    await fadeIn(inputFile, outputFile, action);
    return;
  }

  if (actionType === "fade_out") {
    await fadeOut(inputFile, outputFile, action);
    return;
  }

  if (actionType === "mute_range") {
    await muteRange(inputFile, outputFile, action);
    return;
  }

  if (actionType === "mute_all") {
    await muteAll(inputFile, outputFile);
    return;
  }

  if (actionType === "add_audio") {
    await addAudio(inputFile, outputFile, action);
    return;
  }

  if (actionType === "crop") {
    await cropVideo(inputFile, outputFile, action);
    return;
  }

  if (actionType === "rotate") {
    await rotateVideo(inputFile, outputFile, action);
    return;
  }

  if (actionType === "brightness") {
    await brightness(inputFile, outputFile, action);
    return;
  }

  await copyFile(inputFile, outputFile);
}

async function applyActions(inputFile, outputFile, actions, tempDir) {
  if (!Array.isArray(actions) || actions.length === 0) {
    await copyFile(inputFile, outputFile);
    return;
  }

  let currentInput = inputFile;

  for (let i = 0; i < actions.length; i++) {
    const isLast = i === actions.length - 1;
    const currentOutput = isLast
      ? outputFile
      : path.join(tempDir, `step-${i + 1}.mp4`);

    await applyAction(currentInput, currentOutput, actions[i], tempDir);

    currentInput = currentOutput;
  }
}

// ─── Route ──────────────────────────────────────────────────────────────────

app.post("/render", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Missing 'video' file" });
  }

  let plan;

  try {
    plan = JSON.parse(req.body.plan ?? "{}");
  } catch {
    return res.status(400).json({ error: "Invalid 'plan' JSON" });
  }

  const dir = await mkdtemp(path.join(tmpdir(), "vve-"));

  const inputFile = path.join(
    dir,
    "input" + path.extname(req.file.originalname || ".mp4")
  );

  const outputFile = path.join(dir, "output.mp4");

  await writeFile(inputFile, req.file.buffer);

  try {
    const actions = plan.actions ?? [];

    await applyActions(inputFile, outputFile, actions, dir);

    const data = await readFile(outputFile);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="edited.mp4"');
    res.send(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: String(error.message || error) });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`Render server on :${port}`);
});
