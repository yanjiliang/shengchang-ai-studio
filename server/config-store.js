import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { validateProviderConfig } from './model-adapters.js';
import { llmRequiresApiKey } from './story-analyzer.js';
import { DEFAULT_ENGINE_CONCURRENCY, normalizeEngineConcurrency } from './breeze-lane.js';
import { activeTtsSettings, publicTtsProviders, redactHeaders, sanitizeTtsProviders } from './tts-providers.js';
import { BREEZE_DEFAULT_ENDPOINT, BREEZE_DEFAULT_TIMEOUT_MS, normalizeBreezeEndpoint, normalizeBreezeTimeout } from './breeze.js';

const CONFIG_DIR = path.join(homedir(), '.shengchang');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  // Demo on fresh installs (design A5): a stranger's first run — sample
  // project, 一键成片, direction lab — works offline with zero keys. Existing
  // installs keep whatever their config file says.
  provider: 'demo',
  endpoint: '',
  accessKey: '',
  resourceId: 'seed-tts-2.0',
  // The latest HTTP API only needs this for cloned voices. Official voices omit it.
  model: '',
  audioFormat: 'mp3',
  sampleRate: 24000,
  responseMode: 'auto',
  customHeaders: '{}',
  customBodyTemplate: '{"text":"{{text}}","voice_id":"{{voiceId}}","emotion":"{{emotion}}","speed":{{speed}}}',
  cacheLimitGb: 50,
  // 本地 Breeze-TTS-2 服务（provider: 'breeze'）。独立字段：切到 Breeze 不会
  // 覆盖豆包的 endpoint/accessKey，切回豆包只改 provider。
  breezeEndpoint: BREEZE_DEFAULT_ENDPOINT,
  breezeTimeoutMs: BREEZE_DEFAULT_TIMEOUT_MS,
  // 按引擎的并发（同时在飞的生成请求数）与单次请求超时。Breeze 的超时用上面的
  // breezeTimeoutMs；这里管豆包与自定义 HTTP。
  engineConcurrency: { ...DEFAULT_ENGINE_CONCURRENCY },
  engineTimeoutMs: { 'volcengine-api-key': 90_000, custom: 90_000 },
  // seed-tts-2.0 指令末尾追加“保持当前基础音色稳定”（见 model-adapters.js）。
  ttsStableSpeaker: true,
  targetLufs: -16,
  llmEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  llmApiKey: '',
  llmModel: '',
  llmSystemPrompt: '你是一位专业广播剧编剧和声音导演。忠于原作，不凭空新增关键剧情。',
  // Sound-effect / music-bed generation (SoundPicker 生成 tab). Independent of
  // the speech provider: different services, different request shapes.
  sfxProvider: 'demo',
  sfxEndpoint: '',
  sfxAccessKey: '',
  sfxModel: '',
  sfxCustomHeaders: '{}',
  sfxCustomBodyTemplate: '{"prompt":"{{prompt}}","duration":{{durationSec}}}',
};

