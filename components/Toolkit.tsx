'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { PDFDocument } from 'pdf-lib';
import ImageTracer from 'imagetracerjs';

type ToolKey = 'remove' | 'convert' | 'save';
type ImageMeta = { width: number; height: number };
type BgQuality = 'fast' | 'hd' | 'ultra';
type ConvertFormat = 'png' | 'jpg' | 'webp' | 'avif' | 'heic' | 'tiff' | 'bmp' | 'gif' | 'ico' | 'svg' | 'pdf';

const IMAGE_API = (process.env.NEXT_PUBLIC_IMAGE_API_URL || '').replace(/\/$/, '');
const MEDIA_API = (process.env.NEXT_PUBLIC_MEDIA_API_URL || '').replace(/\/$/, '');
const MAX_PIXELS = 100_000_000;
const MAX_BYTES = 100 * 1024 * 1024;

function prettyBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fileFormat(file: File) {
  const ext = file.name.split('.').pop()?.toUpperCase() || file.type.split('/').pop()?.toUpperCase() || 'IMAGE';
  return ext === 'JPEG' ? 'JPG' : ext;
}

async function getImageMeta(file: File): Promise<ImageMeta> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('This image could not be decoded by your browser.'));
      img.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function validateImage(file: File) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > MAX_BYTES) throw new Error('This build accepts source files up to 100 MB.');
  const meta = await getImageMeta(file);
  if (meta.width * meta.height > MAX_PIXELS) {
    throw new Error(`This image is ${(meta.width * meta.height / 1_000_000).toFixed(1)} MP. The current safety limit is 100 MP.`);
  }
  return meta;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function drawFileToCanvas(file: File, maxSide?: number) {
  const bitmap = await createImageBitmap(file);
  let width = bitmap.width;
  let height = bitmap.height;
  if (maxSide && Math.max(width, height) > maxSide) {
    const ratio = maxSide / Math.max(width, height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Canvas is unavailable in this browser.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas;
}

async function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number) {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
  if (!blob) throw new Error(`Your browser cannot export ${mime}.`);
  return blob;
}

function detectPlatform(raw: string) {
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be') return 'YouTube';
    if (host.includes('instagram.com')) return 'Instagram';
    if (host.includes('tiktok.com')) return 'TikTok';
    if (host.includes('facebook.com') || host.includes('fb.watch')) return 'Facebook';
    if (host === 'x.com' || host.includes('twitter.com')) return 'X / Twitter';
    if (host.includes('vimeo.com')) return 'Vimeo';
    if (host.includes('reddit.com')) return 'Reddit';
    if (host.includes('pinterest.')) return 'Pinterest';
    if (host.includes('snapchat.com')) return 'Snapchat';
    return host || 'Link';
  } catch {
    return 'Paste a link';
  }
}

