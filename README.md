# STAC Tools

Free image and media tools: https://stac-tools.vercel.app

- **Background remover**: full-resolution transparent PNG (BiRefNet on a Modal GPU)
- **Image converter**: PNG, JPG, WEBP, AVIF, HEIC, TIFF, BMP, GIF, ICO, SVG (vector trace), PDF
- **Downloaders**: YouTube (videos, Shorts, up to 1080p), Instagram (reels, videos, photos, carousels), Pinterest, Facebook (videos, reels), X / Twitter (videos, GIFs, photos), Threads (beta), with MP3 audio extraction

## Architecture

```text
Browser ── UI ─────────────────────────────> Vercel (Next.js, static)
   │
   ├─ PNG/JPG/WEBP/SVG/PDF conversion ──────> runs in the browser
   ├─ BG removal + HEIC/TIFF/BMP/GIF/ICO ───> workers/image  (Modal, GPU)
   └─ social downloads ─────────────────────> workers/media  (Modal, CPU)
```

Large files go straight from the browser to the workers, so they never pass through Vercel's request limits.

## Website (Vercel)

Pushing to `main` deploys automatically. Nothing needs configuring. If you want to override the worker URLs, set these optional variables:

```env
NEXT_PUBLIC_IMAGE_API_URL=https://airautomates-bit--stac-bg-remover-backgroundremover-web.modal.run
NEXT_PUBLIC_MEDIA_API_URL=https://airautomates-bit--stac-media-saver-mediasaver-web.modal.run
```

These are public browser endpoints, not secrets. Never put API keys in `NEXT_PUBLIC_*` variables. This repository is public.

Local development:

```bash
npm install
npm run dev
```

## Workers (Modal)

```bash
pip install modal
modal token new            # once
cd workers/media && modal deploy modal_app.py
cd ../image && modal deploy modal_app.py
```

The app and class names match the existing deployments, so the URLs above stay the same.

- `workers/media/media_core.py`: `POST /resolve {url}` lists a post's photos and videos (thumbnails inline). `POST /download {url, index, audio}` returns the file.
- `workers/image/image_core.py`: `POST /remove-background` (file, quality=fast|hd|ultra) and `POST /convert` (file, format, quality).

Both cores are plain FastAPI apps (`create_app()`), so they can be run locally with uvicorn for testing.

## Security

- **SSRF**: the media worker only accepts links on YouTube, Instagram, Pinterest, Facebook, X and Threads (YouTube is limited to single videos and Shorts). yt-dlp is limited to those extractors (never `generic`). Direct fetches only go to the platform CDNs over HTTPS, and every redirect is re-checked.
- **CORS**: the workers only answer `stac-tools.vercel.app`, its Vercel previews and `localhost:3000`. Edit `STAC_CORS_ORIGINS` / `STAC_CORS_ORIGIN_REGEX` in each `modal_app.py` if the domain changes.
- **Abuse and cost**: per-IP rate limits (shared through a `modal.Dict`), plus `max_containers` caps (2 GPUs, 4 media containers), upload, pixel and file-size limits.
- **No leaks**: generic error messages to the browser, details only in the worker logs. API docs (`/docs`, `/openapi.json`) are disabled.
- **Website headers**: strict CSP, `X-Frame-Options: DENY`, `nosniff`, HSTS, Referrer-Policy, Permissions-Policy, no `X-Powered-By`, no production source maps.
- **No accounts, database or secrets**: files are processed in memory or temp folders and deleted after each request.
- Dependencies are pinned. `npm audit` is clean (Next.js 16.4.5 fixes several critical advisories in 16.3.x).

## Platform notes

Downloads work for **public** posts only. Platforms change their sites often and sometimes block cloud servers. When that happens, bump the pinned `yt-dlp` version in `workers/media/modal_app.py` and redeploy. Only download content you own or have permission to use.
