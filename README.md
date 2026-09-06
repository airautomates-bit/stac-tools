# STAC Tools — Vercel build

A Vercel-first version of the original STAC BG Remover, expanded into three tools:

1. **BG Remover** — full-resolution background removal through a cloud image worker.
2. **Image Converter** — PNG, JPG, WEBP, AVIF, HEIC, TIFF, BMP, GIF, ICO, SVG vector trace and PDF.
3. **Media Saver** — saves permitted media from supported public links through an optional cloud media worker.

The website itself runs on **Vercel**. Your computer does **not** need to stay on.

---

## Architecture

```text
Browser
  |
  |-- STAC interface --------------------------> Vercel / Next.js
  |
  |-- PNG/JPG/WEBP/SVG/PDF conversion --------> Browser (local, no upload)
  |
  |-- BG removal + specialist codecs ---------> Cloud Image Worker (GPU recommended)
  |
  `-- permitted social media saves -----------> Cloud Media Worker
```

The browser talks directly to the workers for large files. This intentionally avoids pushing UHD images and large videos through Vercel Function request/response payload limits.

## 1. Deploy the website to Vercel

### Easiest route

1. Put this folder in a GitHub repository.
2. In Vercel choose **Add New > Project**.
3. Import the repository.
4. Vercel should detect **Next.js** automatically.
5. Deploy.

The converter's browser-native formats (PNG/JPG/WEBP/SVG/PDF) work without either worker.

### Environment variables

Add these later under **Vercel > Project > Settings > Environment Variables**:

```env
NEXT_PUBLIC_IMAGE_API_URL=https://your-image-worker.example.com
NEXT_PUBLIC_MEDIA_API_URL=https://your-media-worker.example.com
```

After changing them, redeploy the site.

---

## 2. Deploy the cloud image worker

Folder:

```text
services/bg-worker/
```

This is a Dockerised FastAPI service. It contains:

- BiRefNet dynamic-resolution background removal
- Fast / HD / Ultra modes
- full-resolution PNG output
- edge colour refinement in Ultra
- cloud conversion for HEIC / AVIF / TIFF / BMP / GIF / ICO
- HEIC/AVIF decoding through `pillow-heif`

### Hardware

A CUDA-capable NVIDIA GPU is recommended for background removal. Conversion-only requests can run on CPU.

Deploy the Docker folder to any cloud platform that gives the container a public HTTPS URL and enough RAM/GPU memory. Then set that URL as `NEXT_PUBLIC_IMAGE_API_URL` in Vercel.

### Worker environment variables

```env
STAC_CORS_ORIGINS=https://your-vercel-domain.vercel.app,https://yourdomain.com
STAC_MAX_UPLOAD_MB=100
STAC_MAX_PIXELS=100000000
STAC_ULTRA_MAX_EDGE=4096
STAC_HD_MAX_EDGE=2048
STAC_FAST_MAX_EDGE=1024
STAC_MODEL_ID=ZhengPeng7/BiRefNet_dynamic
```

For a quick private test, `STAC_CORS_ORIGINS=*` works, but restrict it before publishing.

Health check:

```text
GET /health
```

Main endpoints:

```text
POST /remove-background
POST /convert
```

---

## 3. Optional cloud media worker

Folder:

```text
services/media-worker/
```

It uses `yt-dlp` + `ffmpeg` and is intentionally separate from the Vercel frontend. That keeps large media transfers out of Vercel Functions.

Deploy it to a normal Docker host and set the public HTTPS URL as `NEXT_PUBLIC_MEDIA_API_URL`.

Environment:

```env
STAC_CORS_ORIGINS=https://your-vercel-domain.vercel.app,https://yourdomain.com
STAC_MEDIA_MAX_MB=750
```

Endpoint:

```text
POST /download
Content-Type: application/json

{
  "url": "https://...",
  "format": "video" | "audio" | "image"
}
```

### Important media note

Use this only for media you own, have permission to save, or that the platform/law explicitly permits you to download. Platform support is not permanent: sites change extraction methods, require login, block datacenter IPs, use DRM, or prohibit downloading. Private, DRM-protected, local-network and login-only sources are not intended to be handled by this build.

YouTube's Terms of Service in particular restrict downloading except where YouTube, the rights holder, or applicable law permits it. Do not advertise this tool as an unrestricted YouTube downloader.

---

## Converter behaviour

### Runs entirely in the browser

- PNG
- JPG
- WEBP
- SVG vector trace
- PDF
- AVIF when the user's browser has AVIF Canvas encoding

### Falls back to the image worker when needed

- AVIF when browser export is unavailable
- HEIC
- TIFF
- BMP
- GIF
- ICO

### SVG is real vector tracing

The SVG option creates editable vector paths from raster pixels using ImageTracerJS. It is best for logos, icons, line art, signatures and flat illustrations.

It does **not** claim that a photograph can be converted into the original editable vector artwork. Photos become traced/posterised vector shapes.

---

## Quality / resolution reality

- Background removal keeps the original output width and height.
- PNG output is lossless.
- JPG/WEBP/AVIF/HEIC are encoded formats, so conversion necessarily re-encodes the image.
- Browser Canvas conversions can discard EXIF/ICC metadata even while preserving pixel dimensions.
- The cloud worker preserves ICC profiles where the destination format and Pillow support it.
- “Any format” should be marketed as **broad practical format support**, not a literal promise that every historical/proprietary image format can be encoded.

---

## Production checklist

Before opening this to the public:

- Restrict worker CORS to your actual domains.
- Put rate limiting/authentication in front of both workers so strangers cannot run up GPU/bandwidth bills.
- Add file retention/privacy terms if you later introduce object storage.
- Add abuse controls and a clear rights notice for Media Saver.
- Add observability and spend alerts on the GPU/media hosts.
- Add a custom domain in Vercel.

---

## Local development (optional only)

You do not need local hosting for production. If you want to edit the UI before pushing to Vercel:

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

The production setup remains Vercel + cloud workers; your PC is not part of the live service.
