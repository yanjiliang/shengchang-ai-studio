import test from 'node:test';
import assert from 'node:assert/strict';
import { hintText, savedKeyLabel, secretState, llmSecretState, providerSaved, ttsDraftFor, configForSave, maskHeaders, unmaskHeaders, SAVED_SECRET } from './secrets.js';
import { TTS_UI_PRESETS } from '../../shared/tts-presets.mjs';

test('提示只露末 3 位', () => {
  assert.equal(savedKeyLabel('···abc'), '已设置 ···abc');
  assert.equal(hintText('sk-••••xyz'), '···xyz');
  assert.equal(savedKeyLabel('···'), '已设置 ···');
  assert.equal(savedKeyLabel(''), '已设置');
});

test('地址按规范化比较：改了又没填新 Key → 提示重新填', () => {
  assert.deepEqual(secretState({ hasKey: true, hint: '···abc', savedEndpoint: 'https://a/x', draftEndpoint: 'https://a/x/', typedKey: '' }), { kept: true, label: '已设置 ···abc', reenter: false });
  assert.equal(secretState({ hasKey: true, savedEndpoint: 'https://a/x', draftEndpoint: 'https://b/x', typedKey: '' }).reenter, true);
  assert.equal(secretState({ hasKey: true, savedEndpoint: 'https://a/x', draftEndpoint: 'https://b/x', typedKey: 'new' }).reenter, false);
  assert.equal(llmSecretState({ hasKey: true, savedEndpoint: 'https://a/v1', draftEndpoint: 'https://a/v1/chat/completions', typedKey: '' }).kept, true);
  assert.equal(secretState({ hasKey: false, savedEndpoint: 'a', draftEndpoint: 'b' }).reenter, false);
});

test('语音配置适配层：老服务端只认当前保存的引擎', () => {
  const flat = { provider: 'volcengine-api-key', endpoint: 'https://o', hasAccessKey: true, secretHint: '···abc' };
  assert.equal(providerSaved(flat, 'volcengine-api-key').hint, '···abc');
  assert.equal(providerSaved(flat, 'custom'), null);
});

const config0035 = {
  provider: 'demo', endpoint: '', hasAccessKey: false, secretHint: '',
  ttsProviders: {
    demo: { endpoint: '', resourceId: 'demo', model: 'demo-voice-engine', audioFormat: 'wav', hasKey: false, secretHint: '' },
    'volcengine-api-key': { endpoint: '', resourceId: 'seed-icl-2.0', model: 'seed-tts-2.0-standard', audioFormat: 'mp3', customHeaders: '{}', hasKey: true, secretHint: '···abc' },
    breeze: { endpoint: '', hasKey: false, secretHint: '' },
    custom: { endpoint: 'https://tts.example/v1', customHeaders: JSON.stringify({ Authorization: SAVED_SECRET }), hasKey: false, secretHint: '' },
  },
};

test('0035：Demo 切到豆包，豆包自己的 Key 提示还在', () => {
  const draft = ttsDraftFor(config0035, 'volcengine-api-key', TTS_UI_PRESETS);
  assert.equal(draft.provider, 'volcengine-api-key');
  assert.equal(draft.endpoint, TTS_UI_PRESETS['volcengine-api-key'].endpoint); // 空地址 → 预设（官方默认）
  assert.equal(draft.resourceId, 'seed-icl-2.0'); // 用已保存的，不是预设
  const saved = providerSaved(config0035, 'volcengine-api-key');
  const state = secretState({ hasKey: saved.hasKey, hint: saved.hint, savedEndpoint: saved.endpoint || TTS_UI_PRESETS['volcengine-api-key'].endpoint, draftEndpoint: draft.endpoint, typedKey: draft.accessKey });
  assert.deepEqual(state, { kept: true, label: '已设置 ···abc', reenter: false });
  assert.equal(draft.accessKey, '');
});

test('0035：没保存过的引擎才用预设；自定义的请求头密钥原样带着', () => {
  assert.deepEqual(ttsDraftFor({ provider: 'demo' }, 'custom', TTS_UI_PRESETS), { provider: 'custom', ...TTS_UI_PRESETS.custom, accessKey: '' });
  assert.equal(ttsDraftFor(config0035, 'custom', TTS_UI_PRESETS).customHeaders, JSON.stringify({ Authorization: SAVED_SECRET }));
});

test('PUT 不带 ttsProviders 和只读字段', () => {
  const body = configForSave({ ...config0035, accessKey: 'k', llmModel: 'm' });
  assert.equal('ttsProviders' in body, false);
  assert.equal('hasAccessKey' in body, false);
  assert.equal(body.accessKey, 'k');
});

test('请求头里的已保存密钥：显示遮住，保存原样送回', () => {
  const saved = JSON.stringify({ Authorization: SAVED_SECRET, 'X-Trace': '1' });
  const shown = maskHeaders(saved);
  assert.ok(!shown.includes(SAVED_SECRET));
  assert.equal(unmaskHeaders(shown), saved);
});
