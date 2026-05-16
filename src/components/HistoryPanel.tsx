import { useEffect, useState } from "react";

type Session = {
  id: string | number;
  session_id?: string;
  command_index?: number;
  command?: string;
  transcript?: string;
  edit_plan?: any;
  status?: string;
  error_message?: string | null;
  input_filename?: string;
  created_at?: string;
};

type Props = {
  onApplyPlan: (plan: { actions: any[] }) => void;
};

const btn = "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-50";

export function HistoryPanel({ onApplyPlan }: Props) {
  const [url, setUrl] = useState(() => localStorage.getItem("neonBackendUrl") ?? "");
  const [path, setPath] = useState(() => localStorage.getItem("neonBackendPath") ?? "/sessions");
  const [items, setItems] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    if (!url) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(url.replace(/\/$/, "") + path);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      const arr: Session[] = Array.isArray(data) ? data : data.sessions ?? data.items ?? [];
      setItems(arr);
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (url) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveAndLoad = () => {
    localStorage.setItem("neonBackendUrl", url);
    localStorage.setItem("neonBackendPath", path);
    load();
  };

  const apply = (s: Session) => {
    let plan = s.edit_plan;
    if (typeof plan === "string") {
      try { plan = JSON.parse(plan); } catch { plan = null; }
    }
    if (!plan?.actions) {
      setErr("Selected row has no valid edit_plan.actions");
      return;
    }
    onApplyPlan(plan);
  };

  return (
    <section className="space-y-3 rounded-lg border border-black/15 bg-white/60 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">History (Neon)</h2>
        <button className={btn + " border border-black/20"} onClick={load} disabled={!url || busy}>
          {busy ? "Loading…" : "Refresh"}
        </button>
      </header>

      <div className="flex flex-wrap gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Python backend URL (e.g. https://api.example.com)"
          className="flex-1 min-w-[200px] rounded-md border border-black/30 bg-white px-2 py-1 text-xs"
        />
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/sessions"
          className="w-32 rounded-md border border-black/30 bg-white px-2 py-1 text-xs"
        />
        <button className={btn + " bg-black text-white"} onClick={saveAndLoad} disabled={!url}>
          Save & load
        </button>
      </div>

      {err && <p className="text-xs text-red-600">{err}</p>}

      {items.length === 0 ? (
        <p className="text-sm opacity-70">
          {url ? "No sessions found." : "Enter your backend URL to load past edit sessions from Neon."}
        </p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-auto text-sm">
          {items.map((s) => (
            <li
              key={String(s.id)}
              className="flex items-start justify-between gap-2 rounded-md border border-black/10 bg-white p-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className={`rounded px-1.5 py-0.5 ${s.status === "done" ? "bg-green-100 text-green-800" : s.status === "error" ? "bg-red-100 text-red-800" : "bg-gray-100"}`}>
                    {s.status ?? "—"}
                  </span>
                  {s.input_filename && <span className="opacity-70 truncate">{s.input_filename}</span>}
                  {s.created_at && <span className="opacity-50">{new Date(s.created_at).toLocaleString()}</span>}
                </div>
                {s.command && <div className="mt-1 truncate text-xs italic">"{s.command}"</div>}
              </div>
              <button className={btn + " border border-black/20 shrink-0"} onClick={() => apply(s)}>
                Apply
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
