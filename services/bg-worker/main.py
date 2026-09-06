import io
import os
from functools import lru_cache
from typing import Literal

import cv2
import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image, ImageOps
import pillow_heif
from torchvision import transforms
from transformers import AutoModelForImageSegmentation

MODEL_ID = os.getenv("STAC_MODEL_ID", "ZhengPeng7/BiRefNet_dynamic")
MAX_UPLOAD_MB = int(os.getenv("STAC_MAX_UPLOAD_MB", "100"))
MAX_PIXELS = int(os.getenv("STAC_MAX_PIXELS", "100000000"))
ULTRA_MAX_EDGE = int(os.getenv("STAC_ULTRA_MAX_EDGE", "4096"))
HD_MAX_EDGE = int(os.getenv("STAC_HD_MAX_EDGE", "2048"))
FAST_MAX_EDGE = int(os.getenv("STAC_FAST_MAX_EDGE", "1024"))

pillow_heif.register_heif_opener()
pillow_heif.register_avif_opener()

app = FastAPI(title="STAC Image Worker", version="2.0.0")
origins_env = os.getenv("STAC_CORS_ORIGINS", "*")
origins = ["*"] if origins_env.strip() == "*" else [x.strip() for x in origins_env.split(",") if x.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "X-STAC-Original-Size", "X-STAC-Inference-Size", "X-STAC-Quality"],
)

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
if torch.cuda.is_available():
    torch.set_float32_matmul_precision("high")


async def decode_upload(file: UploadFile):
    raw = await file.read()
    if len(raw) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Maximum upload size is {MAX_UPLOAD_MB} MB.")
    try:
        source = Image.open(io.BytesIO(raw))
        source.load()
        source = ImageOps.exif_transpose(source)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="The uploaded image could not be decoded.") from exc
    if source.width * source.height > MAX_PIXELS:
        raise HTTPException(status_code=413, detail=f"Maximum image area is {MAX_PIXELS / 1_000_000:.0f} MP.")
    return source


@lru_cache(maxsize=1)
def get_model():
    model = AutoModelForImageSegmentation.from_pretrained(MODEL_ID, trust_remote_code=True)
    model.to(DEVICE)
    model.eval()
    if DEVICE.type == "cuda":
        model.half()
    return model


