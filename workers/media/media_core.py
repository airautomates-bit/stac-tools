"""STAC media worker: resolves and downloads media from a fixed set of platforms.

Security model
--------------
* Only links on an allowlist of platform hosts are accepted (no generic URLs,
  so the worker cannot be pointed at internal services: SSRF).
* yt-dlp is restricted to the matching extractors (the "generic" extractor is
  never used).
* Every direct media / thumbnail fetch goes through ``safe_stream`` which only
  talks HTTPS to known platform CDNs and re-checks every redirect hop.
* Per-IP rate limits, size limits and generic error messages (details are
  logged server-side, never returned to the browser).

The module is framework-only so it can be run locally with uvicorn for tests
and wrapped by ``modal_app.py`` for production.
"""


import base64
import hashlib
import logging
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from html import unescape
from pathlib import Path
from typing import Any, Callable, Protocol
from urllib.parse import urlparse, urlunparse

log = logging.getLogger("stac.media")

MAX_MB = int(os.environ.get("STAC_MEDIA_MAX_MB", "300"))
MAX_BYTES = MAX_MB * 1024 * 1024
THUMB_MAX_BYTES = 700 * 1024
MAX_ITEMS = 20
CACHE_TTL = 15 * 60
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0 Safari/537.36"
)

# --------------------------------------------------------------------------
# Allowlists
# --------------------------------------------------------------------------

PLATFORM_HOSTS: dict[str, tuple[str, ...]] = {
    "instagram": ("instagram.com", "instagr.am"),
    "facebook": ("facebook.com", "fb.watch", "fb.com"),
    "x": ("x.com", "twitter.com"),
    "threads": ("threads.com", "threads.net"),
    "pinterest": ("pin.it",),  # pinterest.<tld> handled by regex below
    "youtube": ("youtube.com", "youtu.be", "youtube-nocookie.com"),
}
PINTEREST_RE = re.compile(r"(^|\.)pinterest\.(com|ca|co\.uk|com\.au|de|fr|es|it|pt|jp|nz|ie|ch|at|se|dk|cl|com\.mx|ph|ru|kr)$")

# Only these CDNs are ever fetched directly by the worker.
CDN_SUFFIXES = (
    "cdninstagram.com",
    "fbcdn.net",
    "twimg.com",
    "pinimg.com",
    "ytimg.com",
)

YTDLP_EXTRACTORS = {
    "instagram": ["Instagram"],
    "facebook": ["facebook", "facebook:reel", "FacebookPluginsVideo"],
    "pinterest": ["Pinterest"],
    "x": ["twitter"],
    # Single videos and Shorts only (no playlists / channels).
    "youtube": ["youtube", "YoutubeYtBe"],
}

PLATFORM_LABEL = {
    "instagram": "Instagram",
    "facebook": "Facebook",
    "x": "X",
    "threads": "Threads",
    "pinterest": "Pinterest",
    "youtube": "YouTube",
}


