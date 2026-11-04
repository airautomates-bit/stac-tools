'use client';

import { useEffect, useRef, useState } from 'react';
import { IMAGE_API } from '@/lib/config';
import { baseName, downloadBlob, errorMessage, fileFormat, networkError, prettyBytes, validateImage, type ImageMeta } from '@/lib/utils';
import UploadBox from './UploadBox';
import { IconDownload, IconRefresh } from './icons';

type BgQuality = 'fast' | 'hd' | 'ultra';
const QUALITY: { key: BgQuality; label: string; sub: string }[] = [
  { key: 'fast', label: 'Fast', sub: 'Quick cut' },
  { key: 'hd', label: 'HD', sub: 'Balanced' },
  { key: 'ultra', label: 'Ultra', sub: 'Finest edges' },
];

export default function RemoveTool() {
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<ImageMeta | null>(null);
  const [preview, setPreview] = useState('');
  const [result, setResult] = useState<{ url: string; blob: Blob } | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [quality, setQuality] = useState<BgQuality>('ultra');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
  useEffect(() => () => abortRef.current?.abort(), []);

  async function choose(next: File) {
    setError('');
    try {
      const m = await validateImage(next);
      abortRef.current?.abort();
      setFile(next); setMeta(m); setPreview(URL.createObjectURL(next)); setResult(null); setShowOriginal(false); setBusy(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open this image.'); }
  }

  function reset() {
    abortRef.current?.abort();
    setFile(null); setMeta(null); setPreview(''); setResult(null); setBusy(false); setError('');
  }

  async function remove() {
    if (!file || busy) return;
    setBusy(true); setError('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const form = new FormData();
    form.append('file', file);
    form.append('quality', quality);
    try {
      const res = await fetch(`${IMAGE_API}/remove-background`, { method: 'POST', body: form, signal: ctrl.signal });
      if (!res.ok) throw new Error(await errorMessage(res, `Background removal failed (${res.status}).`));
      const blob = await res.blob();
      setResult({ url: URL.createObjectURL(blob), blob });
      setShowOriginal(false);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(networkError(e, 'Background removal failed.'));
    } finally {
      if (abortRef.current === ctrl) setBusy(false);
    }
  }

  const qualityPicker = (
    <div className="block">
      <h3>Quality</h3>
      <div className="choicegrid three">
        {QUALITY.map((q) => (
          <button key={q.key} className={`choice ${quality === q.key ? 'active' : ''}`} onClick={() => setQuality(q.key)} aria-pressed={quality === q.key}>
            <b>{q.label}</b><small>{q.sub}</small>
          </button>
        ))}
      </div>
    </div>
  );

  if (!file) {
    return (
      <div className="toolgrid">
        <section className="card stage"><UploadBox title="Drop an image here" copy="We'll cut out the subject and keep every pixel of the original resolution." foot="JPG · PNG · WEBP · up to 100 MP" onFile={choose} /></section>
        <aside className="card panel">
          <div className="block tinted lilac"><h3>Output</h3><div className="fileline"><div><b>Transparent PNG</b><small>Same width and height as your upload</small></div><span className="tag">PNG</span></div></div>
          {qualityPicker}
          {error && <div className="notice error" role="alert">{error}</div>}
        </aside>
      </div>
    );
  }

  const shown = result && !showOriginal ? result.url : preview;

  return (
    <div className="toolgrid">
      <section className="card stage">
        <div className="stagehead">
          <div><span className="eyebrow">{result ? 'Result' : 'Preview'}</span><strong title={file.name}>{file.name}</strong></div>
          <div className="row">
            {result && <button className="pill ghost small" onClick={() => setShowOriginal((v) => !v)}>{showOriginal ? 'Show result' : 'Show original'}</button>}
            <button className="pill ghost small" onClick={reset}>Replace image</button>
          </div>
        </div>
        <div className={`previewbox ${result && !showOriginal ? 'checker' : ''}`}>
          <img src={shown} alt={result && !showOriginal ? 'Background removed' : 'Original upload'} />
          {busy && <div className="overlay"><div><div className="spinner" /><strong>Removing background</strong><span>{quality.toUpperCase()} · usually 5–20 seconds</span></div></div>}
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
        {qualityPicker}
        <div className="block tinted sky"><h3>Output</h3><div className="fileline"><div><b>Transparent PNG</b><small>{meta ? `${meta.width} × ${meta.height} · lossless` : 'Original resolution'}</small></div><span className="tag">1:1</span></div></div>
        {!result ? (
          <button className="action" disabled={busy} onClick={remove}>{busy ? 'Working…' : 'Remove background'}<span className="actionicon">→</span></button>
        ) : (
          <>
            <button className="action accent" onClick={() => downloadBlob(result.blob, `${baseName(file)}-stac-bg.png`)}>Download full size<span className="actionicon"><IconDownload /></span></button>
            <button className="pill ghost wide" disabled={busy} onClick={remove}><IconRefresh width={16} height={16} /> Run again with {quality.toUpperCase()}</button>
          </>
        )}
        {error && <div className="notice error" role="alert">{error}</div>}
      </aside>
    </div>
  );
}
