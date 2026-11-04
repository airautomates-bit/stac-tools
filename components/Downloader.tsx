'use client';

import { useRef, useState, type FormEvent } from 'react';
import { MEDIA_API } from '@/lib/config';
import { PLATFORM_BY_KEY, detectPlatform, type PlatformInfo, type PlatformKey } from '@/lib/tools';
import { downloadBlob, errorMessage, filenameFromResponse, formatDuration, networkError } from '@/lib/utils';
import { PlatformIcon } from './PlatformIcon';
import { IconDownload, IconImage, IconMusic, IconPaste, IconPlay, IconClose } from './icons';

type MediaItem = { index: number; kind: 'video' | 'image'; thumb: string | null; width?: number | null; height?: number | null; duration?: number | null };
type Resolved = { platform: PlatformKey; title: string; author: string; items: MediaItem[]; url: string };

const article = (name: string) => (/^([AEIOU]|X\b)/i.test(name) ? 'an' : 'a');

const STEPS = [
  { n: '1', title: 'Copy the link', copy: 'Tap Share → Copy link on the post, reel or video.', tint: 'lilac' },
  { n: '2', title: 'Paste it above', copy: 'We find every photo and video in the post.', tint: 'peach' },
  { n: '3', title: 'Download', copy: 'Save the original file, or just the audio as MP3.', tint: 'mint' },
];

/** Only allow data: image URLs produced by our worker as thumbnails. */
function safeThumb(src: string | null) {
  return src && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : null;
}

