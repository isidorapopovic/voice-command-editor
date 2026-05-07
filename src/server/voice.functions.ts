import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const ActionSchema = z.object({
  actions: z.array(z.any()),
});

const SYSTEM_PROMPT = `You convert video editing voice commands into structured JSON.
Return ONLY valid JSON of the shape: { "actions": [ ... ] }
Supported action types (v1 — core only):
- { "type": "trim_start", "seconds": number }
- { "type": "trim_end", "seconds": number }
- { "type": "cut_range", "start": number, "end": number }
- { "type": "add_text", "text": string, "position": "top"|"center"|"bottom", "start": number, "end": number | "video_end" }
If the user transcript is unclear return { "actions": [] }.
Do not include explanations or markdown — JSON only.`;

export const parseVoiceCommand = createServerFn({ method: "POST" })
  .inputValidator((input: { audioBase64?: string; mimeType?: string; text?: string }) => input)
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY not set");

    let transcript = data.text?.trim() ?? "";

    // Step 1: transcribe audio if provided (Gemini supports inline audio)
    if (!transcript && data.audioBase64) {
      const tRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Transcribe this audio verbatim. Return only the transcript text, no commentary.",
                },
                {
                  type: "input_audio",
                  input_audio: {
                    data: data.audioBase64,
                    format: data.mimeType?.includes("wav") ? "wav" : "mp3",
                  },
                },
              ],
            },
          ],
        }),
      });
      if (!tRes.ok) {
        const errText = await tRes.text();
        throw new Error(`Transcription failed: ${tRes.status} ${errText}`);
      }
      const tJson = await tRes.json();
      transcript = tJson.choices?.[0]?.message?.content?.toString().trim() ?? "";
    }

    if (!transcript) {
      return { transcript: "", plan: { actions: [] } };
    }

    // Step 2: parse transcript → JSON actions
    const pRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: transcript },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!pRes.ok) {
      const errText = await pRes.text();
      throw new Error(`Parse failed: ${pRes.status} ${errText}`);
    }
    const pJson = await pRes.json();
    const raw = pJson.choices?.[0]?.message?.content ?? "{\"actions\":[]}";
    let plan: { actions: any[] };
    try {
      plan = ActionSchema.parse(JSON.parse(raw));
    } catch {
      plan = { actions: [] };
    }
    return { transcript, plan };
  });
