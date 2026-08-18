const bars = [8, 15, 10, 19, 7, 13, 21, 9, 17, 6, 12, 18, 8, 16, 22, 11, 14, 7, 18, 10, 20, 8, 13, 17, 9, 15, 21, 7, 12, 19, 10, 16, 8, 14, 20, 9, 17, 11, 18, 7, 13, 20, 8, 16, 11, 19, 7, 14];

export function Waveform({ color = 'var(--color-mint)' }) {
  return (
    <span className="mini-wave" aria-hidden="true">
      {bars.map((height, index) => <i key={`${height}-${index}`} style={{ height, backgroundColor: color }} />)}
    </span>
  );
}