class UserError(Exception):
    """An error whose message is safe to show to the user."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _host_matches(host: str, domains: tuple[str, ...]) -> bool:
    return any(host == d or host.endswith("." + d) for d in domains)


def detect_platform(raw: str) -> tuple[str, str]:
    """Validate a user supplied link. Returns (platform, normalised_url)."""
    raw = (raw or "").strip()
    if len(raw) > 2048:
        raise UserError("That link is too long.")
    if not re.match(r"^https?://", raw, re.I):
        raw = "https://" + raw
    try:
        p = urlparse(raw)
    except ValueError as exc:
        raise UserError("That doesn't look like a valid link.") from exc
    if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password:
        raise UserError("That doesn't look like a valid link.")
    if p.port not in (None, 80, 443):
        raise UserError("That doesn't look like a valid link.")
    host = p.hostname.lower().rstrip(".")
    for name, domains in PLATFORM_HOSTS.items():
        if _host_matches(host, domains):
            platform = name
            break
    else:
        if PINTEREST_RE.search(host):
            platform = "pinterest"
        else:
            raise UserError(
                "Paste a link from YouTube, Instagram, Pinterest, Facebook, X or Threads."
            )
    clean = urlunparse(("https", host, p.path or "/", "", p.query, ""))
    return platform, clean


def _is_cdn(url: str) -> bool:
    try:
        p = urlparse(url)
    except ValueError:
        return False
    host = (p.hostname or "").lower()
    return p.scheme == "https" and p.port in (None, 443) and _host_matches(host, CDN_SUFFIXES)


# --------------------------------------------------------------------------
# Safe HTTP
# --------------------------------------------------------------------------

def _client():
    import httpx

    return httpx.Client(
        timeout=httpx.Timeout(30.0, connect=10.0),
        headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"},
        follow_redirects=False,
    )


def safe_stream(url: str, dest: Path | None, limit: int, *, allow: Callable[[str], bool] = _is_cdn) -> tuple[bytes | None, str]:
    """GET ``url`` following at most 4 redirects, each re-validated by ``allow``.

    Writes to ``dest`` if given, otherwise returns the bytes. Returns
    (data_or_None, content_type).
    """
    with _client() as client:
        for _ in range(5):
            if not allow(url):
                raise UserError("The media is hosted somewhere this tool doesn't fetch from.", 422)
            with client.stream("GET", url) as r:
                if r.status_code in (301, 302, 303, 307, 308):
                    loc = r.headers.get("location")
                    if not loc:
                        break
                    url = str(r.url.join(loc))
                    continue
                if r.status_code != 200:
                    raise UserError("The platform refused to send this file. Try again in a moment.", 502)
                declared = int(r.headers.get("content-length") or 0)
                if declared > limit:
                    raise UserError(f"This file is larger than the {MAX_MB} MB limit.", 413)
                ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
                size = 0
                if dest is not None:
                    with open(dest, "wb") as f:
                        for chunk in r.iter_bytes(64 * 1024):
                            size += len(chunk)
                            if size > limit:
                                raise UserError(f"This file is larger than the {MAX_MB} MB limit.", 413)
                            f.write(chunk)
                    return None, ctype
                buf = bytearray()
                for chunk in r.iter_bytes(64 * 1024):
                    buf.extend(chunk)
                    if len(buf) > limit:
                        raise UserError("File too large.", 413)
                return bytes(buf), ctype
    raise UserError("Too many redirects.", 502)


def _expand_short_link(url: str, platform: str) -> str:
    """pin.it / fb.watch short links: follow redirects while staying on-platform."""
    host = (urlparse(url).hostname or "").lower()
    if host not in ("pin.it", "fb.watch"):
        return url
    with _client() as client:
        for _ in range(6):
            r = client.get(url)
            if r.status_code not in (301, 302, 303, 307, 308) or not r.headers.get("location"):
                return url
            nxt = str(r.url.join(r.headers["location"]))
            try:
                p2, nxt = detect_platform(nxt)
            except UserError:
                raise UserError("That short link points outside the platform.")
            if p2 != platform:
                raise UserError("That short link points outside the platform.")
            url = nxt
    return url


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------

def _best_thumb(entry: dict) -> dict:
    thumbs = [t for t in (entry.get("thumbnails") or []) if t.get("url")]
    if not thumbs and entry.get("thumbnail"):
        thumbs = [{"url": entry["thumbnail"]}]
    if not thumbs:
        return {}
    return max(thumbs, key=lambda t: ((t.get("width") or 0) * (t.get("height") or 0), t.get("preference") or 0))


def _ytdlp_base(platform: str) -> dict:
    return {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "socket_timeout": 30,
        "retries": 2,
        "extractor_retries": 1,
        "ignore_no_formats_error": True,
        "allowed_extractors": YTDLP_EXTRACTORS[platform],
        "restrictfilenames": True,
        "cachedir": False,
        "max_filesize": MAX_BYTES,
        "logger": _QuietLogger(),
        # YouTube links can carry &list=…; only ever take the single video.
        "noplaylist": platform == "youtube",
        # YouTube needs a JavaScript runtime to solve its player challenges.
        "js_runtimes": {"deno": {}, "node": {}},
    }


class _QuietLogger:
    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        log.debug("yt-dlp warning: %s", msg)

    def error(self, msg):
        log.info("yt-dlp error: %s", msg)


def _friendly_ytdlp_error(exc: Exception, platform: str) -> UserError:
    msg = str(exc).lower()
    label = PLATFORM_LABEL[platform]
    if any(k in msg for k in ("login", "cookies", "rate-limit", "registered users", "private")):
        return UserError(
            f"{label} wants a login to show this post. Only public posts can be downloaded "
            "(and sometimes the platform temporarily blocks cloud servers — try again later).",
            422,
        )
    if "unsupported url" in msg or "no suitable extractor" in msg:
        return UserError(f"This doesn't look like a {label} post, reel or video link.", 422)
    if "not available" in msg or "404" in msg or "removed" in msg or "deleted" in msg:
        return UserError("This post is unavailable — it may have been deleted or made private.", 422)
    return UserError(
        f"Couldn't read this {label} link. Check it opens in a private browser window, then try again.",
        422,
    )


def _resolve_ytdlp(platform: str, url: str) -> dict:
    import yt_dlp

    try:
        with yt_dlp.YoutubeDL(_ytdlp_base(platform)) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as exc:
        log.info("resolve failed %s: %s", platform, exc)
        raise _friendly_ytdlp_error(exc, platform) from exc

    is_playlist = info.get("_type") == "playlist"
    entries = list(info.get("entries") or []) if is_playlist else [info]
    items = []
    for pos, e in enumerate(entries[:MAX_ITEMS]):
        if not e:
            continue
        thumb = _best_thumb(e)
        has_video = bool(e.get("formats")) or bool(e.get("url") and e.get("vcodec") not in (None, "none"))
        if has_video:
            items.append({
                "kind": "video",
                "source": "ytdlp",
                "ytdlp_index": pos + 1 if is_playlist else None,
                "thumb_url": e.get("thumbnail") or thumb.get("url"),
                "width": e.get("width"),
                "height": e.get("height"),
                "duration": e.get("duration"),
            })
        elif platform == "youtube":
            continue
        elif thumb.get("url"):
            items.append({
                "kind": "image",
                "source": "direct",
                "url": thumb["url"],
                "thumb_url": thumb["url"],
                "width": thumb.get("width"),
                "height": thumb.get("height"),
            })
    return {
        "title": (info.get("title") or info.get("description") or "")[:140],
        "author": info.get("channel") or info.get("uploader") or info.get("uploader_id") or "",
        "id": str(info.get("id") or ""),
        "items": items,
    }


def _x_token(tweet_id: str) -> str:
    n = (int(tweet_id) / 1e15) * math.pi
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    ip, frac = int(n), n - int(n)
    s = ""
    while ip:
        s = digits[ip % 36] + s
        ip //= 36
    f = ""
    for _ in range(12):
        frac *= 36
        k = int(frac)
        f += digits[k]
        frac -= k
        if frac == 0:
            break
    return re.sub(r"(0+|\.)", "", (s or "0") + "." + f)


def _resolve_x(url: str) -> dict:
    m = re.search(r"/status(?:es)?/(\d{5,25})", urlparse(url).path)
    if not m:
        raise UserError("Paste a link to a single post (it contains /status/).")
    tweet_id = m.group(1)
    import httpx

    data = None
    try:
        with _client() as client:
            r = client.get(
                "https://cdn.syndication.twimg.com/tweet-result",
                params={"id": tweet_id, "token": _x_token(tweet_id), "lang": "en"},
            )
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("application/json"):
                data = r.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.info("x syndication failed: %s", exc)

    if not data or data.get("__typename") == "TweetTombstone":
        # Fall back to yt-dlp (videos only).
        return _resolve_ytdlp("x", f"https://x.com/i/status/{tweet_id}")

    items = []
    for md in (data.get("mediaDetails") or [])[:MAX_ITEMS]:
        mtype = md.get("type")
        base = md.get("media_url_https") or ""
        size = (md.get("original_info") or {})
        if mtype == "photo" and base:
            stem, _, ext = base.rpartition(".")
            items.append({
                "kind": "image",
                "source": "direct",
                "url": f"{stem}?format={ext or 'jpg'}&name=orig",
                "thumb_url": f"{stem}?format={ext or 'jpg'}&name=small",
                "width": size.get("width"),
                "height": size.get("height"),
            })
        elif mtype in ("video", "animated_gif"):
            variants = [
                v for v in ((md.get("video_info") or {}).get("variants") or [])
                if v.get("content_type") == "video/mp4" and v.get("url")
            ]
            if not variants:
                continue
            best = max(variants, key=lambda v: v.get("bitrate") or 0)
            items.append({
                "kind": "video",
                "source": "direct",
                "url": best["url"],
                "thumb_url": base,
                "width": size.get("width"),
                "height": size.get("height"),
                "duration": ((md.get("video_info") or {}).get("duration_millis") or 0) / 1000 or None,
            })
    user = data.get("user") or {}
    return {
        "title": (data.get("text") or "")[:140],
        "author": user.get("screen_name") or "",
        "id": tweet_id,
        "items": items,
    }


THREADS_PATH_RE = re.compile(r"^/(?:@([A-Za-z0-9._]{1,40})/post|t)/([A-Za-z0-9_-]{5,40})")


def _resolve_threads(url: str) -> dict:
    m = THREADS_PATH_RE.match(urlparse(url).path)
    if not m:
        raise UserError("Paste a link to a single Threads post (it contains /post/).")
    user, code = m.group(1) or "_", m.group(2)
    embed = f"https://www.threads.com/@{user}/post/{code}/embed"

    def allow_threads(u: str) -> bool:
        p = urlparse(u)
        return p.scheme == "https" and _host_matches((p.hostname or "").lower(), ("threads.com", "threads.net"))

    html_bytes, _ = safe_stream(embed, None, 5 * 1024 * 1024, allow=allow_threads)
    html = html_bytes.decode("utf-8", "replace")

    items: list[dict] = []
    seen: set[str] = set()

    for vm in re.finditer(r"<video\b([^>]*)>(.*?)</video>", html, re.S | re.I):
        attrs, inner = vm.group(1), vm.group(2)
        src = re.search(r'\bsrc="([^"]+)"', attrs) or re.search(r'<source\b[^>]*\bsrc="([^"]+)"', inner)
        poster = re.search(r'\bposter="([^"]+)"', attrs)
        if not src:
            continue
        vurl = unescape(src.group(1))
        if vurl in seen or not _is_cdn(vurl):
            continue
        seen.add(vurl)
        items.append({
            "kind": "video",
            "source": "direct",
            "url": vurl,
            "thumb_url": unescape(poster.group(1)) if poster else None,
        })

    posters = {i.get("thumb_url") for i in items}
    for im in re.finditer(r"<img\b([^>]*)>", html, re.I):
        attrs = im.group(1)
        src = re.search(r'\bsrc="([^"]+)"', attrs)
        if not src:
            continue
        iurl = unescape(src.group(1))
        # Skip avatars (profile pictures live under "-19/" paths) and tiny images.
        if not _is_cdn(iurl) or "-19/" in iurl or "s150x150" in iurl or iurl in seen or iurl in posters:
            continue
        seen.add(iurl)
        items.append({"kind": "image", "source": "direct", "url": iurl, "thumb_url": iurl})

    author_m = re.search(r'class="[^"]*Username[^"]*"[^>]*>\s*([^<]+)<', html)
    return {
        "title": "",
        "author": (author_m.group(1).strip() if author_m else (user if user != "_" else "")),
        "id": code,
        "items": items[:MAX_ITEMS],
    }


YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _canonical_youtube(url: str) -> str:
    """Reduce any single-video YouTube link to https://www.youtube.com/watch?v=ID."""
    from urllib.parse import parse_qs

    p = urlparse(url)
    host = (p.hostname or "").lower()
    parts = [x for x in p.path.split("/") if x]
    vid = None
    if host == "youtu.be" and parts:
        vid = parts[0]
    elif parts and parts[0] == "watch":
        vid = (parse_qs(p.query).get("v") or [None])[0]
    elif len(parts) >= 2 and parts[0] in ("shorts", "live", "embed", "v"):
        vid = parts[1]
    if not vid or not YT_ID_RE.match(vid):
        raise UserError("Paste a link to a single YouTube video or Short (playlists and channels aren't supported).")
    return f"https://www.youtube.com/watch?v={vid}"


