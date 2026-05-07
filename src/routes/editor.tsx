import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseVoiceCommand } from "@/server/voice.functions";

export const Route = createFileRoute("/editor")({
  head: () => ({
    meta: [
      { title: "Editor — Voice Video Editor" },
      { name: "description", content: "Upload a video and apply voice-driven edits live in your browser." },
    ],
  }),
  component: Editor,
});

type Action =
  | { type: "trim_start"; seconds: number }
  | { type: "trim_end"; seconds: number }
  | { type: "cut_range"; start: number; end: number }
  | { type: "add_text"; text: string; position: "top" | "center" | "bottom"; start: number; end: number | "video_end" };

type Plan = { actions: Action[] };

const btn = "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50";
const btnPrimary = `${btn} bg-black text-white hover:opacity-90`;
const btnGhost = `${btn} border border-black/20 text-black hover:bg-black/5`;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = r.result as string;
      resolve(s.split(",")[1] ?? "");
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function Editor() {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [plan, setPlan] = useState<Plan>({ actions: [] });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Compute trim range and cut ranges
  const { trimStart, trimEnd, cuts, texts } = useMemo(() => {
    let trimStart = 0;
    let trimEnd = 0;
    const cuts: { start: number; end: number }[] = [];
    const texts: { text: string; position: "top" | "center" | "bottom"; start: number; end: number | "video_end" }[] = [];
    for (const a of plan.actions) {
      if (a.type === "trim_start") trimStart = Math.max(trimStart, a.seconds);
      else if (a.type === "trim_end") trimEnd = Math.max(trimEnd, a.seconds);
      else if (a.type === "cut_range") cuts.push({ start: a.start, end: a.end });
      else if (a.type === "add_text") texts.push(a);
    }
    return { trimStart, trimEnd, cuts, texts };
  }, [plan]);

  // Live preview enforcement: on timeupdate, skip cuts and trim
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      const t = v.currentTime;
      if (t < trimStart) v.currentTime = trimStart;
      const cut = cuts.find((c) => t >= c.start && t < c.end);
      if (cut) v.currentTime = cut.end;
      if (duration && trimEnd && t > duration - trimEnd) {
        v.pause();
      }
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [trimStart, trimEnd, cuts, duration]);

  const [activeText, setActiveText] = useState<{ text: string; position: string } | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      const t = v.currentTime;
      const hit = texts.find((x) => {
        const end = x.end === "video_end" ? duration || Infinity : x.end;
        return t >= x.start && t <= end;
      });
      setActiveText(hit ? { text: hit.text, position: hit.position } : null);
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [texts, duration]);

  const onPickVideo = (file: File) => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(URL.createObjectURL(file));
    setPlan({ actions: [] });
    setTranscript("");
  };

  const submitText = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await parseVoiceCommand({ data: { text } });
      setTranscript(res.transcript);
      setPlan({ actions: [...plan.actions, ...res.plan.actions] });
      setText("");
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitAudio = async (blob: Blob) => {
    setBusy(true);
    setError(null);
    try {
      const audioBase64 = await blobToBase64(blob);
      const res = await parseVoiceCommand({
        data: { audioBase64, mimeType: blob.type || "audio/webm" },
      });
      setTranscript(res.transcript);
      setPlan({ actions: [...plan.actions, ...res.plan.actions] });
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        stream.getTracks().forEach((t) => t.stop());
        submitAudio(blob);
      };
      recRef.current = mr;
      mr.start();
      setRecording(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const stopRecording = () => {
    recRef.current?.stop();
    setRecording(false);
  };

  return (
    <div className="min-h-screen p-6 md:p-10" style={{ backgroundColor: "#fffef2", color: "#000" }}>
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 flex items-center justify-between">
          <h1 className="text-2xl font-bold md:text-3xl">Voice Video Editor</h1>
          <a href="/" className="text-sm underline">Home</a>
        </header>

        {!videoUrl ? (
          <label className="flex h-64 w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-black/30 transition hover:bg-black/5">
            <span className="text-lg font-semibold">Select video</span>
            <span className="mt-1 text-sm opacity-70">MP4, WebM, MOV…</span>
            <input
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onPickVideo(e.target.files[0])}
            />
          </label>
        ) : (
          <div className="space-y-6">
            <div className="relative overflow-hidden rounded-lg bg-black">
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                className="w-full"
                onLoadedMetadata={(e) => setDuration((e.target as HTMLVideoElement).duration)}
              />
              {activeText && (
                <div
                  className={`pointer-events-none absolute left-0 right-0 px-4 text-center text-2xl font-bold text-white drop-shadow-lg ${
                    activeText.position === "top"
                      ? "top-4"
                      : activeText.position === "bottom"
                      ? "bottom-16"
                      : "top-1/2 -translate-y-1/2"
                  }`}
                >
                  {activeText.text}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className={btnGhost + " cursor-pointer"}>
                Replace video
                <input
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && onPickVideo(e.target.files[0])}
                />
              </label>
              {!recording ? (
                <button className={btnPrimary} onClick={startRecording} disabled={busy}>
                  🎙 Record command
                </button>
              ) : (
                <button className={btnPrimary} onClick={stopRecording}>⏹ Stop & send</button>
              )}
              <label className={btnGhost + " cursor-pointer"}>
                Upload audio
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && submitAudio(e.target.files[0])}
                />
              </label>
              <button className={btnGhost} onClick={() => setPlan({ actions: [] })} disabled={!plan.actions.length}>
                Clear edits
              </button>
            </div>

            <div className="flex gap-2">
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder='Or type: "cut the first 5 seconds and add text Hello at the top"'
                className="flex-1 rounded-md border border-black/30 bg-white px-3 py-2 text-sm"
                onKeyDown={(e) => e.key === "Enter" && submitText()}
              />
              <button className={btnPrimary} onClick={submitText} disabled={busy || !text.trim()}>
                Apply
              </button>
            </div>

            {busy && <p className="text-sm opacity-70">Processing…</p>}
            {error && <p className="text-sm text-red-600">{error}</p>}
            {transcript && (
              <p className="text-sm">
                <span className="font-semibold">Heard:</span> {transcript}
              </p>
            )}

            <section>
              <h2 className="mb-2 text-lg font-semibold">Edit plan</h2>
              {plan.actions.length === 0 ? (
                <p className="text-sm opacity-70">No edits yet.</p>
              ) : (
                <pre className="overflow-auto rounded-md bg-black/5 p-3 text-xs">
{JSON.stringify(plan, null, 2)}
                </pre>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