export function sanitizeConfig(input = {}) {
  const config = { ...DEFAULT_CONFIG, ...input };
  const migratedLegacyProvider = ['byte-api-key', 'byte-v1', 'byte-v3'].includes(config.provider);
  const provider = migratedLegacyProvider
    ? 'volcengine-api-key'
    : String(config.provider || DEFAULT_CONFIG.provider);
  // TTS 按引擎分槽（tts-providers.js）。旧的平铺配置第一次读到时迁进对应槽；顶层平铺字段 = 当前引擎那一槽。
  const ttsProviders = sanitizeTtsProviders(migratedLegacyProvider ? { ...config, endpoint: '' } : config, provider);
  return {
    provider,
    ...activeTtsSettings({ provider, ttsProviders }),
    ttsProviders,
    cacheLimitGb: Number(config.cacheLimitGb) || 50,
    breezeEndpoint: normalizeBreezeEndpoint(config.breezeEndpoint) || BREEZE_DEFAULT_ENDPOINT,
    breezeTimeoutMs: normalizeBreezeTimeout(config.breezeTimeoutMs),
    engineConcurrency: normalizeEngineConcurrency(config.engineConcurrency),
    engineTimeoutMs: normalizeEngineTimeouts(config.engineTimeoutMs),
    ttsStableSpeaker: config.ttsStableSpeaker !== false && config.ttsStableSpeaker !== 'false',
    targetLufs: Number(config.targetLufs) || -16,
    llmEndpoint: String(config.llmEndpoint || DEFAULT_CONFIG.llmEndpoint),
    llmApiKey: String(config.llmApiKey || ''),
    llmModel: String(config.llmModel || ''),
    // 本地大模型拆一段 24k 字可能很慢：10 秒–30 分钟，默认 180 秒。
    llmTimeoutMs: Number.isInteger(Number(config.llmTimeoutMs)) && Number(config.llmTimeoutMs) >= 10_000 && Number(config.llmTimeoutMs) <= 1_800_000 ? Number(config.llmTimeoutMs) : 180_000,
    llmSystemPrompt: String(config.llmSystemPrompt || DEFAULT_CONFIG.llmSystemPrompt),
    sfxProvider: ['demo', 'custom'].includes(config.sfxProvider) ? config.sfxProvider : 'demo',
    sfxEndpoint: String(config.sfxEndpoint || ''),
    sfxAccessKey: String(config.sfxAccessKey || ''),
    sfxModel: String(config.sfxModel || ''),
    sfxCustomHeaders: String(config.sfxCustomHeaders || '{}'),
    sfxCustomBodyTemplate: String(config.sfxCustomBodyTemplate || DEFAULT_CONFIG.sfxCustomBodyTemplate),
  };
}

// 5s–900s；非法值回落 90s。
export function normalizeEngineTimeouts(input) {
  const source = input && typeof input === 'object' ? input : {};
  return Object.fromEntries(Object.entries(DEFAULT_CONFIG.engineTimeoutMs).map(([engine, fallback]) => {
    const value = Number(source[engine]);
    return [engine, Number.isFinite(value) && value >= 5_000 && value <= 900_000 ? Math.round(value) : fallback];
  }));
}

export async function readConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    return sanitizeConfig(JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_CONFIG };
    throw error;
  }
}

export async function writeConfig(input) {
  if (input?.breezeEndpoint !== undefined && !normalizeBreezeEndpoint(input.breezeEndpoint)) throw Object.assign(new Error('Breeze 服务地址无效：需要 http(s)://主机:端口 形式'), { status: 400 });
  const config = sanitizeConfig(input);
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const temporaryPath = `${CONFIG_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, CONFIG_PATH);
  await chmod(CONFIG_PATH, 0o600);
  return config;
}

// 已保存密钥的提示只露末 3 位（'···abc'）；短于 8 位的不露任何字符（'···'），未保存为 ''。
export function secretHint(secret) {
  const value = String(secret || '');
  if (!value) return '';
  return value.length >= 8 ? `···${value.slice(-3)}` : '···';
}

export function publicConfig(config) {
  const safeCustomHeaders = redactHeaders(config.customHeaders);
  // 音效请求头同样可能带 Authorization，之前原样回传给了浏览器。
  // voiceReady：前端判断“能不能开始生成”的唯一依据（Breeze 没有凭证也就绪）。
  let voiceReady = true;
  try { validateProviderConfig(config); } catch { voiceReady = false; }
  return {
    ...config,
    customHeaders: safeCustomHeaders,
    sfxCustomHeaders: redactHeaders(config.sfxCustomHeaders),
    accessKey: '',
    llmApiKey: '',
    sfxAccessKey: '',
    hasAccessKey: Boolean(config.accessKey),
    hasLlmApiKey: Boolean(config.llmApiKey),
    // 本地 OpenAI 兼容服务不需要 Key；方舟默认地址需要（前端据此决定是否提示必填）。
    llmApiKeyRequired: llmRequiresApiKey(config.llmEndpoint),
    hasSfxAccessKey: Boolean(config.sfxAccessKey),
    voiceReady,
    llmSecretHint: secretHint(config.llmApiKey),
    secretHint: secretHint(config.accessKey),
    sfxSecretHint: secretHint(config.sfxAccessKey),
    // 每个语音引擎各自保存的设置摘要：不含 Key 值，请求头密钥打码。
    ttsProviders: publicTtsProviders(config.ttsProviders, secretHint),
    configPath: CONFIG_PATH,
  };
}
