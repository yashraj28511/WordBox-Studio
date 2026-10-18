# Normark — Creator Tools

Normark is a simple dark-theme home page that links to two tools:

- **Caption Generator** (`caption-generator.html`) — WordBox Studio, including its existing caption editor and hosted Groq transcription function.
- **AI Content Remover** (`content-remove.html`) — Nullframe interface with a server-side ExifTool endpoint.

## Deploy on Netlify

1. Upload/deploy the entire `Normark` folder (the folder containing `index.html` and `netlify.toml`).
2. In Site configuration → Environment variables, add `TRANSCRIPTION_API_KEY` with your Groq API key for Caption Generator transcription.
3. Redeploy after setting the key. Netlify installs the `exiftool-vendored` dependency from `package.json`.

## Important processing limits

The Content Remover now sends the selected file to `/.netlify/functions/nullframe` for server-side metadata cleanup. **This Netlify Function is only suitable for small files (up to 4 MB in this build)** because serverless request-body and execution limits prevent reliable processing of large videos. If you need 100 MB–1 GB videos online, deploy a dedicated backend/worker with streaming uploads and ExifTool/FFmpeg rather than Netlify Functions. The interface cannot bypass the hosting provider's limits.

Server-side processing means the file leaves the visitor's device and is uploaded to the hosting environment for processing. Do not upload confidential media unless you trust the service operator. Metadata cleanup is format-dependent and should not be treated as a guarantee that every possible provenance marker is removed.

## Project layout

- `index.html` — Normark home page
- `caption-generator.html` — Caption Generator
- `content-remove.html` — Content Remover UI
- `netlify/functions/transcribe.mjs` — Groq transcription proxy
- `netlify/functions/nullframe.mjs` — ExifTool metadata cleanup endpoint
- `css/`, `js/`, `vendor/` — WordBox Studio assets

## Notes

- The caption tool requires a valid `TRANSCRIPTION_API_KEY` environment variable.
- The caption tool's existing video export/transcription behavior is retained from the supplied WordBox Studio ZIP.
- For large media processing, the current serverless content-removal endpoint must be replaced with a dedicated backend.
