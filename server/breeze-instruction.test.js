// Breeze /tts 指令以声场为准：breezeInstruction 的规则照搬 Tavi 的 Breeze server.py
// （第 37–58 行）。这里是逐字的“金标准”，改一个字都要同时改 Breeze 并加 BREEZE_INSTRUCTION_VERSION。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startMockBreeze } from './test-support/mock-breeze.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-breeze-instruction-test-'));
process.env.HOME = scratch;
process.env.SHENGCHANG_RUNTIME_DIR = path.join(scratch, 'runtime');
const { breezeInstruction, parseInstructionHeader, voiceInstructions, synthesize, BREEZE_INSTRUCTION_MAX_CHARS, BREEZE_INSTRUCTION_VERSION, TTS_INSTRUCTION_VERSION } = await import('./model-adapters.js');
const { audioContentHash } = await import('./database.js');
const { sanitizeConfig } = await import('./config-store.js');

describe('breezeInstruction 金标准（与 Breeze server.py 一致）', () => {
  const golden = [
    // [请求, 期望指令]
    [{ emotion: '悲伤', emotionScale: 0.8 }, '用特别特别悲伤的语气说。'],
    [{ emotion: '悲伤', emotionScale: 1 }, '用特别特别悲伤的语气说。'],
    [{ emotion: '愤怒', emotionScale: 0.79 }, '用特别愤怒的语气说。'],
    [{ emotion: '愤怒', emotionScale: 0.6 }, '用特别愤怒的语气说。'],
    [{ emotion: '开心', emotionScale: 0.59 }, '用比较开心的语气说。'],
    [{ emotion: '开心', emotionScale: 0.4 }, '用比较开心的语气说。'],
    [{ emotion: '疲惫', emotionScale: 0.39 }, '用略带一点疲惫的语气说。'],
    [{ emotion: '疲惫', emotionScale: 0.05 }, '用略带一点疲惫的语气说。'], // 夹到 0.1
    [{ emotion: '疲惫', emotionScale: 3 }, '用特别特别疲惫的语气说。'], // 夹到 1
    [{ emotion: '平静' }, '用比较平静的语气说。'], // 缺省 0.4
    [{ emotion: '平静', emotionScale: null }, '用比较平静的语气说。'],
    [{ speed: 0.9 }, '语速稍慢、从容。'],
    [{ speed: 0.78 }, '语速稍慢、从容。'],
    [{ speed: 0.91 }, ''],
    [{ speed: 1 }, ''],
    [{ speed: 1.09 }, ''],
    [{ speed: 1.1 }, '语速加快，说得紧凑一些。'],
    [{ speed: 1.3 }, '语速加快，说得紧凑一些。'],
    [{ subtext: '被赶走前最后的哀求' }, '这句话的情绪来由是：被赶走前最后的哀求。'],
    [{ emotion: '悲伤', emotionScale: 0.9, speed: 0.85, subtext: '被赶走前最后的哀求' }, '用特别特别悲伤的语气说，语速稍慢、从容，这句话的情绪来由是：被赶走前最后的哀求。'],
    [{ emotion: '急切', emotionScale: 0.6, speed: 1.2 }, '用特别急切的语气说，语速加快，说得紧凑一些。'],
    [{}, ''],
    [{ emotion: '', speed: 1, subtext: '   ' }, ''],
  ];
  for (const [request, expected] of golden) {
    test(`${JSON.stringify(request)} → ${JSON.stringify(expected)}`, () => assert.equal(breezeInstruction(request), expected));
  }

  test('潜台词只取前 100 字', () => {
    const subtext = '甲'.repeat(150);
    assert.equal(breezeInstruction({ subtext }), `这句话的情绪来由是：${'甲'.repeat(100)}。`);
  });
  test(`总长不超过 ${BREEZE_INSTRUCTION_MAX_CHARS} 字（Breeze 上限）`, () => {
    const text = breezeInstruction({ emotion: '悲'.repeat(400), subtext: '甲'.repeat(100) });
    assert.equal(Array.from(text).length, BREEZE_INSTRUCTION_MAX_CHARS);
  });
  test('不带豆包的“保持当前基础音色稳定”，也不写停顿', () => {
    for (const request of [{ emotion: '悲伤', emotionScale: 0.9, speed: 0.7, subtext: '哀求' }, { speed: 0.5 }]) {
      assert.doesNotMatch(breezeInstruction(request), /保持当前基础音色稳定|停顿/);
    }
  });
  test('与接管前发给 Breeze 的指令逐字相同（所以 BREEZE_INSTRUCTION_VERSION 不用加）', () => {
    for (const emotion of ['', '悲伤']) for (const emotionScale of [undefined, 0.1, 0.39, 0.4, 0.6, 0.8, 1]) for (const speed of [undefined, 0.8, 0.9, 1, 1.1, 1.3]) for (const subtext of ['', '来由']) {
      const request = { emotion, emotionScale, speed, subtext };
      assert.equal(breezeInstruction(request), voiceInstructions(request, { stableSpeaker: false, pauseWording: false })[0] || '', JSON.stringify(request));
    }
  });
  test('豆包指令与版本不动', () => {
    assert.equal(TTS_INSTRUCTION_VERSION, 2);
    assert.deepEqual(voiceInstructions({ emotion: '悲伤', emotionScale: 0.6, speed: 0.78 }), ['用特别悲伤的语气说，语速放慢，句间多停顿一下，保持当前基础音色稳定。']);
  });
});

