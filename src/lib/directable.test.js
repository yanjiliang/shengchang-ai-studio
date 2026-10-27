import test from 'node:test';
import assert from 'node:assert/strict';
import { castDirectableBanner, emotionDriftRisk, hasEmotionDirection, isVerifiedDirectable, sendsVoiceInstructions, voiceShortName } from './directable.js';

const tts2 = { provider: 'volcengine-api-key', resourceId: 'seed-tts-2.0' };

test('isVerifiedDirectable：只认 server/directable-voices.json 里 directable=true 的音色', () => {
  assert.equal(isVerifiedDirectable('zh_female_vv_uranus_bigtts'), true);
  assert.equal(isVerifiedDirectable('zh_male_sunwukong_uranus_bigtts'), false); // 实测不可导演：同样不挂标记
  assert.equal(isVerifiedDirectable('zh_male_ruyaqingnian_uranus_bigtts'), false); // 未收录 = 未验证
  assert.equal(isVerifiedDirectable(''), false);
});

test('sendsVoiceInstructions：只有 豆包 API Key + seed-tts-2.0 会发情绪指令', () => {
  assert.equal(sendsVoiceInstructions(tts2), true);
  assert.equal(sendsVoiceInstructions({ provider: 'volcengine-api-key', resourceId: 'seed-icl-2.0' }), false);
  assert.equal(sendsVoiceInstructions({ provider: 'demo' }), false);
  assert.equal(sendsVoiceInstructions(null), false);
});

test('hasEmotionDirection：情绪词或潜台词算情绪指令，只改语速不算', () => {
  assert.equal(hasEmotionDirection({ emotion: '愤怒' }), true);
  assert.equal(hasEmotionDirection({ subtext: '压着火' }), true);
  assert.equal(hasEmotionDirection({ emotion: '', subtext: '  ', pace: 110 }), false);
});

test('emotionDriftRisk：未验证音色 + 情绪指令才提示', () => {
  const line = { emotion: '愤怒', subtext: '' };
  assert.equal(emotionDriftRisk({ line, voiceId: 'zh_male_ruyaqingnian_uranus_bigtts', config: tts2 }), true);
  assert.equal(emotionDriftRisk({ line, voiceId: 'zh_female_vv_uranus_bigtts', config: tts2 }), false);
  assert.equal(emotionDriftRisk({ line, voiceId: '', config: tts2 }), false);
  assert.equal(emotionDriftRisk({ line, voiceId: 'zh_male_ruyaqingnian_uranus_bigtts', config: { provider: 'demo' } }), false);
  assert.equal(emotionDriftRisk({ line: { emotion: '' }, voiceId: 'zh_male_ruyaqingnian_uranus_bigtts', config: tts2 }), false);
});

test('emotionDriftRisk：白名单可注入，复测加音色后自动生效', () => {
  const voices = { zh_male_ruyaqingnian_uranus_bigtts: { directable: true } };
  assert.equal(emotionDriftRisk({ line: { emotion: '愤怒' }, voiceId: 'zh_male_ruyaqingnian_uranus_bigtts', config: tts2, voices }), false);
});

test('castDirectableBanner：名单从 directable-voices.json 生成，只在会发情绪指令且有未验证音色时显示', () => {
  const characters = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const text = '目前只有 vv 实测可导演，其余音色加情绪指令可能带偏音色';
  assert.equal(castDirectableBanner({ characters, voiceMap: { a: 'zh_female_vv_uranus_bigtts', b: 'zh_male_ruyaqingnian_uranus_bigtts' }, config: tts2 }), text);
  assert.equal(castDirectableBanner({ characters, voiceMap: { a: 'zh_male_sunwukong_uranus_bigtts' }, config: tts2 }), text); // 实测不可导演同样算
  assert.equal(castDirectableBanner({ characters, voiceMap: { a: 'zh_female_vv_uranus_bigtts' }, config: tts2 }), ''); // 全是可导演音色
  assert.equal(castDirectableBanner({ characters, voiceMap: {}, config: tts2 }), ''); // 还没选角
  assert.equal(castDirectableBanner({ characters, voiceMap: { z: 'zh_male_ruyaqingnian_uranus_bigtts' }, config: tts2 }), ''); // 只看当前角色
  assert.equal(castDirectableBanner({ characters, voiceMap: { b: 'zh_male_ruyaqingnian_uranus_bigtts' }, config: { provider: 'demo' } }), ''); // 演示模式
  assert.equal(castDirectableBanner({ characters, voiceMap: { b: 'zh_male_ruyaqingnian_uranus_bigtts' }, config: { provider: 'volcengine-api-key', resourceId: 'seed-icl-2.0' } }), '');
});

test('castDirectableBanner：复测加音色后名单自动变；没有可导演音色时换说法', () => {
  const characters = [{ id: 'b' }];
  const voiceMap = { b: 'zh_male_m191_uranus_bigtts' };
  const voices = { zh_female_vv_uranus_bigtts: { directable: true }, zh_female_cancan_uranus_bigtts: { directable: true, label: '灿灿' } };
  assert.equal(castDirectableBanner({ characters, voiceMap, config: tts2, voices }), '目前只有 vv、灿灿 实测可导演，其余音色加情绪指令可能带偏音色');
  assert.equal(castDirectableBanner({ characters, voiceMap, config: tts2, voices: {} }), '目前还没有实测可导演的音色，加情绪指令可能带偏音色');
  assert.equal(voiceShortName('zh_male_ruyaqingnian_uranus_bigtts', {}), 'ruyaqingnian');
});

test('emotionDriftRisk：只调语速的句子不提示', () => {
  assert.equal(emotionDriftRisk({ line: { emotion: '', subtext: '', pace: 70 }, voiceId: 'zh_male_ruyaqingnian_uranus_bigtts', config: tts2 }), false);
});
