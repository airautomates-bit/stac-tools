"""Modal deployment for the STAC media worker.

Deploy from this folder:

    cd workers/media
    modal deploy modal_app.py

App and class names match the previous deployment, so the public URL stays
https://<workspace>--stac-media-saver-mediasaver-web.modal.run
"""

from pathlib import Path

import modal

APP_NAME = "stac-media-saver"

# Sites allowed to call this worker from a browser (set at container start;
# Modal's image env step can't carry the regex backslashes).
CORS = {
    "STAC_CORS_ORIGINS": "https://stac-tools.vercel.app,http://localhost:3000",
    # This project's Vercel preview deployments.
    "STAC_CORS_ORIGIN_REGEX": r"https://stac-tools(-[a-z0-9-]+)?\.vercel\.app",
}

app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "ca-certificates", "curl", "unzip")
    # Deno: the JavaScript runtime yt-dlp uses for YouTube's player challenges.
    .run_commands(
        "curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- -y",
        "deno --version",
    )
    .pip_install(
        "fastapi>=0.118,<1",
        "pydantic>=2.11,<3",
        "httpx>=0.28,<1",
        # Pin a known-good build; bump deliberately when platforms change.
        "yt-dlp[default,curl-cffi]==2026.10.26",
        # Image conversion (served under /image, CPU only - no GPU needed).
        "pillow>=11.3",
        "pillow-heif>=1.0",
        "python-multipart>=0.0.20",
    )
    .env({"STAC_MEDIA_MAX_MB": "300", "STAC_MAX_UPLOAD_MB": "100", "STAC_MAX_PIXELS": "100000000"})
    .add_local_python_source("media_core")
    .add_local_file(Path(__file__).resolve().parent.parent / "image" / "image_core.py", "/root/image_core.py")
)

# Shared across containers: rate-limit counters and a short resolve cache.
state = modal.Dict.from_name("stac-media-state", create_if_missing=True)


class DictStore:
    def get(self, key, default=None):
        return state.get(key, default)

    def put(self, key, value):
        state[key] = value


@app.cls(
    image=image,
    timeout=600,
    scaledown_window=60,
    cpu=2.0,
    memory=4096,
    # Hard ceiling on parallel containers so abuse can't run up a large bill.
    max_containers=4,
)
@modal.concurrent(max_inputs=8)
class MediaSaver:
    @modal.asgi_app()
    def web(self):
        import logging
        import os

        for key, value in CORS.items():
            os.environ.setdefault(key, value)

        from image_core import create_app as create_image_app
        from media_core import create_app

        logging.basicConfig(level=logging.INFO)
        api = create_app(DictStore())
        # /image/convert: format conversion on CPU (background removal stays on the GPU worker).
        api.mount("/image", create_image_app(remover=None, store=DictStore()))
        return api
