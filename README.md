# WordBox Studio — Groq Hosted Whisper

This is the website version of WordBox Studio. Transcription runs through Groq's hosted Whisper API. Visitors do not download the Whisper model; audio is sent to a Netlify Function, which keeps the API key out of the browser code.

## Deploy on Netlify

1. Extract this ZIP.
2. Deploy the `wordbox-studio-updated` folder using a Git-connected Netlify site or Netlify's manual folder deploy. The folder root must contain `index.html`, `netlify.toml`, `css/`, `js/`, `vendor/` (self-hosted MP4 encoder, ~31 MB) and `netlify/functions/transcribe.mjs`.
3. In Netlify, open **Site configuration → Environment variables** and add:
   - Name: `TRANSCRIPTION_API_KEY`
   - Value: your Groq API key
4. Save, then trigger a fresh deployment.
5. Open the production URL and test a small audio/video file.

## Transcription behavior

- Provider: Groq hosted audio transcription API.
- Model: `whisper-large-v3-turbo`.
- Word-level timestamps are requested for caption synchronization.
- The API key is only read by the Netlify Function and is never placed in frontend JavaScript.
- Large files supported: the browser extracts the audio track, converts it to 16 kHz mono WAV, splits it into ~90 s chunks (each ~3 MB, under the Netlify request limit), transcribes each chunk, and stitches the timestamps back together. Video files up to ~400 MB work on most devices; the video itself is never uploaded.
- The service requires a valid Groq API key and is subject to the provider's current rate limits and policies. Usage may not be unlimited or free forever.

## Troubleshooting

- **Transcription is not configured**: add `TRANSCRIPTION_API_KEY` to Netlify environment variables and redeploy.
- **401/403**: verify the key in Netlify; do not put it in the website code.
- **429**: the provider rate limit or quota may have been reached; wait and check your provider dashboard.
- **Could not read audio**: use MP4 (H.264/AAC), MOV, WebM, MP3, M4A or WAV.

## Saving and reopening a project

**Export → Project file → Save project to my PC** writes a single `.wordbox` file containing the captions, every style and animation setting, the project size, the playhead position and — while *Include the video / audio file* is ticked — the media itself. **Open project…** (or dropping the `.wordbox` file on the stage) restores the whole project, media included, so nothing has to be re-imported or re-styled.

Untick *Include the video / audio file* for a small settings-only file (a few KB) to pair with the original media by hand. Project files saved by earlier versions (`.json`) still open.

## Project size for audio

Importing an audio file — or choosing **Audio only** — opens a project-size dialog first: 1080×1920, 1920×1080, 1080×1080, 1080×1350, 720×1280, 1440×1080, or any custom width × height up to 4096. The chosen size becomes the canvas captions are rendered and exported on, and it can be changed later in **Style → Stage &amp; background → Size**.

## Spelling — US / UK

**Edit → Spelling** checks every caption against American or British spelling and lists what it would change (colour → color, realise → realize, centre → center, travelled → traveled, …) before touching anything. **Apply changes** rewrites the captions; **Undo** puts them back. *Fix new captions automatically* runs the same pass right after a transcription or a subtitle import.

The pass runs entirely in the browser — no network, no API key. It is deliberately one-directional where English is ambiguous: `licence` becomes `license` for US English, but `license` is left alone going the other way, because British English keeps it as the verb. The same care applies to `meter` / `metre`, `program` / `programme`, `story` / `storey` and `check` / `cheque`. Word case, punctuation and `*emphasis*` markers are preserved, and hyphenated compounds are converted piece by piece. The optional tidy pass collapses double spaces, removes a space before punctuation and capitalises a lone “i”. The word lists live in `js/spelling.js`.

## Changelog

- **New: padding per side.** *Style → Box shape* now has **Pad top / bottom / left / right** instead of one X and one Y slider, with *Link opposite sides* to move them in pairs and a Reset. Padding stays a share of the font size, so it scales with the caption. **Box height** adds a second way to solve the same problem: *Fit the words* measures the letters actually on screen, so an ALL-CAPS line is evenly centred instead of carrying the font's unused descender space under it, while *Font metrics* keeps the old behaviour.

- **New: the shadow baked into a caption style can be switched off.** *Style → Text shadow → Keep the shadow built into the caption style*. TikTok, Rebel and Y2K paint an offset copy of the word, and Shadow, Gradient, Cinematic, Chalk and Neon paint their own glow or drop shadow. Untick the box and those disappear, leaving the caption to the Text shadow controls below (or to no shadow at all).

- **New: US / UK spelling check** for all captions, with a preview of the changes, Apply, Undo and an auto-fix switch. See *Spelling — US / UK* above.

- **New: the text shadow can sit above the caption box.** *Style → Text shadow → Layer* chooses **Above the box** (the default) or **Behind the box**. Above means the box — including an animated box sliding, popping or gliding in — is painted *behind* the shadow, while the letters stay crisp on top: the shadow is drawn on its own layer, the glyph shapes are cut back out of it, and the layer is composited over the finished caption. *Scope* limits the shadow to the spoken word, and *Box casts its own shadow too* gives the caption box a matching shadow. Every existing shadow setting (drop / long, direction, distance, opacity, blur, color, fade) applies to both layers, in the preview and in PNG and video export.

- **New: save a project to your PC and reopen it later** — a single `.wordbox` file with the captions, styling, project size and the media itself. See *Saving and reopening a project* above.

- **New: importing audio asks for the project size** before the project is created. See *Project size for audio* above.

- **Fixed: an audio-only file rendered nothing.** The preview loop skipped every frame when the source had no video track (`videoWidth` was 0), so captions never appeared for a plain MP3/M4A/WAV import. The loop now follows the stage size instead, and a file with no picture stays locked to audio mode.

- **Fixed: exported video looked zoomed-in / cropped.** `paintStage` now scales the background and video by the export scale, the same way captions already were.

- **Fixed: MP4 export stuck while exporting.** The MP4 encoder (ffmpeg.wasm) was loaded from unpkg through blob URLs, which breaks the encoder worker's relative imports, so loading hung forever. It is now self-hosted in `vendor/ffmpeg/`, with a 90 s load timeout, progress based on the encoder log (WebM recordings have no duration), a WebM fallback download if MP4 conversion fails, and export resolution capped at 1280 px on the longest side (`EXPORT_MAX_SIDE` in `js/app.js`).

- **Fixed: two word boxes flashing together for a few milliseconds.** Whisper word timestamps often overlap neighbouring words (or captions) by a few ms. The renderer now builds a clean, strictly sequential timing copy for drawing (the editable captions and SRT/VTT/JSON exports are untouched), draws only one active caption at a time, and draws only one box at a time in "word" box mode. Applies to the live preview on desktop and mobile as well as video/PNG export.

- **Fixed: mobile "maximum video size 4-5 MB" error.** Audio is now extracted in the browser and sent in small chunks instead of uploading the whole video. Added retries on rate limits/network errors, clearer error messages, and chunk cuts at quiet moments so words aren't split.
