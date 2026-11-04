'use client';

import { useRef, useState } from 'react';
import { IconUpload } from './icons';

export default function UploadBox({ title, copy, foot, accept = 'image/*', onFile }: {
  title: string; copy: string; foot: string; accept?: string; onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const open = () => inputRef.current?.click();
  return (
    <div
      className={`dropzone ${drag ? 'drag' : ''}`}
      onClick={open}
      onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}
      role="button"
      tabIndex={0}
      aria-label={`${title}: choose an image`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
    >
      <input ref={inputRef} hidden type="file" accept={accept} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      <div className="dropinner">
        <div className="dropicon"><IconUpload width={26} height={26} /></div>
        <h2>{title}</h2>
        <p>{copy}</p>
        <span className="pill dark">Choose image</span>
        <small>{foot}</small>
      </div>
    </div>
  );
}