def resolve(platform: str, url: str) -> dict:
    url = _expand_short_link(url, platform)
    if platform == "youtube":
        url = _canonical_youtube(url)
    if platform == "x":
        result = _resolve_x(url)
    elif platform == "threads":
        result = _resolve_threads(url)
    else:
        result = _resolve_ytdlp(platform, url)
    result["platform"] = platform
    result["url"] = url
    if not result["items"] and platform == "youtube":
        raise UserError(
            "This video can't be downloaded — it may be private, age-restricted, members-only or a live stream.",
            422,
        )
    if not result["items"]:
        raise UserError(
            "No photos or videos found in this post. Text-only posts can't be downloaded.",
            422,
        )
    return result


def _thumb_data_url(url: str | None) -> str | None:
    if not url or not _is_cdn(url):
        return None
    try:
        data, ctype = safe_stream(url, None, THUMB_MAX_BYTES)
    except Exception as exc:  # thumbnails are best-effort
        log.debug("thumb failed: %s", exc)
        return None
    if ctype not in ("image/jpeg", "image/png", "image/webp", "image/gif") or not data:
        return None
    return f"data:{ctype};base64,{base64.b64encode(data).decode()}"


def public_view(result: dict) -> dict:
    """Strip server-only fields; attach inline thumbnails."""
    with ThreadPoolExecutor(max_workers=6) as pool:
        thumbs = list(pool.map(_thumb_data_url, [i.get("thumb_url") for i in result["items"]]))
    items = []
    for idx, (item, thumb) in enumerate(zip(result["items"], thumbs)):
        items.append({
            "index": idx,
            "kind": item["kind"],
            "thumb": thumb,
            "width": item.get("width"),
            "height": item.get("height"),
            "duration": item.get("duration"),
        })
    return {
        "platform": result["platform"],
        "title": result.get("title") or "",
        "author": result.get("author") or "",
        "items": items,
    }


