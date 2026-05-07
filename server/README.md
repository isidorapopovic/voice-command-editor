# Voice Video Editor — Render Server

A small Node.js + Express + ffmpeg service that takes a video file and an
"edit plan" JSON (produced by the Lovable app) and returns a rendered MP4.

This is a separate, scalable service. Deploy it anywhere that supports
Node.js + ffmpeg: Railway, Render, Fly.io, Docker, a VPS, etc.

## Why a separate server?

The Lovable web app runs on a serverless Worker that can't execute the
native `ffmpeg` binary. This server fills that gap.

## Endpoints

`POST /render` — multipart/form-data
  - `video`: the input video file
  - `plan`: JSON string `{ "actions": [...] }`

Returns: `video/mp4` of the rendered output.

`GET /health` — returns `{ ok: true }`

## Supported actions (v1 — core)

- `{ "type": "trim_start", "seconds": number }`
- `{ "type": "trim_end", "seconds": number }`
- `{ "type": "cut_range", "start": number, "end": number }`
- `{ "type": "add_text", "text": string, "position": "top"|"center"|"bottom", "start": number, "end": number | "video_end" }`

## Run locally

```bash
cd server
npm install
# requires ffmpeg installed on the host (brew install ffmpeg / apt install ffmpeg)
npm start
# → http://localhost:8080
```

## Deploy to Railway / Render / Fly

The included `Dockerfile` installs `ffmpeg` and runs the server on port `8080`.
Most platforms detect the Dockerfile automatically.

### Railway
1. New Project → Deploy from GitHub repo (this `server/` folder)
2. Done. Railway gives you a public URL.

### Render
1. New Web Service → connect repo, root = `server/`
2. Runtime: Docker
3. Done.

### Fly.io
```bash
fly launch
fly deploy
```

## Connect from the Lovable app

Set the URL of this server in your Lovable app and POST the video + plan to
`/render`. Stream the resulting MP4 back to the user as a download.
