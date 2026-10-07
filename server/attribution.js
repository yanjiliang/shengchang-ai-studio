// Attribution/credits for an exported episode: every bound sound event's
// asset, grouped by source, so the creator knows exactly what they may
// publish and what they owe a credit line.

export function buildAttribution({ lines = [], assets = [], builtinIndex = new Map() } = {}) {
  const projectAssets = new Map(assets.map((asset) => [asset.id, asset]));
  const builtin = new Map();
  const uploads = new Map();
  const generated = new Map();
  for (const line of lines) {
    if (line.type === 'dialogue' || !line.assetId) continue;
    if (String(line.assetId).startsWith('builtin-')) {
      const asset = builtinIndex.get(line.assetId);
      if (asset) builtin.set(asset.id, asset);
      continue;
    }
    const asset = projectAssets.get(line.assetId);
    if (!asset) continue;
    if (asset.source === 'generated') generated.set(asset.id, asset);
    else uploads.set(asset.id, asset);
  }
  const sections = [];
  if (builtin.size) {
    sections.push([
      '内置素材（CC0，随声场分发，无需署名）',
      ...[...builtin.values()].map((asset) => `- ${asset.name}${asset.origin === 'synthesized' ? '（本仓库程序合成）' : ''}`),
    ].join('\n'));
  }
  if (generated.size) {
    sections.push([
      'AI 生成素材（按所用生成服务的条款使用）',
      ...[...generated.values()].map((asset) => `- ${asset.name}${asset.prompt ? ` · 生成描述：${asset.prompt}` : ''}${asset.provider ? ` · 服务：${asset.provider}` : ''}`),
    ].join('\n'));
  }
  if (uploads.size) {
    sections.push([
      '本地导入素材（授权由导入者自行保证）',
      ...[...uploads.values()].map((asset) => `- ${asset.name}`),
    ].join('\n'));
  }
  if (!sections.length) return '本片未使用任何声音素材（对白与人声以外的音频）。';
  return ['声场 · 整集来源清单', '', ...sections].join('\n');
}
