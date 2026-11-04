"""Modal deployment for the STAC media worker.

Deploy from this folder:

    cd workers/media
    modal deploy modal_app.py

App and class names match the previous deployment, so the public URL stays
https://<workspace>--stac-media-saver-mediasaver-web.modal.run
"""

import modal

APP_NAME = "stac-media-saver"

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
    )
    .env({
        # Comma separated list of sites allowed to call this worker from a browser.
        "STAC_CORS_ORIGINS": "https://stac-tools.vercel.app,http://localhost:3000",
        # Also allow this project's Vercel preview deployments.
        "STAC_CORS_ORIGIN_REGEX": r"https://stac-tools(-[a-z0-9-]+)?\.vercel\.app",
        "STAC_MEDIA_MAX_MB": "300",
    })
    .add_local_python_source("media_core")
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
    memory=2048,
    # Hard ceiling on parallel containers so abuse can't run up a large bill.
    max_containers=4,
)
@modal.concurrent(max_inputs=8)
class MediaSaver:
    @modal.asgi_app()
    def web(self):
        import logging

        from media_core import create_app

        logging.basicConfig(level=logging.INFO)
        return create_app(DictStore())
