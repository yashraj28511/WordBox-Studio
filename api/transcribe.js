
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const key = process.env.TRANSCRIPTION_API_KEY;

  if (!key) {
    return res.status(500).json({
      error: "TRANSCRIPTION_API_KEY is not set on the server."
    });
  }

  try {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const audio = Buffer.concat(chunks);

    if (!audio.length) {
      return res.status(400).json({ error: "Empty audio body." });
    }

    const url = new URL(req.url, "http://localhost");
    const rawName = url.searchParams.get("name") || "audio.m4a";
    const name = rawName.split(/[\\/]/).pop().replace(/[^\w.-]/g, "_");
    const ext = name.split(".").pop().toLowerCase();

    const mimeTypes = {
      mp3: "audio/mpeg",
      mpga: "audio/mpeg",
      wav: "audio/wav",
      m4a: "audio/mp4",
      mp4: "video/mp4",
      webm: "audio/webm",
      ogg: "audio/ogg",
      flac: "audio/flac",
      mpeg: "audio/mpeg",
      mpga: "audio/mpeg"
    };

    const mime = mimeTypes[ext];

    if (!mime) {
      return res.status(400).json({
        error: `Unsupported file extension: .${ext}`
      });
    }

    const form = new FormData();

    form.append(
      "file",
      new Blob([audio], { type: mime }),
      name
    );

    form.append("model", "whisper-large-v3");
    form.append("response_format", "text");

    const lang = url.searchParams.get("lang");

    if (lang) {
      form.append("language", lang);
    }

    const response = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`
        },
        body: form
      }
    );

    const result = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: result.slice(0, 1000)
      });
    }

    return res.status(200).json({ text: result });
  } catch (error) {
    return res.status(500).json({
      error: String(error.message || error)
    });
  }
}
