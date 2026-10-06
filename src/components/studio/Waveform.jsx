import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

// Real peaks extracted server-side by ffmpeg. Flat bars mean "no data yet"
// (loading, unreadable file, or nothing bound) — never a decorative fake shape.
export function Waveform({ color = 'var(--color-mint)', url }) {
  const [peaks, setPeaks] = useState(null);
  useEffect(() => {
    if (!url) { setPeaks(null); return undefined; }
    let active = true;
    api.mediaPeaks(url).then((payload) => { if (active) setPeaks(payload.peaks); }).catch(() => { if (active) setPeaks(null); });
    return () => { active = false; };
  }, [url]);
  return (
    <span className={`mini-wave${peaks ? '' : ' is-empty'}`} aria-hidden="true">
      {Array.from({ length: 48 }, (_, index) => <i key={index} style={{ height: peaks ? `${Math.max(12, Math.round((peaks[index] || 0) * 100))}%` : '6%', backgroundColor: color }} />)}
    </span>
  );
}
