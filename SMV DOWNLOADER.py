"""
Single-file YouTube / Instagram -> MP4 downloader.

Run:
    uvicorn app:app --reload --port 8000
Then open http://localhost:8000

⚠️  Only download content you own or have permission to download.
    See the Terms/DMCA notice served at /terms
"""

import os
import re
import uuid
import shutil
import tempfile
from pathlib import Path

import yt_dlp
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel, HttpUrl, field_validator

# ---------------------------------------------------------------------------
# App & temp directory
# ---------------------------------------------------------------------------
app = FastAPI(title="Video -> MP4")

TEMP_DIR = Path(tempfile.gettempdir()) / "vid2mp4"
TEMP_DIR.mkdir(parents=True, exist_ok=True)

# Only these hosts are accepted (prevents SSRF / abuse)
ALLOWED_HOSTS = re.compile(
    r"(youtube\.com|youtu\.be|instagram\.com|instagr\.am)$", re.IGNORECASE
)


def _delete_later(path: str):
    """Background task: delete the file after it has been sent."""
    try:
        os.remove(path)
    except OSError:
        pass


def _cleanup_dir(directory: str):
    try:
        shutil.rmtree(directory, ignore_errors=True)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class VideoURL(BaseModel):
    url: HttpUrl

    @field_validator("url")
    @classmethod
    def check_host(cls, v: HttpUrl):
        host = v.host or ""
        if not ALLOWED_HOSTS.search(host):
            raise ValueError("Only YouTube and Instagram URLs are supported.")
        return v


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------
BASE_YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "socket_timeout": 30,
    "retries": 3,
}


@app.post("/api/info")
async def get_video_info(payload: VideoURL):
    """Return title + available formats (no download)."""
    try:
        with yt_dlp.YoutubeDL({**BASE_YDL_OPTS, "skip_download": True}) as ydl:
            info = ydl.extract_info(str(payload.url), download=False)
    except yt_dlp.utils.DownloadError as e:
        raise HTTPException(status_code=400, detail=str(e))

    formats = []
    seen = set()
    for f in info.get("formats", []):
        # Keep muxed mp4 or video-only mp4 (we'll merge with audio automatically)
        if f.get("ext") != "mp4":
            continue
        key = (f.get("format_id"), f.get("resolution") or f.get("height"))
        if key in seen:
            continue
        seen.add(key)
        formats.append(
            {
                "format_id": f["format_id"],
                "ext": f["ext"],
                "resolution": f.get("resolution") or f"{f.get('height', '?')}p",
                "filesize": f.get("filesize") or f.get("filesize_approx"),
            }
        )

    # Sort largest first
    formats.sort(key=lambda x: (x.get("filesize") or 0), reverse=True)

    return {
        "title": info.get("title", "video"),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "formats": formats,
        "has_best": True,
    }


