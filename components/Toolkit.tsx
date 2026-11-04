'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { PLATFORMS, PLATFORM_BY_KEY, TOOL_KEYS, type PlatformKey, type ToolKey } from '@/lib/tools';
import RemoveTool from './RemoveTool';
import ConvertTool from './ConvertTool';
import Downloader from './Downloader';
import { PlatformIcon } from './PlatformIcon';
import { IconArrow, IconConvert, IconEraser, IconHome, IconShield } from './icons';

const IMAGE_TOOLS = [
  { key: 'remove' as const, name: 'Background remover', short: 'BG remover', icon: IconEraser, tint: 'sky', ink: '#1889be', copy: 'Cut out any subject at full resolution with clean, detailed edges.', tags: ['Transparent PNG', 'Up to 100 MP'] },
  { key: 'convert' as const, name: 'Image converter', short: 'Converter', icon: IconConvert, tint: 'peach', ink: '#f85800', copy: 'Convert between 11 formats, including HEIC, AVIF and vector SVG.', tags: ['11 formats', 'Mostly on-device'] },
];

const TITLES: Record<ToolKey, { title: string; sub: string }> = {
  home: { title: 'Discover tools', sub: 'Edit images and save media from your favourite platforms — all in one place.' },
  remove: { title: 'Background remover', sub: 'Full-resolution cut-outs powered by our GPU model.' },
  convert: { title: 'Image converter', sub: 'PNG, JPG, WEBP, AVIF, HEIC, TIFF, BMP, GIF, ICO, SVG and PDF.' },
  youtube: { title: 'YouTube', sub: 'Videos and Shorts as MP4 or MP3.' },
  instagram: { title: 'Instagram', sub: 'Reels, videos, photos and carousels.' },
  pinterest: { title: 'Pinterest', sub: 'Video pins and image pins.' },
  facebook: { title: 'Facebook', sub: 'Videos and reels.' },
  x: { title: 'X / Twitter', sub: 'Videos, GIFs and photos.' },
  threads: { title: 'Threads', sub: 'Videos and photos.' },
};

function readHash(): ToolKey {
  const h = window.location.hash.replace('#', '') as ToolKey;
  return TOOL_KEYS.includes(h) ? h : 'home';
}

export default function Toolkit() {
  const [tool, setTool] = useState<ToolKey>('home');
  const [carryUrl, setCarryUrl] = useState('');

  useEffect(() => {
    setTool(readHash());
    const onHash = () => { setCarryUrl(''); setTool(readHash()); };
    window.addEventListener('popstate', onHash);
    window.addEventListener('hashchange', onHash);
    return () => { window.removeEventListener('popstate', onHash); window.removeEventListener('hashchange', onHash); };
  }, []);

  const go = useCallback((key: ToolKey, url = '') => {
    setCarryUrl(url);
    setTool(key);
    const target = key === 'home' ? window.location.pathname : `#${key}`;
    if ((key === 'home' && window.location.hash) || (key !== 'home' && window.location.hash !== `#${key}`)) history.pushState(null, '', target);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const navItem = (key: ToolKey, label: string, icon: ReactNode, tint?: string) => (
    <button key={key} className={`navitem ${tool === key ? 'active' : ''}`} onClick={() => go(key)} aria-current={tool === key ? 'page' : undefined}>
      <span className={`navicon ${tint || ''}`}>{icon}</span>
      <span>{label}</span>
    </button>
  );

  const platform = PLATFORM_BY_KEY[tool as PlatformKey];

  return (
    <div className="app">
      <aside className="sidebar card">
        <button className="brand" onClick={() => go('home')} aria-label="STAC Tools home">
          <span className="brandlogo"><img src="/logo-stac.png" alt="" /></span>
          <span className="brandcopy"><strong>STAC</strong><span>Tools</span></span>
        </button>
        <nav className="nav" aria-label="Tools">
          {navItem('home', 'Home', <IconHome />)}
          <span className="navlabel">Image studio</span>
          {IMAGE_TOOLS.map((t) => navItem(t.key, t.short, <t.icon />, t.tint))}
          <span className="navlabel">Downloaders</span>
          {PLATFORMS.map((p) => navItem(p.key, p.nav, <PlatformIcon platform={p.key} />, p.tint))}
        </nav>
        <div className="sidenote">
          <IconShield width={22} height={22} />
          <b>Private by design</b>
          <p>Files are processed and discarded. Nothing is stored or shared.</p>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>{TITLES[tool].title}</h1>
            <p>{TITLES[tool].sub}</p>
          </div>
          <span className="statuschip"><span className="dot" />Free · No sign-up</span>
        </header>

        {tool === 'home' && (
          <div className="home">
            <section className="homegrid">
              {IMAGE_TOOLS.map((t) => (
                <button key={t.key} className={`card feature ${t.tint}`} onClick={() => go(t.key)}>
                  <span className="featureicon" style={{ color: t.ink }}><t.icon width={26} height={26} /></span>
                  <span className="featurearrow"><IconArrow width={18} height={18} /></span>
                  <h2>{t.name}</h2>
                  <p>{t.copy}</p>
                  <span className="taglist">{t.tags.map((x) => <span key={x} className="tag white">{x}</span>)}</span>
                </button>
              ))}
            </section>
            <section className="card">
              <div className="sectionhead"><span className="eyebrow">Downloaders</span><h2>Save from your favourite platforms</h2></div>
              <div className="platformgrid">
                {PLATFORMS.map((p) => (
                  <button key={p.key} className={`platformcard ${p.tint}`} onClick={() => go(p.key)}>
                    <span className="platformtile" style={{ color: p.ink }}><PlatformIcon platform={p.key} width={24} height={24} /></span>
                    <b>{p.name}{p.beta && <span className="beta">Beta</span>}</b>
                    <small>{p.chips.slice(0, 3).join(' · ')}</small>
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}
        {tool === 'remove' && <RemoveTool />}
        {tool === 'convert' && <ConvertTool />}
        {platform && <Downloader key={platform.key} platform={platform} initialUrl={carryUrl} onSwitch={go} />}

        <footer className="footer">© STAC Tools · Only download content you own or have permission to use.</footer>
      </main>
    </div>
  );
}