# --------------------------------------------------------------------------
# Download
# --------------------------------------------------------------------------

def _safe_name(*parts: str) -> str:
    name = "-".join(p for p in parts if p)
    return re.sub(r"[^A-Za-z0-9._-]+", "", name)[:80] or "stac-media"


def _to_mp3(src: Path, workdir: Path) -> Path:
    out = workdir / "audio.mp3"
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src), "-vn", "-codec:a", "libmp3lame", "-q:a", "0", str(out)],
        capture_output=True,
        timeout=300,
    )
    if proc.returncode != 0 or not out.exists():
        log.info("ffmpeg failed: %s", proc.stderr[-500:])
        raise UserError("This video has no audio track to extract.", 422)
    return out


def download(result: dict, index: int, as_audio: bool, workdir: Path) -> tuple[Path, str, str]:
    """Returns (path, media_type, filename)."""
    items = result["items"]
    if not (0 <= index < len(items)):
        raise UserError("That item no longer exists. Fetch the link again.")
    item = items[index]
    platform = result["platform"]
    base_name = _safe_name("stac", platform, result.get("id", ""), str(index + 1) if len(items) > 1 else "")

    if as_audio and item["kind"] != "video":
        raise UserError("Audio can only be extracted from videos.")

    if item["source"] == "direct":
        url = item["url"]
        if item["kind"] == "image":
            raw = workdir / "image.bin"
            _, ctype = safe_stream(url, raw, MAX_BYTES)
            ext = {"image/png": "png", "image/webp": "webp", "image/gif": "gif"}.get(ctype, "jpg")
            media = ctype if ctype.startswith("image/") else "image/jpeg"
            final = workdir / f"{base_name}.{ext}"
            raw.rename(final)
            return final, media, final.name
        raw = workdir / "video.mp4"
        safe_stream(url, raw, MAX_BYTES)
        if as_audio:
            mp3 = _to_mp3(raw, workdir)
            return mp3, "audio/mpeg", f"{base_name}.mp3"
        return raw, "video/mp4", f"{base_name}.mp4"

    # yt-dlp download (handles DASH/HLS + merging).
    import yt_dlp

    opts = {
        **_ytdlp_base(platform),
        "outtmpl": str(workdir / "dl.%(ext)s"),
    }
    if item.get("ytdlp_index"):
        opts["playlist_items"] = str(item["ytdlp_index"])
    if as_audio:
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"}]
    else:
        # Prefer H.264/AAC MP4 up to 1080p so files play everywhere and stay a sane size.
        opts["format"] = (
            "bv*[ext=mp4][vcodec^=avc][height<=1080]+ba[ext=m4a]/"
            "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/"
            "b[ext=mp4][height<=1080]/bv*[height<=1080]+ba/bv*+ba/b"
        )
        opts["merge_output_format"] = "mp4"
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([result["url"]])
    except yt_dlp.utils.DownloadError as exc:
        log.info("download failed %s: %s", platform, exc)
        raise _friendly_ytdlp_error(exc, platform) from exc

    files = [p for p in workdir.iterdir() if p.is_file() and p.suffix not in (".part", ".ytdl") and p.stat().st_size > 0]
    if not files:
        raise UserError("The platform didn't send a file. Try again in a moment.", 502)
    target = max(files, key=lambda p: p.stat().st_size)
    if target.stat().st_size > MAX_BYTES:
        raise UserError(f"This file is larger than the {MAX_MB} MB limit.", 413)
    if as_audio:
        return target, "audio/mpeg", f"{base_name}.mp3"
    ext = target.suffix.lstrip(".").lower() or "mp4"
    return target, "video/mp4" if ext == "mp4" else "application/octet-stream", f"{base_name}.{ext}"