@app.post("/api/download")
async def download_video(
    payload: VideoURL,
    background: BackgroundTasks,
    format_id: str = "best",
):
    """
    Download the video server-side, then stream the resulting MP4 to the client.
    The file is deleted from disk as soon as the response has been sent.
    """
    job_dir = TEMP_DIR / uuid.uuid4().hex
    job_dir.mkdir(parents=True, exist_ok=True)

    outtmpl = str(job_dir / "%(title).100s-%(id)s.%(ext)s")

    # "bestvideo+bestaudio/best" + FFmpeg merge = single MP4
    if format_id in ("best", "", None):
        fmt = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
    else:
        fmt = f"{format_id}+bestaudio[ext=m4a]/{format_id}/best"

    ydl_opts = {
        **BASE_YDL_OPTS,
        "format": fmt,
        "outtmpl": outtmpl,
        "merge_output_format": "mp4",
        "postprocessors": [
            {"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"},
        ],
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(str(payload.url), download=True)
            filepath = ydl.prepare_filename(info)
            # prepare_filename may return the pre-merge path; find the real .mp4
            if not os.path.exists(filepath):
                candidates = list(job_dir.glob("*.mp4"))
                if not candidates:
                    raise HTTPException(
                        status_code=500, detail="Download produced no MP4 file."
                    )
                filepath = str(candidates[0])
    except yt_dlp.utils.DownloadError as e:
        _cleanup_dir(str(job_dir))
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        _cleanup_dir(str(job_dir))
        raise
    except Exception as e:
        _cleanup_dir(str(job_dir))
        raise HTTPException(status_code=500, detail=f"Unexpected error: {e}")

    # Sanitise the download filename for the browser
    safe_name = re.sub(r"[^\w\-. ]", "_", info.get("title", "video"))[:80] or "video"
    download_name = f"{safe_name}.mp4"

    # Delete the file once the response has been fully sent
    background.add_task(_delete_later, filepath)
    background.add_task(_cleanup_dir, str(job_dir))

    return FileResponse(
        path=filepath,
        media_type="video/mp4",
        filename=download_name,
    )


# ---------------------------------------------------------------------------
# Frontend (served inline)
# ---------------------------------------------------------------------------
INDEX_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Video → MP4</title>
<style>
  :root { --bg:#0f1115; --card:#1a1d24; --accent:#4f8cff; --text:#e8eaed; --muted:#9aa0a6; }
  * { box-sizing: border-box; }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family: system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background: radial-gradient(circle at 20% 10%, #1e2a44 0%, var(--bg) 55%);
    color: var(--text); padding: 1.5rem;
  }
  .card {
    width:100%; max-width:640px; background:var(--card);
    border-radius:16px; padding:2rem; box-shadow:0 20px 60px rgba(0,0,0,.45);
  }
  h1 { margin:0 0 .25rem; font-size:1.6rem; }
  .sub { color:var(--muted); font-size:.85rem; margin-bottom:1.5rem; }
  input {
    width:100%; padding:.85rem 1rem; border-radius:10px; border:1px solid #2c313c;
    background:#12151b; color:var(--text); font-size:.95rem; outline:none;
  }
  input:focus { border-color:var(--accent); }
  .row { display:flex; gap:.6rem; margin-top:.75rem; }
  button {
    flex:1; padding:.85rem 1rem; border:none; border-radius:10px;
    background:var(--accent); color:#fff; font-weight:600; font-size:.95rem;
    cursor:pointer; transition:.15s;
  }
  button:disabled { opacity:.5; cursor:not-allowed; }
  button.secondary { background:#2c313c; }
  .status { margin-top:1rem; font-size:.9rem; color:var(--muted); min-height:1.2em; }
  .status.error { color:#ff6b6b; }
  .thumb { margin-top:1rem; border-radius:12px; width:100%; display:none; }
  .formats { margin-top:1rem; display:flex; flex-direction:column; gap:.5rem; }
  .fmt {
    display:flex; justify-content:space-between; align-items:center;
    background:#12151b; border:1px solid #2c313c; border-radius:10px;
    padding:.6rem .9rem; font-size:.9rem;
  }
  .fmt button { flex:0 0 auto; padding:.4rem .9rem; font-size:.85rem; }
  a { color: var(--accent); }
  .legal { margin-top:1.25rem; font-size:.75rem; color:var(--muted); }
</style>
</head>
<body>
<div class="card">
  <h1>Video → MP4</h1>
  <div class="sub">Paste a YouTube or Instagram video URL</div>

  <input id="url" type="url" placeholder="https://www.youtube.com/watch?v=..." autocomplete="off"/>
  <div class="row">
    <button id="infoBtn" onclick="getInfo()">Get Info</button>
    <button class="secondary" onclick="quickDownload()">Download Best MP4</button>
  </div>

  <div class="status" id="status"></div>
  <img id="thumb" class="thumb" alt="thumbnail"/>
  <div class="formats" id="formats"></div>

  <div class="legal">
    Only download content you own or have permission to save.
    <a href="/terms" target="_blank">Terms &amp; DMCA</a>
  </div>
</div>

<script>
const $ = id => document.getElementById(id);
const statusEl = $('status');
let lastTitle = 'video';

function setStatus(msg, isError=false) {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (isError ? ' error' : '');
}

function validUrl() {
  const v = $('url').value.trim();
  if (!v) { setStatus('Please paste a URL.', true); return null; }
  return v;
}

async function getInfo() {
  const url = validUrl(); if (!url) return;
  setStatus('Fetching info…');
  $('formats').innerHTML = '';
  $('thumb').style.display = 'none';
  $('infoBtn').disabled = true;

  try {
    const r = await fetch('/api/info', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({url})
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || 'Failed');

    lastTitle = data.title || 'video';
    setStatus('Ready: ' + lastTitle);

    if (data.thumbnail) {
      $('thumb').src = data.thumbnail;
      $('thumb').style.display = 'block';
    }

    if (!data.formats.length) {
      setStatus('No MP4 formats found — use "Download Best MP4".');
      return;
    }

    data.formats.forEach(f => {
      const row = document.createElement('div');
      row.className = 'fmt';
      const label = document.createElement('span');
      label.textContent = `${f.resolution} · ${f.ext}`;
      const btn = document.createElement('button');
      btn.textContent = 'Download';
      btn.onclick = () => download(url, f.format_id);
      row.appendChild(label); row.appendChild(btn);
      $('formats').appendChild(row);
    });
  } catch (e) {
    setStatus('Error: ' + e.message, true);
  } finally {
    $('infoBtn').disabled = false;
  }
}

async function quickDownload() {
  const url = validUrl(); if (!url) return;
  download(url, 'best');
}

async function download(url, formatId) {
  setStatus('Downloading… this can take a minute for HD videos.');
  try {
    const r = await fetch(`/api/download?format_id=${encodeURIComponent(formatId)}`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({url})
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.detail || `HTTP ${r.status}`);
    }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (lastTitle || 'video').replace(/[^\\w\\-. ]/g, '_').slice(0,80) + '.mp4';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    setStatus('Download started.');
  } catch (e) {
    setStatus('Error: ' + e.message, true);
  }
}
</script>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
async def index():
    return INDEX_HTML


@app.get("/terms", response_class=HTMLResponse)
async def terms():
    return """
    <html><body style="font-family:system-ui;max-width:700px;margin:2rem auto;padding:0 1rem;line-height:1.6">
    <h1>Terms &amp; DMCA</h1>
    <p>This tool is provided for personal use to download content you own, have permission to use,
    or that is explicitly licensed for download.</p>
    <p>Users are solely responsible for ensuring their use complies with copyright law and the
    terms of service of YouTube and Instagram. Files are processed transiently on the server
    and deleted immediately after delivery.</p>
    <p>To submit a DMCA takedown, contact the site operator with the URL in question.</p>
    </body></html>
    """


@app.get("/health")
async def health():
    return {"ok": True}