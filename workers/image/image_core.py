"""STAC image worker: background removal + server-side format conversion.

Framework-only so it can be tested locally; ``modal_app.py`` plugs in the GPU
model for background removal.
"""


import io
import logging
import os
import time
from typing import Any, Callable

log = logging.getLogger("stac.image")

MAX_UPLOAD_MB = int(os.environ.get("STAC_MAX_UPLOAD_MB", "100"))
MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024
MAX_PIXELS = int(os.environ.get("STAC_MAX_PIXELS", "100000000"))

FORMATS = {
    # name: (Pillow format, mime, extension, supports alpha)
    "png": ("PNG", "image/png", "png", True),
    "jpg": ("JPEG", "image/jpeg", "jpg", False),
    "webp": ("WEBP", "image/webp", "webp", True),
    "avif": ("AVIF", "image/avif", "avif", True),
    "heic": ("HEIF", "image/heic", "heic", True),
    "tiff": ("TIFF", "image/tiff", "tiff", True),
    "bmp": ("BMP", "image/bmp", "bmp", False),
    "gif": ("GIF", "image/gif", "gif", True),
    "ico": ("ICO", "image/x-icon", "ico", True),
}

Remover = Callable[[Any, str], Any]  # (PIL.Image RGB, quality) -> PIL "L" mask


class UserError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _open_image(raw: bytes):
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        import pillow_heif  # type: ignore

        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Image.DecompressionBombError as exc:
        raise UserError(f"This image is larger than the {MAX_PIXELS // 1_000_000} MP limit.", 413) from exc
    except Exception as exc:
        raise UserError("This file couldn't be read as an image.", 415) from exc
    if img.width * img.height > MAX_PIXELS:
        raise UserError(f"This image is larger than the {MAX_PIXELS // 1_000_000} MP limit.", 413)
    icc = img.info.get("icc_profile")
    img = ImageOps.exif_transpose(img)
    return img, icc


def convert(raw: bytes, target: str, quality: int) -> tuple[bytes, str, str]:
    from PIL import Image

    if target not in FORMATS:
        raise UserError("Unsupported output format.")
    fmt, mime, ext, alpha_ok = FORMATS[target]
    quality = max(1, min(100, int(quality)))
    img, icc = _open_image(raw)

    has_alpha = img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info)
    if has_alpha:
        img = img.convert("RGBA")
        if not alpha_ok:
            flat = Image.new("RGB", img.size, (255, 255, 255))
            flat.paste(img, mask=img.split()[-1])
            img = flat
    else:
        img = img.convert("RGB")

    kwargs: dict[str, Any] = {}
    if icc and target not in ("gif", "ico", "bmp"):
        kwargs["icc_profile"] = icc
    if target in ("jpg", "webp", "avif", "heic"):
        kwargs["quality"] = quality
    if target == "jpg":
        kwargs.update(optimize=True, progressive=True, subsampling=0 if quality >= 90 else 2)
    if target == "webp" and quality >= 100:
        kwargs["lossless"] = True
    if target == "tiff":
        kwargs["compression"] = "tiff_lzw"
    if target == "ico":
        side = min(256, max(img.size))
        kwargs["sizes"] = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256) if s <= side] or [(side, side)]
    if target == "gif":
        if img.mode == "RGBA":
            alpha = img.split()[-1]
            pal = img.convert("RGB").quantize(colors=255, method=Image.Quantize.MEDIANCUT)
            mask = alpha.point(lambda a: 255 if a < 128 else 0)
            pal.paste(255, mask=mask)
            img = pal
            kwargs["transparency"] = 255
        else:
            img = img.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
    if target == "heic":
        try:
            import pillow_heif  # type: ignore  # noqa: F401
        except ImportError as exc:
            raise UserError("HEIC export isn't available on this server.", 501) from exc

    buf = io.BytesIO()
    try:
        img.save(buf, format=fmt, **kwargs)
    except (KeyError, OSError, ValueError) as exc:
        log.info("encode failed %s: %s", target, exc)
        raise UserError(f"{target.upper()} export failed for this image.", 422) from exc
    return buf.getvalue(), mime, ext


