import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

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

function sanitizeConfig(input = {}) {
  const config = { ...DEFAULT_CONFIG, ...input };
  const migratedLegacyProvider = ['byte-api-key', 'byte-v1', 'byte-v3'].includes(config.provider);
  const provider = migratedLegacyProvider
    ? 'volcengine-api-key'
    : String(config.provider || DEFAULT_CONFIG.provider);
  const resourceId = provider === 'volcengine-api-key' && !['seed-tts-2.0', 'seed-icl-2.0'].includes(config.resourceId)
    ? DEFAULT_CONFIG.resourceId
    : String(config.resourceId || '');
  return {
    provider,
    endpoint: migratedLegacyProvider ? DEFAULT_CONFIG.endpoint : String(config.endpoint || DEFAULT_CONFIG.endpoint),
    accessKey: String(config.accessKey || ''),
    resourceId,
    model: provider === 'volcengine-api-key' ? (resourceId === 'seed-icl-2.0' ? 'seed-tts-2.0-standard' : '') : String(config.model || ''),
    audioFormat: ['mp3', 'wav', 'ogg_opus'].includes(config.audioFormat) ? config.audioFormat : 'mp3',
    sampleRate: Number(config.sampleRate) || 24000,
    responseMode: String(config.responseMode || 'auto'),
    customHeaders: String(config.customHeaders || '{}'),
    customBodyTemplate: String(config.customBodyTemplate || DEFAULT_CONFIG.customBodyTemplate),
    cacheLimitGb: Number(config.cacheLimitGb) || 50,
    ttsStableSpeaker: config.ttsStableSpeaker !== false && config.ttsStableSpeaker !== 'false',
    targetLufs: Number(config.targetLufs) || -16,
    llmEndpoint: String(config.llmEndpoint || DEFAULT_CONFIG.llmEndpoint),
    llmApiKey: String(config.llmApiKey || ''),
    llmModel: String(config.llmModel || ''),
    llmSystemPrompt: String(config.llmSystemPrompt || DEFAULT_CONFIG.llmSystemPrompt),
    sfxProvider: ['demo', 'custom'].includes(config.sfxProvider) ? config.sfxProvider : 'demo',
    sfxEndpoint: String(config.sfxEndpoint || ''),
    sfxAccessKey: String(config.sfxAccessKey || ''),
    sfxModel: String(config.sfxModel || ''),
    sfxCustomHeaders: String(config.sfxCustomHeaders || '{}'),
    sfxCustomBodyTemplate: String(config.sfxCustomBodyTemplate || DEFAULT_CONFIG.sfxCustomBodyTemplate),
  };
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
  const config = sanitizeConfig(input);
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const temporaryPath = `${CONFIG_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, CONFIG_PATH);
  await chmod(CONFIG_PATH, 0o600);
  return config;
}

export function publicConfig(config) {
  let safeCustomHeaders = config.customHeaders;
  const redactHeaders = (value) => {
    try {
      const parsed = JSON.parse(value || '{}');
      for (const key of Object.keys(parsed)) if (/authorization|token|key|secret/i.test(key)) parsed[key] = '__SAVED_SECRET__';
      return JSON.stringify(parsed, null, 2);
    } catch { return '{}'; }
  };
  safeCustomHeaders = redactHeaders(safeCustomHeaders);
  return {
    ...config,
    customHeaders: safeCustomHeaders,
    accessKey: '',
    llmApiKey: '',
    sfxAccessKey: '',
    hasAccessKey: Boolean(config.accessKey),
    hasLlmApiKey: Boolean(config.llmApiKey),
    hasSfxAccessKey: Boolean(config.sfxAccessKey),
    llmSecretHint: config.llmApiKey ? `${config.llmApiKey.slice(0, 3)}••••${config.llmApiKey.slice(-3)}` : '',
    secretHint: config.accessKey ? `${config.accessKey.slice(0, 3)}••••${config.accessKey.slice(-3)}` : '',
    configPath: CONFIG_PATH,
  };
}