def round32(value: int) -> int:
    return max(32, int(value // 32 * 32))


def inference_size(width: int, height: int, quality: str):
    max_edge = FAST_MAX_EDGE if quality == "fast" else HD_MAX_EDGE if quality == "hd" else ULTRA_MAX_EDGE
    longest = max(width, height)
    if max_edge > 0 and longest > max_edge:
        scale = max_edge / longest
        width, height = max(32, int(width * scale)), max(32, int(height * scale))
    return round32(width), round32(height)


def build_tensor(image: Image.Image, size):
    pipeline = transforms.Compose([
        transforms.Resize((size[1], size[0])),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    return pipeline(image).unsqueeze(0)


def foreground_estimator(image, f, b, alpha, radius=90):
    blurred_alpha = cv2.blur(alpha, (radius, radius))[:, :, None]
    blurred_fa = cv2.blur(f * alpha[:, :, None], (radius, radius))
    blurred_f = blurred_fa / (blurred_alpha + 1e-5)
    blurred_b1a = cv2.blur(b * (1 - alpha[:, :, None]), (radius, radius))
    blurred_b = blurred_b1a / ((1 - blurred_alpha) + 1e-5)
    f = blurred_f + alpha[:, :, None] * (image - alpha[:, :, None] * blurred_f - (1 - alpha[:, :, None]) * blurred_b)
    return np.clip(f, 0, 1), blurred_b


def refine_foreground(image: Image.Image, mask: Image.Image):
    if mask.size != image.size:
        mask = mask.resize(image.size, Image.Resampling.LANCZOS)
    arr = np.asarray(image, dtype=np.float32) / 255.0
    alpha = np.asarray(mask, dtype=np.float32) / 255.0
    f1, b1 = foreground_estimator(arr, arr, arr, alpha, radius=90)
    f2, _ = foreground_estimator(arr, f1, b1, alpha, radius=6)
    return Image.fromarray((f2 * 255.0).astype(np.uint8), mode="RGB")


def predict_mask(image: Image.Image, quality: str):
    model = get_model()
    size = inference_size(*image.size, quality)
    tensor = build_tensor(image, size).to(DEVICE)
    if DEVICE.type == "cuda":
        tensor = tensor.half()
    with torch.inference_mode():
        prediction = model(tensor)[-1].sigmoid().float().cpu()[0].squeeze()
    mask = transforms.ToPILImage()(prediction).convert("L")
    return mask.resize(image.size, Image.Resampling.LANCZOS), size


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "device": DEVICE.type, "cuda": torch.cuda.is_available()}


@app.post("/remove-background")
async def remove_background(file: UploadFile = File(...), quality: Literal["fast", "hd", "ultra"] = Form("ultra")):
    source = await decode_upload(file)
    icc_profile = source.info.get("icc_profile")
    image = source.convert("RGB")
    try:
        mask, used_size = predict_mask(image, quality)
        foreground = refine_foreground(image, mask) if quality == "ultra" else image.copy()
        foreground.putalpha(mask)
    except torch.cuda.OutOfMemoryError as exc:
        if DEVICE.type == "cuda":
            torch.cuda.empty_cache()
        raise HTTPException(status_code=507, detail="GPU memory exhausted. Reduce the Ultra inference edge or use a larger GPU.") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Background removal failed: {type(exc).__name__}.") from exc

    output = io.BytesIO()
    kwargs = {"format": "PNG", "compress_level": 6, "optimize": False}
    if icc_profile:
        kwargs["icc_profile"] = icc_profile
    foreground.save(output, **kwargs)
    filename = os.path.splitext(file.filename or "image")[0] + "-stac-bg.png"
    return Response(
        content=output.getvalue(), media_type="image/png",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-STAC-Original-Size": f"{source.width}x{source.height}",
            "X-STAC-Inference-Size": f"{used_size[0]}x{used_size[1]}",
            "X-STAC-Quality": quality,
        },
    )


FORMAT_MAP = {
    "png": ("PNG", "image/png", "png"),
    "jpg": ("JPEG", "image/jpeg", "jpg"),
    "jpeg": ("JPEG", "image/jpeg", "jpg"),
    "webp": ("WEBP", "image/webp", "webp"),
    "avif": ("AVIF", "image/avif", "avif"),
    "heic": ("HEIF", "image/heic", "heic"),
    "tiff": ("TIFF", "image/tiff", "tiff"),
    "bmp": ("BMP", "image/bmp", "bmp"),
    "gif": ("GIF", "image/gif", "gif"),
    "ico": ("ICO", "image/x-icon", "ico"),
}


@app.post("/convert")
async def convert_image(file: UploadFile = File(...), format: str = Form(...), quality: int = Form(92)):
    target = format.lower().strip()
    if target not in FORMAT_MAP:
        raise HTTPException(status_code=415, detail=f"Cloud converter does not support {target.upper()} output.")
    source = await decode_upload(file)
    fmt, media_type, ext = FORMAT_MAP[target]
    q = max(1, min(100, int(quality)))
    icc = source.info.get("icc_profile")

    # Preserve alpha in formats that support it; flatten only when required.
    if target in {"jpg", "jpeg", "heic"} and source.mode in {"RGBA", "LA", "P"}:
        rgba = source.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        bg.alpha_composite(rgba)
        image = bg.convert("RGB")
    elif target in {"jpg", "jpeg", "bmp", "ico"}:
        image = source.convert("RGB")
    else:
        image = source.convert("RGBA") if "A" in source.getbands() else source.convert("RGB")

    output = io.BytesIO()
    kwargs = {}
    if target in {"jpg", "jpeg"}:
        kwargs.update(quality=q, subsampling=0 if q >= 95 else 2, optimize=True)
    elif target == "webp":
        kwargs.update(quality=q, method=6)
    elif target in {"heic", "avif"}:
        kwargs.update(quality=q)
    elif target == "tiff":
        kwargs.update(compression="tiff_deflate")
    elif target == "png":
        kwargs.update(compress_level=6)
    elif target == "gif":
        image = image.convert("P", palette=Image.Palette.ADAPTIVE, colors=256)
    elif target == "ico":
        kwargs.update(sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])

    if icc and target in {"png", "jpg", "jpeg", "webp", "tiff"}:
        kwargs["icc_profile"] = icc
    try:
        image.save(output, format=fmt, **kwargs)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"{target.upper()} encoding failed: {type(exc).__name__}.") from exc

    filename = os.path.splitext(file.filename or "image")[0] + f"-stac.{ext}"
    return Response(content=output.getvalue(), media_type=media_type, headers={"Content-Disposition": f'attachment; filename="{filename}"'})
