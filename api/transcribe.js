// Serverless function: forwards one audio chunk to Groq Whisper.
// Configure the server-side environment variable TRANSCRIPTION_API_KEY with your Groq API key.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.TRANSCRIPTION_API_KEY;
  if (!key) return res.status(500).json({ error: 'TRANSCRIPTION_API_KEY is not set on the server.' });

  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const audio = Buffer.concat(chunks);
    if (!audio.length) return res.status(400).json({ error: 'Empty audio body.' });

    const url = new URL(req.url, 'http://x');
    const name = (url.searchParams.get('name') || 'audio.m4a').replace(/[^\\w.\\-]/g, '_');
    const lang = url.searchParams.get('lang');

    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/mp4' }), name.endsWith('.m4a') ? name : name + '.m4a');
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'text');
    if (lang) form.append('language', lang);

    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: text.slice(0, 500) });
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
