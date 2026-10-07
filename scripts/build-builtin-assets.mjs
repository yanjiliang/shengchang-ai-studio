// Renders the built-in asset library from manifest.json. Every clip is
// synthesized in-repo (ffmpeg expression sources), so the library ships with a
// clean license and zero external dependencies. Replace a file + manifest
// entry to swap in curated CC0 material later; re-run with --force to
// re-render everything.
//
// Usage: node scripts/build-builtin-assets.mjs [--force]
import { spawn } from 'node:child_process';
import { mkdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_DIR = path.join(ROOT, 'server', 'builtin-assets');
const manifest = JSON.parse(await readFile(path.join(ASSET_DIR, 'manifest.json'), 'utf8'));
const force = process.argv.includes('--force');

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn('ffmpeg', ['-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-600)))));
});

const OUTPUT = ['-ar', '48000', '-ac', '2', '-codec:a', 'libmp3lame', '-b:a', '128k'];
const fade = (seconds, fadeIn = 1.5, fadeOut = 2) =>
  `afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${Math.max(0, seconds - fadeOut).toFixed(2)}:d=${fadeOut}`;
const stereo = 'aformat=sample_fmts=fltp:channel_layouts=stereo';

// One filtered lavfi input → mp3.
const single = (input, filters, seconds) => [
  ...input, '-t', String(seconds), '-filter_complex',
  `${filters},${fade(seconds)},${stereo}[a]`, '-map', '[a]', ...OUTPUT,
];
// Two filtered inputs mixed → mp3.
const dual = (inputA, filtersA, inputB, filtersB, seconds, weightB = 1) => [
  ...inputA, '-t', String(seconds), ...inputB, '-t', String(seconds), '-filter_complex',
  `[0:a]${filtersA},${stereo}[a];[1:a]${filtersB},volume=${weightB},${stereo}[b];[a][b]amix=inputs=2:duration=first:normalize=0,${fade(seconds)}[out]`,
  '-map', '[out]', ...OUTPUT,
];
const noise = (color, amplitude, seed) => ['-f', 'lavfi', '-i', `anoisesrc=color=${color}:amplitude=${amplitude}:seed=${seed}:sample_rate=48000`];
// Single quotes protect the commas inside the expression from the
// filtergraph parser (spawn passes args verbatim, so shell-style quoting is
// ffmpeg's own arg-level quoting here).
const expr = (expression) => ['-f', 'lavfi', '-i', `aevalsrc='(${expression})':s=48000`];

// Gated decaying tone: burst every `period` seconds.
const burst = (period, gate, decay, tone) => `if(between(mod(t,${period}),0,${gate}),exp(-${decay}*mod(t,${period}))*(${tone}),0)`;

const RECIPES = {
  'ambient-rain-light': () => single(noise('white', 0.3, 11), 'highpass=f=400,lowpass=f=2400,tremolo=f=0.3:d=0.15', 24),
  'ambient-rain-heavy': () => single(noise('white', 0.5, 23), 'highpass=f=200,lowpass=f=3200,tremolo=f=0.8:d=0.3', 24),
  'ambient-sea-waves': () => single(noise('pink', 0.6, 31), 'lowpass=f=900,tremolo=f=0.11:d=0.65', 28),
  'ambient-city-night': () => dual(
    noise('brown', 0.4, 7), 'lowpass=f=400',
    ['-f', 'lavfi', '-i', 'sine=frequency=55:sample_rate=48000'], 'volume=0.10', 24, 0.5,
  ),
  'ambient-forest': () => dual(
    noise('pink', 0.22, 41), 'lowpass=f=1200',
    expr(burst(3.7, 0.06, 40, '0.9*sin(2*PI*(2600+400*sin(2*PI*22*mod(t,3.7)))*t)')), 'highpass=f=1500', 28, 0.5,
  ),
  'ambient-fire': () => dual(
    noise('brown', 0.18, 53), 'lowpass=f=500',
    expr('if(lt(random(0),0.006),(random(1)*2-1),0)'), 'highpass=f=2000', 24, 0.9,
  ),
  'ambient-wind': () => single(noise('pink', 0.4, 67), 'highpass=f=80,lowpass=f=500,tremolo=f=0.1:d=0.55', 24),
  'ambient-room': () => dual(
    noise('brown', 0.14, 79), 'lowpass=f=260',
    ['-f', 'lavfi', '-i', 'sine=frequency=50:sample_rate=48000'], 'volume=0.06', 24, 0.5,
  ),
  'sfx-door-knock': () => single(expr(burst(1.1, 0.09, 26, 'sin(2*PI*90*t)+0.4*sin(2*PI*181*t)')), 'lowpass=f=900', 4),
  'sfx-door-creak': () => single(expr('0.22*sin(2*PI*(240+320*t)*t)*(0.6+0.4*sin(2*PI*7*t))'), 'highpass=f=150', 2.8),
  'sfx-footsteps': () => single(expr(burst(0.62, 0.16, 20, '2*(random(0)-0.5)*3')), 'highpass=f=400,lowpass=f=4000', 6),
  'sfx-whoosh': () => single(noise('white', 0.5, 97), 'highpass=f=400,lowpass=f=2400,tremolo=f=2:d=0.6', 2.6),
  'sfx-thunder': () => single(noise('brown', 0.9, 83), 'lowpass=f=260', 3),
  'sfx-glass-clink': () => single(expr(burst(0.55, 0.18, 32, '0.4*(sin(2*PI*2093*t)+sin(2*PI*2637*t))')), 'highpass=f=1200', 1.2),
  'sfx-crowd': () => single(noise('pink', 0.4, 59), 'lowpass=f=1200,tremolo=f=2.6:d=0.35,tremolo=f=0.9:d=0.4', 12),
  'sfx-heartbeat': () => single(expr(`if(between(mod(t,1),0,0.10),exp(-28*mod(t,1))*sin(2*PI*52*t),if(between(mod(t,1),0.22,0.30),0.7*exp(-30*mod(t,1))*sin(2*PI*48*t),0))`), 'lowpass=f=200', 10),
  'music-pad-suspense': () => single(expr('(0.55+0.45*sin(2*PI*0.06*t))*0.11*(sin(2*PI*110*t)+sin(2*PI*130.81*t)+sin(2*PI*164.81*t))'), 'lowpass=f=900', 28),
  'music-pad-warm': () => single(expr('(0.6+0.4*sin(2*PI*0.15*t))*0.10*(sin(2*PI*220*t)+sin(2*PI*277.18*t)+sin(2*PI*329.63*t))'), 'lowpass=f=1400', 28),
  'music-pad-sad': () => single(expr('(0.55+0.45*sin(2*PI*0.08*t))*0.10*(sin(2*PI*196*t)+sin(2*PI*233.08*t)+sin(2*PI*293.66*t))'), 'lowpass=f=1200', 28),
  'music-pulse-tension': () => single(expr(burst(0.5, 0.22, 9, '(0.8+0.2*sin(2*PI*4*t))*sin(2*PI*55*t)*1.6')), 'lowpass=f=400', 24),
};

let rendered = 0;
let skipped = 0;
for (const asset of manifest.assets) {
  const target = path.join(ASSET_DIR, asset.file);
  await mkdir(path.dirname(target), { recursive: true });
  if (!force) {
    try { await stat(target); skipped += 1; continue; } catch { /* render */ }
  }
  const recipe = RECIPES[asset.id];
  if (!recipe) throw new Error(`manifest 资产 ${asset.id} 没有对应的合成配方`);
  await run(['-y', ...recipe(), target]);
  rendered += 1;
  console.log(`✓ ${asset.id} → ${path.relative(ROOT, target)}`);
}
console.log(`内置素材库：${rendered} 条渲染，${skipped} 条已存在跳过（--force 重渲染）`);