export default function Downloader({ platform, initialUrl = '', onSwitch }: { platform: PlatformInfo; initialUrl?: string; onSwitch: (key: PlatformKey, url: string) => void }) {
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Resolved | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [itemError, setItemError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const detected = detectPlatform(url);
  const mismatch = detected && detected !== platform.key ? PLATFORM_BY_KEY[detected] : null;

  async function paste() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) { setUrl(text.slice(0, 2048)); setError(''); }
    } catch { inputRef.current?.focus(); }
  }

  async function fetchLink(e?: FormEvent) {
    e?.preventDefault();
    const value = url.trim();
    if (busy) return;
    if (!value) { setError(`Paste ${article(platform.name)} ${platform.name} link first.`); return; }
    if (!detected) { setError('That link isn\'t from Instagram, Pinterest, Facebook, X or Threads.'); return; }
    if (mismatch) { setError(`That's ${article(mismatch.name)} ${mismatch.name} link — switch to the ${mismatch.nav} downloader.`); return; }
    setBusy(true); setError(''); setResult(null); setItemError('');
    try {
      const res = await fetch(`${MEDIA_API}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: value }) });
      if (!res.ok) throw new Error(await errorMessage(res, `Couldn't read this link (${res.status}).`));
      const data = await res.json();
      const items: MediaItem[] = Array.isArray(data?.items) ? data.items.filter((i: MediaItem) => i && (i.kind === 'video' || i.kind === 'image') && Number.isInteger(i.index)) : [];
      if (!items.length) throw new Error('No photos or videos found in this post.');
      setResult({ platform: platform.key, title: String(data.title || ''), author: String(data.author || ''), items, url: value });
    } catch (err) {
      setError(networkError(err, 'Couldn\'t read this link.'));
    } finally { setBusy(false); }
  }

  async function save(item: MediaItem, audio: boolean) {
    if (!result) return;
    const key = `${item.index}-${audio}`;
    if (pending[key]) return;
    setPending((p) => ({ ...p, [key]: true })); setItemError('');
    try {
      const res = await fetch(`${MEDIA_API}/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: result.url, index: item.index, audio }) });
      if (!res.ok) throw new Error(await errorMessage(res, `Download failed (${res.status}).`));
      const blob = await res.blob();
      const fallback = `stac-${result.platform}-${item.index + 1}.${audio ? 'mp3' : item.kind === 'video' ? 'mp4' : 'jpg'}`;
      downloadBlob(blob, filenameFromResponse(res, fallback));
    } catch (err) {
      setItemError(networkError(err, 'Download failed.'));
    } finally { setPending((p) => { const n = { ...p }; delete n[key]; return n; }); }
  }

  async function saveAll() {
    if (!result) return;
    for (const item of result.items) await save(item, false);
  }

  const anyPending = Object.keys(pending).length > 0;

  return (
    <div className="dl">
      <section className={`card hero ${platform.tint}`}>
        <div className="herotop">
          <div className="platformtile" style={{ color: platform.ink }}><PlatformIcon platform={platform.key} width={30} height={30} /></div>
          <div>
            <h2>{platform.title}{platform.beta && <span className="beta">Beta</span>}</h2>
            <p>{platform.blurb}</p>
          </div>
        </div>
        <div className="taglist">{platform.chips.map((c) => <span key={c} className="tag white">{c}</span>)}</div>
        <form className="urlbar" onSubmit={fetchLink}>
          <input
            ref={inputRef}
            value={url}
            onChange={(e) => { setUrl(e.target.value.slice(0, 2048)); setError(''); }}
            placeholder={platform.placeholder}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${platform.name} link`}
          />
          {url ? (
            <button type="button" className="iconbtn" onClick={() => { setUrl(''); setResult(null); setError(''); inputRef.current?.focus(); }} aria-label="Clear link"><IconClose width={18} height={18} /></button>
          ) : (
            <button type="button" className="iconbtn" onClick={paste} aria-label="Paste from clipboard"><IconPaste width={18} height={18} /><span className="hide-sm">Paste</span></button>
          )}
          <button type="submit" className="pill dark" disabled={busy}>{busy ? 'Fetching…' : 'Fetch'}</button>
        </form>
        {mismatch && !error && (
          <div className="notice info">
            This is {article(mismatch.name)} {mismatch.name} link. <button className="linkbtn" onClick={() => onSwitch(mismatch.key, url.trim())}>Open the {mismatch.nav} downloader →</button>
          </div>
        )}
        {error && <div className="notice error" role="alert">{error}</div>}
        <p className="fineprint">Public posts only. Please download only content you own or have permission to use.</p>
      </section>

      {busy && (
        <section className="card results">
          <div className="resultshead"><div><span className="eyebrow">Looking up</span><strong>Finding photos and videos…</strong></div></div>
          <div className="mediagrid">{[0, 1, 2].map((i) => <div key={i} className="mediacard skeleton"><div className="thumb" /><div className="line" /><div className="line short" /></div>)}</div>
        </section>
      )}

      {result && !busy && (
        <section className="card results">
          <div className="resultshead">
            <div>
              <span className="eyebrow">{result.items.length} {result.items.length === 1 ? 'item' : 'items'} found</span>
              <strong>{result.author ? `@${result.author.replace(/^@/, '')}` : PLATFORM_BY_KEY[result.platform].name}</strong>
              {result.title && <p className="muted small clamp">{result.title}</p>}
            </div>
            {result.items.length > 1 && <button className="pill dark" disabled={anyPending} onClick={saveAll}><IconDownload width={16} height={16} /> Download all</button>}
          </div>
          {itemError && <div className="notice error" role="alert">{itemError}</div>}
          <div className="mediagrid">
            {result.items.map((item) => {
              const thumb = safeThumb(item.thumb);
              const ratio = item.width && item.height ? `${item.width} / ${item.height}` : item.kind === 'video' ? '9 / 16' : '1 / 1';
              const busyVideo = pending[`${item.index}-false`];
              const busyAudio = pending[`${item.index}-true`];
              return (
                <article key={item.index} className="mediacard">
                  <div className="thumb" style={{ aspectRatio: ratio }}>
                    {thumb ? <img src={thumb} alt={`${item.kind === 'video' ? 'Video' : 'Photo'} ${item.index + 1}`} loading="lazy" /> : <div className="thumbfallback"><IconImage width={28} height={28} /></div>}
                    <span className={`kind ${item.kind}`}>{item.kind === 'video' ? <><IconPlay width={12} height={12} /> Video{item.duration ? ` · ${formatDuration(item.duration)}` : ''}</> : 'Photo'}</span>
                    {result.items.length > 1 && <span className="count">{item.index + 1}/{result.items.length}</span>}
                  </div>
                  <div className="mediameta">
                    <small className="muted">{item.width && item.height ? `${item.width} × ${item.height}` : item.kind === 'video' ? 'Best available quality' : 'Original size'}</small>
                    <div className="row">
                      <button className="pill dark small grow" disabled={busyVideo} onClick={() => save(item, false)}>
                        {busyVideo ? <span className="spinner tiny" /> : <IconDownload width={15} height={15} />} {item.kind === 'video' ? 'MP4' : 'Save photo'}
                      </button>
                      {item.kind === 'video' && (
                        <button className="pill ghost small" disabled={busyAudio} onClick={() => save(item, true)} aria-label="Download audio as MP3">
                          {busyAudio ? <span className="spinner tiny" /> : <IconMusic width={15} height={15} />} MP3
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {!result && !busy && (
        <section className="steps">
          {STEPS.map((s) => (
            <div key={s.n} className={`card step ${s.tint}`}>
              <span className="stepnum">{s.n}</span>
              <b>{s.title}</b>
              <p>{s.copy}</p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