# --------------------------------------------------------------------------
# Storage (rate limits + resolve cache)
# --------------------------------------------------------------------------

class Store(Protocol):
    def get(self, key: str, default: Any = None) -> Any: ...
    def put(self, key: str, value: Any) -> None: ...


class MemoryStore:
    def __init__(self):
        self._d: dict[str, Any] = {}

    def get(self, key, default=None):
        return self._d.get(key, default)

    def put(self, key, value):
        if len(self._d) > 5000:
            self._d.clear()
        self._d[key] = value


def check_rate(store: Store, bucket: str, ip: str, limit: int, window: int = 600) -> None:
    slot = int(time.time() // window)
    key = f"rl:{bucket}:{ip}:{slot}"
    try:
        count = int(store.get(key, 0) or 0) + 1
        store.put(key, count)
    except Exception as exc:  # never fail closed on a storage hiccup
        log.warning("rate store error: %s", exc)
        return
    if count > limit:
        raise UserError("Too many requests from your connection. Please wait a few minutes.", 429)


def _cache_key(url: str) -> str:
    return "res:" + hashlib.sha256(url.encode()).hexdigest()


# --------------------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------------------

def parse_origins() -> tuple[list[str], str | None]:
    raw = os.environ.get("STAC_CORS_ORIGINS", "")
    origins = [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
    regex = os.environ.get("STAC_CORS_ORIGIN_REGEX") or None
    return origins, regex


def create_app(store: Store | None = None):
    from fastapi import FastAPI, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse, JSONResponse
    from pydantic import BaseModel, Field
    from starlette.background import BackgroundTask

    store = store or MemoryStore()
    api = FastAPI(title="STAC Media", docs_url=None, redoc_url=None, openapi_url=None)
    origins, origin_regex = parse_origins()
    api.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_origin_regex=origin_regex,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        expose_headers=["Content-Disposition", "Content-Length"],
        max_age=600,
    )

    @api.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @api.exception_handler(UserError)
    async def user_error(_: Request, exc: UserError):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    @api.exception_handler(Exception)
    async def unexpected(_: Request, exc: Exception):
        log.exception("unexpected error: %s", exc)
        return JSONResponse({"detail": "Something went wrong on our side. Please try again."}, status_code=500)

    class ResolveBody(BaseModel):
        url: str = Field(max_length=2048)

    class DownloadBody(BaseModel):
        url: str = Field(max_length=2048)
        index: int = Field(ge=0, lt=MAX_ITEMS)
        audio: bool = False

    def client_ip(request: Request) -> str:
        return (request.client.host if request.client else "") or "unknown"

    def cached_resolve(platform: str, url: str) -> dict:
        key = _cache_key(url)
        try:
            hit = store.get(key)
        except Exception:
            hit = None
        if hit and hit.get("_at", 0) > time.time() - CACHE_TTL:
            return hit
        result = resolve(platform, url)
        result["_at"] = time.time()
        try:
            store.put(key, result)
        except Exception as exc:
            log.warning("cache put failed: %s", exc)
        return result

    @api.get("/health")
    def health():
        return {"ok": True}

    @api.post("/resolve")
    def resolve_route(body: ResolveBody, request: Request):
        check_rate(store, "resolve", client_ip(request), limit=40)
        platform, url = detect_platform(body.url)
        return public_view(cached_resolve(platform, url))

    @api.post("/download")
    def download_route(body: DownloadBody, request: Request):
        check_rate(store, "download", client_ip(request), limit=60)
        platform, url = detect_platform(body.url)
        result = cached_resolve(platform, url)
        workdir = Path(tempfile.mkdtemp(prefix="stac-media-"))
        try:
            path, media_type, filename = download(result, body.index, body.audio, workdir)
        except Exception:
            shutil.rmtree(workdir, ignore_errors=True)
            raise
        return FileResponse(
            path=str(path),
            filename=filename,
            media_type=media_type,
            background=BackgroundTask(shutil.rmtree, workdir, ignore_errors=True),
        )

    return api
