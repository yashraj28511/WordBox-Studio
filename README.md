# Transcriber (video -> audio in browser -> transcription)

When you click **Transcribe**:
1. The video is converted to small mono audio **in your browser** (ffmpeg.wasm).
2. The audio is split into ~8-minute chunks (~3 MB each).
3. Each chunk is sent to `/api/transcribe` (Groq Whisper) and the text is joined.

So a 926 MB video no longer hits the 400 MB limit.

## Deploy on Vercel
1. Unzip, then `npm install`
2. Push to GitHub and import the repo in Vercel (framework: Vite is auto-detected),
   or run `npx vercel` in this folder.
3. Vercel > Project > Settings > Environment Variables: add `TRANSCRIPTION_API_KEY` and set it to your Groq API key.
4. Redeploy.

## Run locally
    npm install
    cp .env.example .env.local   # put your key in it
    npx vercel dev               # serves the site AND /api/transcribe
(`npm run dev` alone serves only the page, not the API.)

## Using a different transcription service
Transcription uses Groq's `whisper-large-v3` model at `https://api.groq.com/openai/v1/audio/transcriptions`. Set `TRANSCRIPTION_API_KEY` in your deployment environment; do not expose the key in browser code.

## Files
- `src/audio-extract.js` - the video -> audio chunks feature
- `src/main.js` - UI logic and click handler
- `api/transcribe.js` - serverless proxy (keeps your API key off the browser)

## Notes
- Huge files take a few minutes to convert; speed depends on the user's computer.
- The converter (~30 MB) downloads from unpkg on first use.
- If a video has no audio track you'll get a clear error.
