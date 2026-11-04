"""Modal deployment for the STAC image worker (background removal + conversion).

Deploy from this folder:

    cd workers/image
    modal deploy modal_app.py

App and class names match the previous deployment, so the public URL stays
https://<workspace>--stac-bg-remover-backgroundremover-web.modal.run
"""

import modal

APP_NAME = "stac-bg-remover"
MODEL_ID = "ZhengPeng7/BiRefNet_dynamic"
# Longest side of the temporary copy the model sees. Output is always full size.
MASK_SIDE = {"fast": 1024, "hd": 1600, "ultra": 2304}

app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch>=2.5.1",
        "torchvision",
        "transformers>=4.45,<5",
        "huggingface-hub>0.25",
        "accelerate",
        "numpy<2",
        "timm",
        "scipy",
        "scikit-image",
        "kornia",
        "einops",
        "pillow>=11.3",
        "pillow-heif>=1.0",
        "fastapi>=0.118,<1",
        "python-multipart>=0.0.20",
        "safetensors",
    )
    .env({
        "HF_HOME": "/root/.cache/huggingface",
        "HF_XET_HIGH_PERFORMANCE": "1",
        "STAC_CORS_ORIGINS": "https://stac-tools.vercel.app,http://localhost:3000",
        "STAC_CORS_ORIGIN_REGEX": r"https://stac-tools(-[a-z0-9-]+)?\.vercel\.app",
        "STAC_MAX_UPLOAD_MB": "100",
        "STAC_MAX_PIXELS": "100000000",
    })
    .run_commands(
        f"python -c \"from huggingface_hub import snapshot_download; snapshot_download('{MODEL_ID}')\""
    )
    .add_local_python_source("image_core")
)

state = modal.Dict.from_name("stac-image-state", create_if_missing=True)


class DictStore:
    def get(self, key, default=None):
        return state.get(key, default)

    def put(self, key, value):
        state[key] = value


@app.cls(
    image=image,
    gpu="T4",
    timeout=300,
    scaledown_window=60,
    # Hard ceiling on GPU containers so abuse can't run up a large bill.
    max_containers=2,
)
class BackgroundRemover:
    @modal.enter()
    def load_model(self):
        import threading

        import torch
        from torchvision import transforms
        from transformers import AutoModelForImageSegmentation

        torch.set_float32_matmul_precision("high")
        self.torch = torch
        self.to_pil = transforms.ToPILImage()
        self.model = AutoModelForImageSegmentation.from_pretrained(MODEL_ID, trust_remote_code=True)
        self.model.to("cuda").eval().half()
        self.normalize = transforms.Compose([
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])
        self.lock = threading.Lock()

    def mask(self, source, quality: str):
        from PIL import Image

        side = MASK_SIDE.get(quality, MASK_SIDE["ultra"])
        w, h = source.size
        scale = min(1.0, side / max(w, h))
        iw = max(32, (int(w * scale) // 32) * 32)
        ih = max(32, (int(h * scale) // 32) * 32)
        working = source.resize((iw, ih), Image.Resampling.LANCZOS)
        tensor = self.normalize(working).unsqueeze(0).to("cuda").half()
        with self.lock, self.torch.inference_mode():
            pred = self.model(tensor)[-1].sigmoid().float().cpu()[0].squeeze()
        return self.to_pil(pred).resize(source.size, Image.Resampling.LANCZOS)

    @modal.asgi_app()
    def web(self):
        import logging

        from image_core import create_app

        logging.basicConfig(level=logging.INFO)
        return create_app(self.mask, DictStore())
