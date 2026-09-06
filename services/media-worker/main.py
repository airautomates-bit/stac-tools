import ipaddress
import os
import shutil
import socket
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

MAX_MB = int(os.getenv("STAC_MEDIA_MAX_MB", "750"))
origins_env = os.getenv("STAC_CORS_ORIGINS", "*")
origins = ["*"] if origins_env.strip() == "*" else [x.strip() for x in origins_env.split(",") if x.strip()]

app = FastAPI(title="STAC Media Worker", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "Content-Length"],
)

class DownloadRequest(BaseModel):
    url: str
    format: str = "video"


def validate_public_url(raw: str):
    try:
        parsed = urlparse(raw)
    except Exception as exc:
        raise HTTPException(400, "Invalid URL.") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, "Only public http/https media URLs are accepted.")
    host = parsed.hostname.lower()
    if host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".local"):
        raise HTTPException(400, "Local/private network URLs are not accepted.")
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise HTTPException(400, "Local/private network URLs are not accepted.")
    except ValueError:
        try:
            for result in socket.getaddrinfo(host, None):
                resolved = ipaddress.ip_address(result[4][0])
                if resolved.is_private or resolved.is_loopback or resolved.is_link_local or resolved.is_reserved:
                    raise HTTPException(400, "Local/private network URLs are not accepted.")
        except socket.gaierror as exc:
            raise HTTPException(400, "The hostname could not be resolved.") from exc
    return raw


def cleanup(path: str):
    shutil.rmtree(path, ignore_errors=True)


@app.get("/health")
def health():
    return {"ok": True, "worker": "media", "max_mb": MAX_MB}


@app.post("/download")
def download_media(req: DownloadRequest):
    url = validate_public_url(req.url)
    kind = req.format.lower().strip()
    if kind not in {"video", "audio", "image"}:
        raise HTTPException(400, "format must be video, audio or image.")

    workdir = tempfile.mkdtemp(prefix="stac-media-")
    outtmpl = str(Path(workdir) / "%(title).100s-%(id)s.%(ext)s")
    common = {
        "outtmpl": outtmpl,
        "restrictfilenames": True,
        "noplaylist": True,
        "max_filesize": MAX_MB * 1024 * 1024,
        "quiet": True,
        "no_warnings": True,
        "retries": 2,
        "socket_timeout": 30,
    }

    try:
        if kind == "video":
            opts = {
                **common,
                "format": "bv*+ba/b",
                "merge_output_format": "mp4",
                "postprocessors": [{"key": "FFmpegVideoConvertor", "preferedformat": "mp4"}],
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])
        elif kind == "audio":
            opts = {
                **common,
                "format": "bestaudio/best",
                "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"}],
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([url])
        else:
            # For platforms that expose a post thumbnail/cover, return the highest-resolution one.
            # Image-only social posts are extractor-dependent and may not be available on every service.
            with yt_dlp.YoutubeDL({**common, "skip_download": True}) as ydl:
                info = ydl.extract_info(url, download=False)
            thumbs = info.get("thumbnails") or []
            if not thumbs and info.get("thumbnail"):
                thumbs = [{"url": info["thumbnail"], "width": 0, "height": 0}]
            if not thumbs:
                raise HTTPException(422, "This platform did not expose an image/thumbnail for that link.")
            thumb = sorted(thumbs, key=lambda x: (x.get("width") or 0) * (x.get("height") or 0))[-1]
            thumb_url = thumb.get("url")
            if not thumb_url:
                raise HTTPException(422, "No downloadable image URL was exposed.")
            suffix = Path(urlparse(thumb_url).path).suffix.lower()
            if suffix not in {".jpg", ".jpeg", ".png", ".webp"}:
                suffix = ".jpg"
            target = Path(workdir) / f"stac-image{suffix}"
            with httpx.stream("GET", thumb_url, follow_redirects=True, timeout=45) as r:
                r.raise_for_status()
                size = 0
                with open(target, "wb") as f:
                    for chunk in r.iter_bytes():
                        size += len(chunk)
                        if size > MAX_MB * 1024 * 1024:
                            raise HTTPException(413, f"Media exceeds the {MAX_MB} MB worker limit.")
                        f.write(chunk)

        files = [p for p in Path(workdir).iterdir() if p.is_file() and not p.name.endswith((".part", ".ytdl"))]
        if not files:
            raise HTTPException(500, "The extractor finished without producing a file.")
        target = max(files, key=lambda p: p.stat().st_size)
        if target.stat().st_size > MAX_MB * 1024 * 1024:
            raise HTTPException(413, f"Media exceeds the {MAX_MB} MB worker limit.")
        media_type = "application/octet-stream"
        if target.suffix.lower() == ".mp4": media_type = "video/mp4"
        elif target.suffix.lower() == ".mp3": media_type = "audio/mpeg"
        elif target.suffix.lower() in {".jpg", ".jpeg"}: media_type = "image/jpeg"
        elif target.suffix.lower() == ".png": media_type = "image/png"
        elif target.suffix.lower() == ".webp": media_type = "image/webp"
        return FileResponse(
            path=str(target),
            filename=target.name,
            media_type=media_type,
            background=BackgroundTask(cleanup, workdir),
        )
    except HTTPException:
        cleanup(workdir)
        raise
    except yt_dlp.utils.DownloadError as exc:
        cleanup(workdir)
        raise HTTPException(422, f"This link could not be extracted. The platform may require login, block cloud IPs, or not permit downloading: {str(exc)[:180]}") from exc
    except Exception as exc:
        cleanup(workdir)
        raise HTTPException(500, f"Media worker failed: {type(exc).__name__}.") from exc
