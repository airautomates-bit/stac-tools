'use client';

import { useEffect, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import ImageTracer from 'imagetracerjs';
import { IMAGE_API, MAX_BYTES } from '@/lib/config';
import { baseName, canvasToBlob, downloadBlob, drawFileToCanvas, errorMessage, fileFormat, networkError, prettyBytes, validateImage, type ImageMeta } from '@/lib/utils';
import UploadBox from './UploadBox';
import { IconDownload, IconImage } from './icons';

type ConvertFormat = 'png' | 'jpg' | 'webp' | 'avif' | 'heic' | 'tiff' | 'bmp' | 'gif' | 'ico' | 'svg' | 'pdf';

const formatInfo: Record<ConvertFormat, { label: string; sub: string; ext: string }> = {
  png: { label: 'PNG', sub: 'Lossless', ext: 'png' }, jpg: { label: 'JPG', sub: 'Photo', ext: 'jpg' },
  webp: { label: 'WEBP', sub: 'Web', ext: 'webp' }, avif: { label: 'AVIF', sub: 'Compact', ext: 'avif' },
  heic: { label: 'HEIC', sub: 'Apple', ext: 'heic' }, tiff: { label: 'TIFF', sub: 'Print', ext: 'tiff' },
  bmp: { label: 'BMP', sub: 'Bitmap', ext: 'bmp' }, gif: { label: 'GIF', sub: 'Legacy', ext: 'gif' },
  ico: { label: 'ICO', sub: 'Icon', ext: 'ico' }, svg: { label: 'SVG', sub: 'Vector trace', ext: 'svg' },
  pdf: { label: 'PDF', sub: 'Document', ext: 'pdf' },
};
const LOCAL_MIME: Partial<Record<ConvertFormat, string>> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif' };
const CLOUD_ONLY = new Set<ConvertFormat>(['heic', 'tiff', 'bmp', 'gif', 'ico']);
const NEEDS_CLOUD = 'cloud';

function isBrowserUndecodable(file: File) {
  return /\.(heic|heif|tiff?)$/i.test(file.name) || /image\/(heic|heif|tiff)/i.test(file.type);
}

export default function ConvertTool() {
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const [preview, setPreview] = useState('');
  const [format, setFormat] = useState<ConvertFormat>('png');
  const [quality, setQuality] = useState(92);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function choose(next: File) {
    setError(''); setDone('');
    try {
      const m = await validateImage(next);
      setFile(next); setMeta(m); setPreview(URL.createObjectURL(next));
    } catch (e) {
      // HEIC / TIFF can't be previewed in most browsers but the cloud worker reads them.
      if (isBrowserUndecodable(next) && next.size <= MAX_BYTES) {
        setFile(next); setMeta(null); setPreview('');
        return;
      }
      setError(e instanceof Error ? e.message : 'Could not open this image.');
    }
  }

  async function localConvert(target: ConvertFormat, src: File): Promise<Blob> {
    if (CLOUD_ONLY.has(target) || !meta) throw new Error(NEEDS_CLOUD);
    if (target === 'svg') {
      const canvas = await drawFileToCanvas(src, 2200);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas is unavailable.');
      const svg = ImageTracer.imagedataToSVG(ctx.getImageData(0, 0, canvas.width, canvas.height), {
        ltres: 1, qtres: 1, pathomit: 8, colorsampling: 2, numberofcolors: 32, mincolorratio: 0.01, colorquantcycles: 3, scale: 1, strokewidth: 0,
      });
      return new Blob([svg], { type: 'image/svg+xml' });
    }
    if (target === 'pdf') {
      const canvas = await drawFileToCanvas(src);
      const png = await canvasToBlob(canvas, 'image/png');
      const pdf = await PDFDocument.create();
      const embedded = await pdf.embedPng(new Uint8Array(await png.arrayBuffer()));
      const ratio = embedded.width / embedded.height;
      const max = 1600;
      const pageW = ratio >= 1 ? max : max * ratio;
      const pageH = ratio >= 1 ? max / ratio : max;
      pdf.addPage([pageW, pageH]).drawImage(embedded, { x: 0, y: 0, width: pageW, height: pageH });
      return new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' });
    }
    const mime = LOCAL_MIME[target];
    if (!mime) throw new Error(NEEDS_CLOUD);
    const canvas = await drawFileToCanvas(src);
    if (target === 'jpg') {
      // JPG has no transparency: flatten onto white instead of black.
      const flat = document.createElement('canvas');
      flat.width = canvas.width; flat.height = canvas.height;
      const fctx = flat.getContext('2d');
      if (!fctx) throw new Error('Canvas is unavailable.');
      fctx.fillStyle = '#fff'; fctx.fillRect(0, 0, flat.width, flat.height); fctx.drawImage(canvas, 0, 0);
      return canvasToBlob(flat, mime, quality / 100);
    }
    const blob = await canvasToBlob(canvas, mime, quality / 100);
    if (blob.type !== mime) throw new Error(NEEDS_CLOUD); // browser silently fell back to PNG
    return blob;
  }

  async function cloudConvert(target: ConvertFormat, src: File) {
    if (target === 'svg' || target === 'pdf') throw new Error(`${formatInfo[target].label} needs a browser-readable image. Convert to PNG first.`);
    const form = new FormData();
    form.append('file', src);
    form.append('format', target);
    form.append('quality', String(quality));
    const res = await fetch(`${IMAGE_API}/convert`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(await errorMessage(res, `Conversion failed (${res.status}).`));
    return res.blob();
  }

  async function convert() {
    if (!file || busy) return;
    setBusy(true); setError(''); setDone('');
    try {
      let blob: Blob;
      try { blob = await localConvert(format, file); }
      catch (e) {
        if (e instanceof Error && e.message === NEEDS_CLOUD) blob = await cloudConvert(format, file);
        else throw e;
      }
      downloadBlob(blob, `${baseName(file)}-stac.${formatInfo[format].ext}`);
      setDone(`${formatInfo[format].label} saved${meta ? ` at ${meta.width} × ${meta.height}` : ''}${format === 'svg' ? ' (traced vector paths)' : ''}.`);
    } catch (e) { setError(networkError(e, 'Conversion failed.')); }
    finally { setBusy(false); }
  }

  if (!file) {
    return (
      <div className="toolgrid">
        <section className="card stage"><UploadBox title="Drop an image to convert" copy="Switch between 11 formats — most conversions happen right in your browser." foot="PNG · JPG · WEBP · AVIF · HEIC · TIFF · BMP · GIF · ICO · SVG · PDF" accept="image/*,.heic,.heif,.tif,.tiff" onFile={choose} /></section>
        <aside className="card panel">
          <div className="block"><h3>Formats</h3><div className="taglist">{Object.values(formatInfo).map((f) => <span key={f.label} className="tag soft">{f.label}</span>)}</div></div>
          <div className="block tinted mint"><h3>Private by default</h3><p className="muted small">PNG, JPG, WEBP, SVG and PDF are created on your device. Other formats are converted on our server and never stored.</p></div>
          {error && <div className="notice error" role="alert">{error}</div>}
        </aside>
      </div>
    );
  }

  return (
    <div className="toolgrid">
      <section className="card stage">
        <div className="stagehead">
          <div><span className="eyebrow">Source image</span><strong title={file.name}>{file.name}</strong></div>
          <button className="pill ghost small" onClick={() => { setFile(null); setMeta(null); setPreview(''); setDone(''); setError(''); }}>Replace image</button>
        </div>
        <div className="previewbox checker">
          {preview ? <img src={preview} alt="Image to convert" /> : <div className="nopreview"><IconImage width={34} height={34} /><span>Preview isn&apos;t available for {fileFormat(file)} in this browser, but it converts fine.</span></div>}
          {busy && <div className="overlay"><div><div className="spinner" /><strong>Converting to {formatInfo[format].label}</strong></div></div>}
        </div>
      </section>
      <aside className="card panel">
        <div className="block">
          <h3>Source</h3>
          <div className="stats">
            <div className="stat lilac"><span>Resolution</span><b>{meta ? `${meta.width}×${meta.height}` : '—'}</b></div>
            <div className="stat peach"><span>Size</span><b>{prettyBytes(file.size)}</b></div>
            <div className="stat mint"><span>Type</span><b>{fileFormat(file)}</b></div>
          </div>
        </div>
        <div className="block">
          <h3>Convert to</h3>
          <div className="choicegrid four">
            {(Object.keys(formatInfo) as ConvertFormat[]).map((f) => (
              <button key={f} className={`choice ${format === f ? 'active' : ''}`} onClick={() => setFormat(f)} aria-pressed={format === f}
                disabled={!meta && (f === 'svg' || f === 'pdf')}>
                <b>{formatInfo[f].label}</b><small>{formatInfo[f].sub}</small>
              </button>
            ))}
          </div>
        </div>
        {!['png', 'svg', 'pdf', 'tiff', 'bmp', 'gif', 'ico'].includes(format) && (
          <div className="block">
            <div className="rangehead"><h3>Quality</h3><b>{quality}%</b></div>
            <input className="range" type="range" min="40" max="100" value={quality} onChange={(e) => setQuality(Number(e.target.value))} aria-label="Quality" />
          </div>
        )}
        <button className="action" disabled={busy} onClick={convert}>{busy ? 'Converting…' : `Convert to ${formatInfo[format].label}`}<span className="actionicon"><IconDownload /></span></button>
        {format === 'svg' && <div className="notice">SVG traces the visible shapes into editable vector paths — best for logos and flat artwork.</div>}
        {done && <div className="notice success" role="status">{done}</div>}
        {error && <div className="notice error" role="alert">{error}</div>}
      </aside>
    </div>
  );
}
