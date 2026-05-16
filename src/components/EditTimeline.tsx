type Action =
  | { type: "trim_start"; seconds: number }
  | { type: "trim_end"; seconds: number }
  | { type: "cut_range"; start: number; end: number }
  | { type: "add_text"; text: string; position: "top" | "center" | "bottom"; start: number; end: number | "video_end" };

type Props = {
  actions: Action[];
  duration: number;
};

const fmt = (s: number) => {
  if (!isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

export function EditTimeline({ actions, duration }: Props) {
  if (!duration) return null;

  let trimStart = 0;
  let trimEnd = 0;
  const cuts: { start: number; end: number }[] = [];
  const texts: { text: string; position: string; start: number; end: number | "video_end" }[] = [];

  for (const a of actions) {
    if (a.type === "trim_start") trimStart = Math.max(trimStart, a.seconds);
    else if (a.type === "trim_end") trimEnd = Math.max(trimEnd, a.seconds);
    else if (a.type === "cut_range") cuts.push({ start: a.start, end: a.end });
    else if (a.type === "add_text") texts.push(a);
  }

  const cutDuration = cuts.reduce((acc, c) => acc + Math.max(0, c.end - c.start), 0);
  const finalDuration = Math.max(0, duration - trimStart - trimEnd - cutDuration);
  const delta = finalDuration - duration;

  const pct = (s: number) => `${Math.min(100, Math.max(0, (s / duration) * 100))}%`;

  const summary: string[] = [];
  if (trimStart > 0) summary.push(`Trimmed first ${trimStart.toFixed(1)}s`);
  if (trimEnd > 0) summary.push(`Trimmed last ${trimEnd.toFixed(1)}s`);
  for (const c of cuts) summary.push(`Cut ${fmt(c.start)}–${fmt(c.end)} (${(c.end - c.start).toFixed(1)}s)`);
  for (const t of texts) {
    const end = t.end === "video_end" ? "end" : fmt(t.end);
    summary.push(`Text "${t.text}" (${t.position}) ${fmt(t.start)}–${end}`);
  }

  return (
    <section className="space-y-3 rounded-lg border border-black/15 bg-white/60 p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Changes</h2>
        <div className="text-sm">
          <span className="opacity-70">Duration: </span>
          <span className="font-mono">{fmt(duration)}</span>
          <span className="mx-2 opacity-50">→</span>
          <span className="font-mono font-semibold">{fmt(finalDuration)}</span>
          <span className={`ml-2 font-mono ${delta < 0 ? "text-green-700" : "opacity-60"}`}>
            {delta <= 0 ? "" : "+"}
            {delta.toFixed(1)}s
          </span>
        </div>
      </header>

      {/* Timeline strip */}
      <div className="relative h-10 w-full overflow-hidden rounded-md bg-green-200">
        {/* trim start */}
        {trimStart > 0 && (
          <div
            className="absolute top-0 h-full bg-red-300/80"
            style={{ left: 0, width: pct(trimStart), backgroundImage: "repeating-linear-gradient(45deg,transparent,transparent 4px,rgba(0,0,0,.15) 4px,rgba(0,0,0,.15) 8px)" }}
            title={`Trim start ${trimStart.toFixed(1)}s`}
          />
        )}
        {/* trim end */}
        {trimEnd > 0 && (
          <div
            className="absolute top-0 h-full bg-red-300/80"
            style={{ right: 0, width: pct(trimEnd), backgroundImage: "repeating-linear-gradient(45deg,transparent,transparent 4px,rgba(0,0,0,.15) 4px,rgba(0,0,0,.15) 8px)" }}
            title={`Trim end ${trimEnd.toFixed(1)}s`}
          />
        )}
        {/* cuts */}
        {cuts.map((c, i) => (
          <div
            key={i}
            className="absolute top-0 h-full bg-red-400/80"
            style={{ left: pct(c.start), width: pct(c.end - c.start), backgroundImage: "repeating-linear-gradient(45deg,transparent,transparent 4px,rgba(0,0,0,.2) 4px,rgba(0,0,0,.2) 8px)" }}
            title={`Cut ${fmt(c.start)}–${fmt(c.end)}`}
          />
        ))}
        {/* text overlays as blue markers on top */}
        {texts.map((t, i) => {
          const end = t.end === "video_end" ? duration : t.end;
          return (
            <div
              key={`t${i}`}
              className="absolute top-0 h-2 bg-blue-500"
              style={{ left: pct(t.start), width: pct(Math.max(0.5, end - t.start)) }}
              title={`"${t.text}" ${fmt(t.start)}–${t.end === "video_end" ? "end" : fmt(end)}`}
            />
          );
        })}
      </div>

      {/* legend */}
      <div className="flex flex-wrap gap-4 text-xs opacity-80">
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm bg-green-200" />Kept</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm bg-red-400/80" />Trimmed / cut</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm bg-blue-500" />Text overlay</span>
      </div>

      {/* readable summary */}
      {summary.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {summary.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      ) : (
        <p className="text-sm opacity-70">No edits applied yet.</p>
      )}
    </section>
  );
}