describe('Breeze 缓存键', () => {
  const config = { provider: 'breeze', breezeEndpoint: 'http://127.0.0.1:8000', audioFormat: 'wav', sampleRate: 24000 };
  const request = { voiceId: 'ref-tang', text: '徒弟，为师腹中饥饿。', emotion: '疲惫', emotionScale: 0.3, speed: 0.85, subtext: '旅途劳顿', referenceHash: 'r'.repeat(64) };
  test('带 Breeze 指令版本；现有 Breeze 缓存键不挪动（金标准哈希）', () => {
    assert.equal(BREEZE_INSTRUCTION_VERSION, 1);
    assert.equal(audioContentHash(config, request), '182488e45e67f3108c492dfa28050a2c5732ed2cf7603cea89dd80095ddd7338');
  });
  test('指令相关参数一变，键就变', () => {
    const base = audioContentHash(config, request);
    assert.notEqual(audioContentHash(config, { ...request, speed: 1 }), base);
    assert.notEqual(audioContentHash(config, { ...request, subtext: '' }), base);
    assert.notEqual(audioContentHash(config, { ...request, emotionScale: 0.9 }), base);
  });
});

describe('对模拟 Breeze', () => {
  let mock;
  before(async () => { mock = await startMockBreeze(); mock.state.voices.set('tangseng', { id: 'tangseng', transcript: 'x' }); });
  after(async () => { await mock.close(); rmSync(scratch, { recursive: true, force: true }); });
  const config = () => sanitizeConfig({ provider: 'breeze', breezeEndpoint: mock.endpoint });
  const line = { text: '徒弟，为师腹中饥饿。', voiceId: 'tangseng', emotion: '疲惫', emotionScale: 0.3, speed: 0.85, subtext: '旅途劳顿' };

  test('发的就是 breezeInstruction；读回 X-Instruction-B64', async () => {
    const audio = await synthesize(config(), line);
    const sent = mock.state.requests.at(-1).body;
    assert.equal(sent.instruction, '用略带一点疲惫的语气说，语速稍慢、从容，这句话的情绪来由是：旅途劳顿。');
    assert.equal(audio.instructionSent, sent.instruction);
    assert.equal(audio.instructionUsed, sent.instruction);
  });
  test('没有任何表演参数：发空字符串（纯克隆），不是缺省', async () => {
    const audio = await synthesize(config(), { text: '你好。', voiceId: 'tangseng', speed: 1 });
    const sent = mock.state.requests.at(-1).body;
    assert.ok(Object.hasOwn(sent, 'instruction'));
    assert.equal(sent.instruction, '');
    assert.equal(audio.instructionUsed, '');
  });
  test('Breeze 没按声场的指令：只记日志，不报错', async () => {
    mock.state.instructionOverride = '别的指令';
    const warnings = [];
    const original = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      const audio = await synthesize(config(), line);
      assert.equal(audio.instructionUsed, '别的指令');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /实际指令与声场发送的不一致/);
    } finally { console.warn = original; mock.state.instructionOverride = undefined; }
  });
  test('旧版 Breeze 没有回显头：instructionUsed = null，不告警', async () => {
    mock.state.echoInstruction = false;
    try { assert.equal((await synthesize(config(), line)).instructionUsed, null); } finally { mock.state.echoInstruction = undefined; }
  });
  test('parseInstructionHeader', () => {
    assert.equal(parseInstructionHeader(Buffer.from('用比较平静的语气说。').toString('base64')), '用比较平静的语气说。');
    assert.equal(parseInstructionHeader(null), null);
  });
});