function UploadBox({ title, copy, foot, onFile }: { title: string; copy: string; foot: string; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <div
      className={`dropzone ${drag ? 'drag' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
    >
      <input ref={inputRef} hidden type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
      <div className="dropinner">
        <div className="dropicon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" /></svg>
        </div>
        <h2>{title}</h2>
        <p>{copy}</p>
        <span className="choose">CHOOSE IMAGE ↗</span>
        <small>{foot}</small>
      </div>
    </div>
  );
}

function RemoveTool() {
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const [preview, setPreview] = useState('');
  const [result, setResult] = useState('');
  const [quality, setQuality] = useState<BgQuality>('ultra');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result); }, [result]);

  async function choose(next: File) {
    setError('');
    try {
      const m = await validateImage(next);
      if (preview) URL.revokeObjectURL(preview);
      if (result) URL.revokeObjectURL(result);
      setFile(next); setMeta(m); setPreview(URL.createObjectURL(next)); setResult('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open this image.'); }
  }

  async function remove() {
    if (!file) return;
    if (!IMAGE_API) {
      setError('Cloud image worker is not connected yet. Add NEXT_PUBLIC_IMAGE_API_URL in Vercel after deploying the included image worker.');
      return;
    }
    setBusy(true); setError('');
    const form = new FormData();
    form.append('file', file);
    form.append('quality', quality);
    try {
      const res = await fetch(`${IMAGE_API}/remove-background`, { method: 'POST', body: form });
      if (!res.ok) {
        let msg = `Background removal failed (${res.status}).`;
        try { const data = await res.json(); msg = data.detail || msg; } catch {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (result) URL.revokeObjectURL(result);
      setResult(URL.createObjectURL(blob));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The cloud image worker could not be reached.');
    } finally { setBusy(false); }
  }

  function download() {
    if (!result || !file) return;
    const a = document.createElement('a');
    a.href = result;
    a.download = `${file.name.replace(/\.[^.]+$/, '')}-stac-bg.png`;
    a.click();
  }

  if (!file) {
    return (
      <>
        <section className="stage"><UploadBox title="Remove background" copy="Drop or choose an image." foot="JPG · PNG · WEBP · UP TO 100 MP" onFile={choose} /></section>
        <aside className="panel">
          <div className="panelgroup"><h3>OUTPUT</h3><div className="fileline"><div><b>Transparent PNG</b><small>Original pixel dimensions</small></div><span className="label">PNG</span></div></div>
          <div className="panelgroup"><h3>QUALITY</h3><div className="segmented">{(['fast','hd','ultra'] as BgQuality[]).map(q => <button key={q} className={quality===q?'active':''} onClick={() => setQuality(q)}>{q.toUpperCase()}</button>)}</div></div>
          {error && <div className="error">{error}</div>}
        </aside>
      </>
    );
  }

  return (
    <>
      <section className="stage">
        <div className="stagehead"><div><span className="label">PREVIEW</span><strong>{file.name}</strong></div><button className="textbtn" onClick={() => { setFile(null); setMeta(null); setPreview(''); setResult(''); }}>Replace image</button></div>
        <div className="previewbox">
          <img src={result || preview} alt={result ? 'Background removed result' : 'Original upload'} />
          {busy && <div className="overlay"><div><div className="spinner"/><strong>Removing background</strong><span>{quality.toUpperCase()}</span></div></div>}
        </div>
      </section>
      <aside className="panel">
        <div className="panelgroup"><h3>SOURCE</h3><div className="stats"><div className="stat"><span>RES</span><b>{meta ? `${meta.width}×${meta.height}` : '—'}</b></div><div className="stat"><span>SIZE</span><b>{prettyBytes(file.size)}</b></div><div className="stat"><span>TYPE</span><b>{fileFormat(file)}</b></div></div></div>
        <div className="panelgroup"><h3>QUALITY</h3><div className="segmented">{(['fast','hd','ultra'] as BgQuality[]).map(q => <button key={q} className={quality===q?'active':''} onClick={() => setQuality(q)}>{q.toUpperCase()}</button>)}</div></div>
        <div className="panelgroup"><h3>OUTPUT</h3><div className="fileline"><div><b>Transparent PNG</b><small>{meta ? `${meta.width} × ${meta.height} · lossless` : 'Original resolution'}</small></div><span className="label">1:1</span></div></div>
        {!result ? <button className="action" disabled={busy} onClick={remove}><span>REMOVE BACKGROUND</span><span>↗</span></button> : <><button className="action orange" onClick={download}><span>DOWNLOAD FULL SIZE</span><span>↓</span></button><button className="secondary" onClick={remove}><span>Run again</span><span>↻</span></button></>}
        {error && <div className="error">{error}</div>}
      </aside>
    </>
  );
}

const formatInfo: Record<ConvertFormat, { label: string; sub: string; ext: string }> = {
  png:{label:'PNG',sub:'Lossless',ext:'png'}, jpg:{label:'JPG',sub:'Photo',ext:'jpg'}, webp:{label:'WEBP',sub:'Web',ext:'webp'}, avif:{label:'AVIF',sub:'Compact',ext:'avif'},
  heic:{label:'HEIC',sub:'Apple',ext:'heic'}, tiff:{label:'TIFF',sub:'Print',ext:'tiff'}, bmp:{label:'BMP',sub:'Bitmap',ext:'bmp'}, gif:{label:'GIF',sub:'Legacy',ext:'gif'},
  ico:{label:'ICO',sub:'Icon',ext:'ico'}, svg:{label:'SVG',sub:'Vector trace',ext:'svg'}, pdf:{label:'PDF',sub:'Document',ext:'pdf'}
};

function ConvertTool() {
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
      if (preview) URL.revokeObjectURL(preview);
      setFile(next); setMeta(m); setPreview(URL.createObjectURL(next));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open this image.'); }
  }

  async function localConvert(target: ConvertFormat) {
    if (!file) throw new Error('Choose an image first.');
    if (target === 'svg') {
      // Vector tracing is intentionally capped to keep browser memory under control.
      const canvas = await drawFileToCanvas(file, 2200);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas is unavailable.');
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const svg = ImageTracer.imagedataToSVG(imgData, {
        ltres: 1, qtres: 1, pathomit: 8, colorsampling: 2, numberofcolors: 32,
        mincolorratio: 0.01, colorquantcycles: 3, scale: 1, strokewidth: 0
      });
      return new Blob([svg], { type: 'image/svg+xml' });
    }
    if (target === 'pdf') {
      const canvas = await drawFileToCanvas(file);
      const png = await canvasToBlob(canvas, 'image/png');
      const pngBytes = new Uint8Array(await png.arrayBuffer());
      const pdf = await PDFDocument.create();
      const embedded = await pdf.embedPng(pngBytes);
      const ratio = embedded.width / embedded.height;
      const max = 1600;
      const pageW = ratio >= 1 ? max : max * ratio;
      const pageH = ratio >= 1 ? max / ratio : max;
      const page = pdf.addPage([pageW, pageH]);
      page.drawImage(embedded, { x: 0, y: 0, width: pageW, height: pageH });
      return new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' });
    }
    const mime: Partial<Record<ConvertFormat,string>> = { png:'image/png', jpg:'image/jpeg', webp:'image/webp', avif:'image/avif' };
    const outMime = mime[target];
    if (!outMime) throw new Error('Cloud codec required.');
    const canvas = await drawFileToCanvas(file);
    const blob = await canvasToBlob(canvas, outMime, quality / 100);
    if (target === 'avif' && blob.type !== 'image/avif') throw new Error('Cloud codec required.');
    return blob;
  }

  async function cloudConvert(target: ConvertFormat) {
    if (!file) throw new Error('Choose an image first.');
    if (!IMAGE_API) throw new Error(`${formatInfo[target].label} needs the cloud image worker. Add NEXT_PUBLIC_IMAGE_API_URL in Vercel.`);
    const form = new FormData();
    form.append('file', file);
    form.append('format', target);
    form.append('quality', String(quality));
    const res = await fetch(`${IMAGE_API}/convert`, { method:'POST', body:form });
    if (!res.ok) {
      let msg = `Conversion failed (${res.status}).`;
      try { const data = await res.json(); msg = data.detail || msg; } catch {}
      throw new Error(msg);
    }
    return res.blob();
  }

  async function convert() {
    if (!file) return;
    setBusy(true); setError(''); setDone('');
    try {
      let blob: Blob;
      try { blob = await localConvert(format); }
      catch (e) {
        if (e instanceof Error && e.message === 'Cloud codec required.') blob = await cloudConvert(format);
        else throw e;
      }
      const base = file.name.replace(/\.[^.]+$/, '');
      downloadBlob(blob, `${base}-stac.${formatInfo[format].ext}`);
      setDone(`${formatInfo[format].label} created at ${meta?.width ?? 'original'} × ${meta?.height ?? 'resolution'}${format === 'svg' ? ' (traced vector paths)' : ''}.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Conversion failed.'); }
    finally { setBusy(false); }
  }

  if (!file) {
    return <><section className="stage"><UploadBox title="Convert image" copy="Drop or choose an image." foot="PNG · JPG · WEBP · AVIF · HEIC · TIFF · BMP · GIF · ICO · SVG · PDF" onFile={choose}/></section><aside className="panel"><div className="panelgroup"><h3>FORMATS</h3><div className="formatlist">PNG · JPG · WEBP · AVIF · HEIC · TIFF · BMP · GIF · ICO · SVG · PDF</div></div>{error&&<div className="error">{error}</div>}</aside></>;
  }

  return (
    <>
      <section className="stage">
        <div className="stagehead"><div><span className="label">SOURCE IMAGE</span><strong>{file.name}</strong></div><button className="textbtn" onClick={() => { setFile(null); setMeta(null); setPreview(''); setDone(''); }}>Replace image</button></div>
        <div className="previewbox"><img src={preview} alt="Image to convert"/>{busy&&<div className="overlay"><div><div className="spinner"/><strong>Converting to {formatInfo[format].label}</strong></div></div>}</div>
      </section>
      <aside className="panel">
        <div className="panelgroup"><h3>SOURCE</h3><div className="stats"><div className="stat"><span>RES</span><b>{meta?`${meta.width}×${meta.height}`:'—'}</b></div><div className="stat"><span>SIZE</span><b>{prettyBytes(file.size)}</b></div><div className="stat"><span>TYPE</span><b>{fileFormat(file)}</b></div></div></div>
        <div className="panelgroup"><h3>CONVERT TO</h3><div className="formatgrid">{(Object.keys(formatInfo) as ConvertFormat[]).map(f=><button key={f} className={`formatbtn ${format===f?'active':''}`} onClick={()=>setFormat(f)}><b>{formatInfo[f].label}</b><small>{formatInfo[f].sub}</small></button>)}</div></div>
        {!['png','svg','pdf'].includes(format) && <div className="panelgroup"><div className="rangehead"><span>QUALITY</span><b>{quality}%</b></div><input className="range" type="range" min="40" max="100" value={quality} onChange={e=>setQuality(Number(e.target.value))}/></div>}
        <button className="action" disabled={busy} onClick={convert}><span>CONVERT & DOWNLOAD</span><span>↓</span></button>
        {format==='svg'&&<div className="hint">SVG traces visible shapes into vector paths.</div>}
        {done&&<div className="success">{done}</div>}{error&&<div className="error">{error}</div>}
      </aside>
    </>
  );
}

function SaveTool() {
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState<'video'|'audio'|'image'>('video');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const platform = useMemo(() => detectPlatform(url), [url]);

  async function save() {
    setError('');
    try { new URL(url); } catch { setError('Paste a valid public media URL.'); return; }
    if (!MEDIA_API) { setError('Media worker is not connected yet. Deploy the included cloud media worker and add NEXT_PUBLIC_MEDIA_API_URL in Vercel.'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${MEDIA_API}/download`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ url, format })
      });
      if (!res.ok) {
        let msg = `Could not save this link (${res.status}).`;
        try { const data = await res.json(); msg = data.detail || msg; } catch {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^";]+)"?/i);
      const fallback = format==='audio'?'stac-audio.mp3':format==='image'?'stac-image.jpg':'stac-video.mp4';
      downloadBlob(blob, match?.[1] || fallback);
    } catch (e) { setError(e instanceof Error ? e.message : 'The media worker could not be reached.'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <section className="stage">
        <div className="stagehead"><div><span className="label">MEDIA LINK</span><strong>Paste a media URL</strong></div></div>
        <div style={{flex:1,display:'grid',alignContent:'center',maxWidth:760,margin:'0 auto',width:'100%'}}>
          <div className="urlbox"><input value={url} onChange={e=>setUrl(e.target.value)} placeholder="Paste YouTube, Instagram, TikTok, Facebook, X, Vimeo…"/><div className="platform">{platform}</div></div>
          <p className="inlinehint">Public links only. Private or DRM-protected media is not supported.</p>
        </div>
      </section>
      <aside className="panel">
        <div className="panelgroup"><h3>SAVE AS</h3><div className="segmented"><button className={format==='video'?'active':''} onClick={()=>setFormat('video')}>VIDEO</button><button className={format==='audio'?'active':''} onClick={()=>setFormat('audio')}>AUDIO</button><button className={format==='image'?'active':''} onClick={()=>setFormat('image')}>IMAGE</button></div></div>
        <div className="panelgroup"><h3>PLATFORM</h3><div className="fileline"><div><b>{platform}</b><small>{url ? 'Link detected' : 'Waiting for URL'}</small></div><span className="label">AUTO</span></div></div>
        <button className="action orange" disabled={busy||!url} onClick={save}><span>{busy?'FETCHING MEDIA':'SAVE MEDIA'}</span><span>↓</span></button>

        {error&&<div className="error">{error}</div>}
      </aside>
    </>
  );
}

export default function Toolkit() {
  const [tool, setTool] = useState<ToolKey>('remove');
  return (
    <main>
      <div className="shell">
        <header className="header" id="top">
          <a className="brand" href="#top" aria-label="STAC Tools home">
            <span className="brandlogo"><img src="/logo-stac.png" alt="STAC" /></span>
            <span className="brandcopy"><strong>STAC</strong><span>TOOLS</span></span>
          </a>
        </header>

        <nav className="toolnav" aria-label="STAC tools">
          <button className={`tooltab ${tool==='remove'?'active':''}`} onClick={()=>setTool('remove')}><b>BG REMOVER</b><small>PNG</small></button>
          <button className={`tooltab ${tool==='convert'?'active':''}`} onClick={()=>setTool('convert')}><b>CONVERTER</b><small>IMAGE</small></button>
          <button className={`tooltab ${tool==='save'?'active':''}`} onClick={()=>setTool('save')}><b>MEDIA SAVER</b><small>URL</small></button>
        </nav>

        <section className="workspace">{tool==='remove'?<RemoveTool/>:tool==='convert'?<ConvertTool/>:<SaveTool/>}</section>
      </div>
    </main>
  );
}