def remove_background(raw: bytes, quality: str, remover: Remover) -> tuple[bytes, int, int]:
    from PIL import Image

    img, icc = _open_image(raw)
    source = img.convert("RGB")
    mask = remover(source, quality)
    if mask.size != source.size:
        mask = mask.resize(source.size, Image.Resampling.LANCZOS)
    out = source.copy()
    out.putalpha(mask)
    buf = io.BytesIO()
    kwargs: dict[str, Any] = {"format": "PNG"}
    if icc:
        kwargs["icc_profile"] = icc
    out.save(buf, **kwargs)
    return buf.getvalue(), out.width, out.height


# --------------------------------------------------------------------------

class MemoryStore:
    def __init__(self):
        self._d: dict[str, Any] = {}

    def get(self, key, default=None):
        return self._d.get(key, default)

    def put(self, key, value):
        if len(self._d) > 5000:
            self._d.clear()
        self._d[key] = value


def check_rate(store, bucket: str, ip: str, limit: int, window: int = 600) -> None:
    key = f"rl:{bucket}:{ip}:{int(time.time() // window)}"
    try:
        count = int(store.get(key, 0) or 0) + 1
        store.put(key, count)
    except Exception as exc:
        log.warning("rate store error: %s", exc)
        return
    if count > limit:
        raise UserError("Too many requests from your connection. Please wait a few minutes.", 429)


def create_app(remover: Remover | None = None, store=None):
    from fastapi import FastAPI, File, Form, Request, UploadFile
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse, Response
    from starlette.concurrency import run_in_threadpool

    store = store or MemoryStore()
    api = FastAPI(title="STAC Image", docs_url=None, redoc_url=None, openapi_url=None)
    raw_origins = os.environ.get("STAC_CORS_ORIGINS", "")
    api.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip().rstrip("/") for o in raw_origins.split(",") if o.strip()],
        allow_origin_regex=os.environ.get("STAC_CORS_ORIGIN_REGEX") or None,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        expose_headers=["Content-Disposition", "X-STAC-Width", "X-STAC-Height"],
        max_age=600,
    )

    @api.middleware("http")
    async def guard(request: Request, call_next):
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_UPLOAD + 64 * 1024:
            return JSONResponse({"detail": f"Files up to {MAX_UPLOAD_MB} MB are accepted."}, status_code=413)
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

    def ip(request: Request) -> str:
        return (request.client.host if request.client else "") or "unknown"

    async def read_upload(file: UploadFile) -> bytes:
        raw = await file.read(MAX_UPLOAD + 1)
        if not raw:
            raise UserError("The uploaded file is empty.")
        if len(raw) > MAX_UPLOAD:
            raise UserError(f"Files up to {MAX_UPLOAD_MB} MB are accepted.", 413)
        return raw

    @api.get("/health")
    def health():
        return {"ok": True}

    @api.post("/remove-background")
    async def remove_bg(request: Request, file: UploadFile = File(...), quality: str = Form("ultra")):
        if remover is None:
            raise UserError("Background removal isn't available on this server.", 501)
        await run_in_threadpool(check_rate, store, "bg", ip(request), 30)
        if quality not in ("fast", "hd", "ultra"):
            quality = "ultra"
        raw = await read_upload(file)
        png, w, h = await run_in_threadpool(remove_background, raw, quality, remover)
        return Response(
            content=png,
            media_type="image/png",
            headers={
                "Content-Disposition": 'attachment; filename="stac-bg.png"',
                "X-STAC-Width": str(w),
                "X-STAC-Height": str(h),
            },
        )

    @api.post("/convert")
    async def convert_route(
        request: Request,
        file: UploadFile = File(...),
        format: str = Form(...),
        quality: int = Form(92),
    ):
        await run_in_threadpool(check_rate, store, "convert", ip(request), 60)
        raw = await read_upload(file)
        data, mime, ext = await run_in_threadpool(convert, raw, format.lower().strip(), quality)
        return Response(
            content=data,
            media_type=mime,
            headers={"Content-Disposition": f'attachment; filename="stac-converted.{ext}"'},
        )

    return api
