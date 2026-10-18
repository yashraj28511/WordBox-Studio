import Busboy from "busboy";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MAX_BYTES = 4.5 * 1024 * 1024;

function readMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try { bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_BYTES } }); }
    catch (e) { reject(e); return; }
    const fields = {};
    let fileData = null;
    let fileName = "audio.wav";
    let fileMime = "application/octet-stream";
    let tooLarge = false;
    bb.on("field", (name, value) => { fields[name] = value; });
    bb.on("file", (name, stream, info) => {
      if (name !== "file") { stream.resume(); return; }
      fileName = info.filename || fileName;
      fileMime = info.mimeType || fileMime;
      const chunks = [];
      stream.on("limit", () => { tooLarge = true; });
      stream.on("data", chunk => chunks.push(chunk));
      stream.on("end", () => { fileData = Buffer.concat(chunks); });
    });
    bb.on("error", reject);
    bb.on("close", () => {
      if (tooLarge) return reject(Object.assign(new Error("Audio chunk is too large. Please reload and try again."), { status: 413 }));
      resolve({ fields, fileData, fileName, fileMime });
    });
    req.pipe(bb);
  });
}

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed. Use POST." }); }
  const apiKey = process.env.TRANSCRIPTION_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Transcription is not configured. Add TRANSCRIPTION_API_KEY in Vercel Project Settings → Environment Variables, then redeploy." });
  try {
    const { fields, fileData, fileName, fileMime } = await readMultipart(req);
    if (!fileData) return res.status(400).json({ error: "No audio/video file was received." });
    const form = new FormData();
    form.append("file", new Blob([fileData], { type: fileMime }), fileName);
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    if (typeof fields.language === "string" && fields.language.trim()) form.append("language", fields.language.trim());
    const upstream = await fetch(GROQ_URL, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form });
    const raw = await upstream.text();
    let data; try { data = JSON.parse(raw); } catch { data = { error: raw || "Transcription provider returned an unreadable response." }; }
    if (!upstream.ok) {
      const message = data?.error?.message || data?.error || `Groq returned HTTP ${upstream.status}`;
      return res.status(upstream.status === 429 ? 429 : 502).json({ error: typeof message === "string" ? message : JSON.stringify(message) });
    }
    return res.status(200).json(data);
  } catch (error) {
    console.error("Groq transcription error:", error);
    return res.status(error.status || 500).json({ error: error.status ? error.message : "Could not process this file. Try MP4, WebM, MP3, M4A, or WAV and retry." });
  }
}
