import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeDuration, runtimePaths } from './media-store.js';

const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'builtin-assets');

let manifestCache = null;
// assetId (builtin-<id>) -> manifest entry + media url; filled by ensureBuiltinAssets.
let registered = null;

async function loadManifest() {
  manifestCache ||= JSON.parse(await readFile(path.join(BUILTIN_DIR, 'manifest.json'), 'utf8'));
  const ids = new Set();
  for (const asset of manifestCache.assets) {
    if (!asset.id || !asset.file || ids.has(asset.id)) throw new Error(`内置素材清单存在缺失或重复的 id: ${asset.id}`);
    if (!['ambient', 'sfx', 'music'].includes(asset.type)) throw new Error(`内置素材 ${asset.id} 类型非法`);
    if (asset.file.includes('..') || !/^(ambient|sfx|music)\/[\w.-]+$/.test(asset.file)) throw new Error(`内置素材 ${asset.id} 文件路径非法: ${asset.file}`);
    ids.add(asset.id);
  }
  return manifestCache;
}

// Builtin clips are read-only shared assets: boot copies each manifest file
// into MEDIA_DIR as builtin-<id>.mp3 so probing, peaks, rendering, and the
// static /media route all treat them like any other audio file — no special
// casing inside media-store. Files are copied only when missing, so replacing
// a manifest entry + re-running the build script upgrades an install.
export async function ensureBuiltinAssets() {
  if (registered) return registered;
  const manifest = await loadManifest();
  await mkdir(runtimePaths.MEDIA_DIR, { recursive: true });
  const entries = [];
  for (const asset of manifest.assets) {
    const source = path.join(BUILTIN_DIR, asset.file);
    const filename = `builtin-${asset.id}.mp3`;
    const target = path.join(runtimePaths.MEDIA_DIR, filename);
    try { await stat(target); } catch { await copyFile(source, target); }
    let durationMs = Math.round(asset.durationSec * 1000);
    try { durationMs = Math.round((await probeDuration(target)) * 1000); } catch { /* fall back to manifest duration */ }
    entries.push({
      id: `builtin-${asset.id}`,
      name: asset.name,
      type: asset.type,
      tags: asset.tags || [],
      mood: asset.mood || '',
      loop: Boolean(asset.loop),
      durationMs,
      url: `/media/${filename}`,
      source: 'builtin',
      license: 'CC0',
      origin: manifest.origin || 'synthesized',
    });
  }
  registered = new Map(entries.map((entry) => [entry.id, entry]));
  return registered;
}

export async function listBuiltinAssets() {
  const index = await ensureBuiltinAssets();
  return [...index.values()];
}

export async function builtinAssetById(id) {
  const index = await ensureBuiltinAssets();
  return index.get(id) || null;
}
