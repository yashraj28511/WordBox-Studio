"""
Normark Social Video Downloader API
Deploy on Render with:
  Build command: pip install -r requirements.txt
  Start command: uvicorn app:app --host 0.0.0.0 --port $PORT

Only download videos you own or have permission to save.
"""
import os
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlparse

import yt_dlp
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, HttpUrl, field_validator

app = FastAPI(title="Normark Video Downloader API", version="1.0.0")

# Permit the deployed Normark site and local development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://normark.vercel.app",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

TEMP_DIR = Path(tempfile.gettempdir()) / "normark-video-jobs"
TEMP_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_DOMAINS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be",
    "instagram.com", "www.instagram.com", "instagr.am", "www.instagr.am",
}

BASE_YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "socket_timeout": 30,
    "retries": 2,
    "extractor_retries": 1,
}


class VideoURL(BaseModel):
    url: HttpUrl

    @field_validator("url")
    @classmethod
    def validate_supported_url(cls, value: HttpUrl):
        host = (value.host or "").lower().rstrip(".")
        if host not in ALLOWED_DOMAINS:
            raise ValueError("Only YouTube and Instagram URLs are currently supported.")
        if value.scheme not in ("http", "https"):
            raise ValueError("URL must use HTTP or HTTPS.")
        return value


def clean_filename(value: str) -> str:
    name = re.sub(r"[^\w\-. ]", "_", value or "video", flags=re.UNICODE)
    name = name.strip(" ._")[:80]
    return name or "video"


def cleanup_dir(directory: str):
    shutil.rmtree(directory, ignore_errors=True)


def delete_file(path: str):
    try:
        os.remove(path)
    except OSError:
        pass


@app.get("/")
async def root():
    return {
        "service": "Normark Video Downloader API",
        "ok": True,
        "endpoints": ["/health", "/api/info", "/api/download", "/docs"],
    }


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/api/info")
async def get_video_info(payload: VideoURL):
    """Return title, duration, thumbnail and available MP4 format choices."""
    try:
        with yt_dlp.YoutubeDL({**BASE_YDL_OPTS, "skip_download": True}) as ydl:
            info = ydl.extract_info(str(payload.url), download=False)
    except yt_dlp.utils.DownloadError as exc:
        raise HTTPException(status_code=400, detail=f"Could not read this video: {str(exc)[:400]}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Video service error: {str(exc)[:300]}")

    formats = []
    seen = set()
    for item in info.get("formats") or []:
        # Keep MP4 video formats. yt-dlp may combine separate video/audio tracks on download.
        if item.get("ext") != "mp4" or not item.get("format_id"):
            continue
        fmt_id = str(item["format_id"])
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", fmt_id):
            continue
        resolution = item.get("resolution") or (
            f'{item.get("height")}p' if item.get("height") else "MP4"
        )
        key = (fmt_id, resolution)
        if key in seen:
            continue
        seen.add(key)
        formats.append({
            "format_id": fmt_id,
            "ext": "mp4",
            "resolution": resolution,
            "filesize": item.get("filesize") or item.get("filesize_approx"),
        })

    formats.sort(
        key=lambda item: (
            int(re.search(r"(\d+)", str(item["resolution"])).group(1))
            if re.search(r"(\d+)", str(item["resolution"])) else 0
        ),
        reverse=True,
    )

    return {
        "title": info.get("title") or "Video",
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "formats": formats[:20],
        "has_best": True,
    }


@app.post("/api/download")
async def download_video(
    payload: VideoURL,
    background: BackgroundTasks,
    format_id: str = "best",
):
    """Download the requested MP4 and stream it back to the browser."""
    if format_id != "best" and not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", format_id):
        raise HTTPException(status_code=400, detail="Invalid format selection.")

    job_dir = TEMP_DIR / uuid.uuid4().hex
    job_dir.mkdir(parents=True, exist_ok=True)
    outtmpl = str(job_dir / "%(title).80s-%(id)s.%(ext)s")

    if format_id == "best":
        fmt = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
    else:
        fmt = f"{format_id}+bestaudio[ext=m4a]/{format_id}/best[ext=mp4]/best"

    options = {
        **BASE_YDL_OPTS,
        "format": fmt,
        "outtmpl": outtmpl,
        "merge_output_format": "mp4",
        "noplaylist": True,
    }

    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(str(payload.url), download=True)
            prepared = ydl.prepare_filename(info)
            candidates = list(job_dir.glob("*.mp4"))
            if prepared and os.path.isfile(prepared):
                filepath = prepared
            elif candidates:
                filepath = str(candidates[0])
            else:
                # Some downloads have a pre-merge filename extension.
                files = [p for p in job_dir.iterdir() if p.is_file()]
                if len(files) == 1:
                    filepath = str(files[0])
                else:
                    raise HTTPException(
                        status_code=500,
                        detail="No output file was produced. The selected format may require FFmpeg.",
                    )
    except yt_dlp.utils.DownloadError as exc:
        cleanup_dir(str(job_dir))
        raise HTTPException(
            status_code=400,
            detail=f"Download failed: {str(exc)[:500]}",
        )
    except HTTPException:
        cleanup_dir(str(job_dir))
        raise
    except Exception as exc:
        cleanup_dir(str(job_dir))
        raise HTTPException(status_code=500, detail=f"Download error: {str(exc)[:300]}")

    download_name = clean_filename(info.get("title", "video")) + Path(filepath).suffix
    background.add_task(delete_file, filepath)
    background.add_task(cleanup_dir, str(job_dir))
    return FileResponse(
        path=filepath,
        media_type="video/mp4" if filepath.lower().endswith(".mp4") else "application/octet-stream",
        filename=download_name,
        background=background,
    )
