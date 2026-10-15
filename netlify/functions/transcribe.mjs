const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MAX_BYTES = 4.5 * 1024 * 1024; // browser sends ~3 MB chunks; Netlify request cap is ~6 MB

export default async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });
  }
  const apiKey = Netlify.env.get("TRANSCRIPTION_API_KEY");
  if (!apiKey) {
    return Response.json({ error: "Transcription is not configured. Add TRANSCRIPTION_API_KEY in Netlify environment variables, then redeploy." }, { status: 500 });
  }
  try {
    const incoming = await request.formData();
    const file = incoming.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "No audio/video file was received." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return Response.json({ error: "Audio chunk is too large for the server. Please reload the page and try again." }, { status: 413 });
    }
    const form = new FormData();
    form.append("file", file, file.name || "audio.wav");
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    const language = incoming.get("language");
    if (typeof language === "string" && language.trim()) form.append("language", language.trim());

    const upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
    const raw = await upstream.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { error: raw || "Transcription provider returned an unreadable response." }; }
    if (!upstream.ok) {
      const message = data?.error?.message || data?.error || `Groq returned HTTP ${upstream.status}`;
      return Response.json({ error: typeof message === "string" ? message : JSON.stringify(message) }, { status: upstream.status === 429 ? 429 : 502 });
    }
    return Response.json(data);
  } catch (error) {
    console.error("Groq transcription error:", error);
    return Response.json({ error: "Could not process this file. Try an MP4, WebM, MP3, M4A, or WAV file and retry." }, { status: 500 });
  }
};
