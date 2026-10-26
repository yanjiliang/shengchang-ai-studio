// 量化一条语音指令是否真的改变了表演：同一音色、同一句台词，分别不带指令 /
// 带指令合成，报告时长比和基频（F0）范围。指令措辞走生产代码的
// voiceInstructions()，测的就是声场实际发出去的内容。
//
// 真实合成（会消耗豆包额度，每次约 2×台词字数）：
//   DOUBAO_API_KEY=xxx node scripts/measure-instruction.mjs --voice zh_female_vv_uranus_bigtts \
//     --emotion 悲伤 --scale 0.9 [--speed 0.85] [--subtext "..."] [--text "..."] [--out dir]
// 只分析已有音频（不调用接口）：
//   node scripts/measure-instruction.mjs --analyze baseline.mp3 directed.mp3
//
// 依赖 ffmpeg / ffprobe。F0 用简化 YIN（75–600 Hz），只做 A/B 相对比较，不当绝对音高。
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const SAMPLE_RATE = 16000;

function decodePcm(file) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

// 简化 YIN：累积均值归一化差分函数，阈值 0.15，抛物线插值。
export function estimateF0(samples, sampleRate = SAMPLE_RATE, { minHz = 75, maxHz = 600, frameMs = 40, hopMs = 10, threshold = 0.15 } = {}) {
  const frame = Math.round((sampleRate * frameMs) / 1000);
  const hop = Math.round((sampleRate * hopMs) / 1000);
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.min(Math.ceil(sampleRate / minHz), frame - 1);
  const values = [];
  let frames = 0;
  const diff = new Float64Array(maxLag + 1);
  for (let start = 0; start + frame + maxLag < samples.length; start += hop) {
    frames += 1;
    let energy = 0;
    for (let i = 0; i < frame; i += 1) energy += samples[start + i] ** 2;
    if (energy / frame < 1e-5) continue; // 静音
    for (let lag = 1; lag <= maxLag; lag += 1) {
      let sum = 0;
      for (let i = 0; i < frame; i += 1) { const d = samples[start + i] - samples[start + i + lag]; sum += d * d; }
      diff[lag] = sum;
    }
    let running = 0;
    let found = -1;
    const cmnd = new Float64Array(maxLag + 1);
    for (let lag = 1; lag <= maxLag; lag += 1) {
      running += diff[lag];
      cmnd[lag] = running ? (diff[lag] * lag) / running : 1;
    }
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      if (cmnd[lag] < threshold) {
        while (lag + 1 <= maxLag && cmnd[lag + 1] < cmnd[lag]) lag += 1;
        found = lag;
        break;
      }
    }
    if (found < 0) continue;
    const [a, b, c] = [cmnd[found - 1] ?? cmnd[found], cmnd[found], cmnd[found + 1] ?? cmnd[found]];
    const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
    values.push(sampleRate / (found + (Number.isFinite(shift) ? shift : 0)));
  }
  return { values, frames };
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];

export function summarize(samples, sampleRate = SAMPLE_RATE) {
  const { values, frames } = estimateF0(samples, sampleRate);
  const sorted = [...values].sort((x, y) => x - y);
  const p10 = percentile(sorted, 0.1);
  const p90 = percentile(sorted, 0.9);
  return {
    durationSec: samples.length / sampleRate,
    f0MedianHz: sorted.length ? percentile(sorted, 0.5) : null,
    f0P10Hz: sorted.length ? p10 : null,
    f0P90Hz: sorted.length ? p90 : null,
    f0RangeSemitones: sorted.length ? 12 * Math.log2(p90 / p10) : null, // p10–p90，抗离群
    voicedRatio: frames ? values.length / frames : 0,
  };
}

function analyzeFile(file) { return { file, ...summarize(decodePcm(file)) }; }

function report(baseline, directed) {
  const fmt = (value, digits = 1) => (value === null || value === undefined ? '—' : value.toFixed(digits));
  for (const item of [baseline, directed]) {
    console.log(`${path.basename(item.file).padEnd(28)} 时长 ${fmt(item.durationSec, 2)}s  F0 中位 ${fmt(item.f0MedianHz, 0)}Hz  p10–p90 ${fmt(item.f0P10Hz, 0)}–${fmt(item.f0P90Hz, 0)}Hz（${fmt(item.f0RangeSemitones)} 半音）  浊音 ${fmt(item.voicedRatio * 100, 0)}%`);
  }
  const comparison = {
    durationRatio: directed.durationSec / baseline.durationSec,
    f0MedianShiftSemitones: baseline.f0MedianHz && directed.f0MedianHz ? 12 * Math.log2(directed.f0MedianHz / baseline.f0MedianHz) : null,
    f0RangeDeltaSemitones: baseline.f0RangeSemitones !== null && directed.f0RangeSemitones !== null ? directed.f0RangeSemitones - baseline.f0RangeSemitones : null,
  };
  console.log(`时长比（带指令/不带）${fmt(comparison.durationRatio, 2)}  F0 中位偏移 ${fmt(comparison.f0MedianShiftSemitones)} 半音  F0 范围变化 ${fmt(comparison.f0RangeDeltaSemitones)} 半音`);
  return comparison;
}

async function render(options) {
  const { synthesize, voiceInstructions } = await import('../server/model-adapters.js');
  const accessKey = process.env.DOUBAO_API_KEY;
  if (!accessKey) throw new Error('请设置 DOUBAO_API_KEY（真实合成会消耗额度）');
  const config = { provider: 'volcengine-api-key', endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', accessKey, resourceId: options.resource, audioFormat: 'mp3', sampleRate: 24000, responseMode: 'auto' };
  const base = { text: options.text, voiceId: options.voice, speed: 1 };
  const directed = { ...base, emotion: options.emotion, emotionScale: Number(options.scale), speed: Number(options.speed), subtext: options.subtext };
  console.log(`指令：${voiceInstructions(directed)[0] || '（无）'}`);
  mkdirSync(options.out, { recursive: true });
  const files = [];
  for (const [name, request] of [['baseline', base], ['directed', directed]]) {
    const audio = await synthesize(config, request);
    const file = path.join(options.out, `${options.voice}-${name}.mp3`);
    writeFileSync(file, audio.buffer);
    console.log(`${name}: ${audio.buffer.length} bytes，计费字数 ${audio.usage?.billedCharacters ?? '未返回'}`);
    files.push(file);
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: options, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      analyze: { type: 'boolean', default: false },
      voice: { type: 'string', default: 'zh_female_vv_uranus_bigtts' },
      resource: { type: 'string', default: 'seed-tts-2.0' },
      text: { type: 'string', default: '师父！再教俺走，谁来保你西去……' },
      emotion: { type: 'string', default: '悲伤' },
      scale: { type: 'string', default: '0.9' },
      speed: { type: 'string', default: '1' },
      subtext: { type: 'string', default: '' },
      out: { type: 'string', default: 'measure-out' },
    },
  });
  const files = options.analyze ? positionals : await render(options);
  if (files.length !== 2) throw new Error('需要两个音频：基线 和 带指令');
  report(analyzeFile(files[0]), analyzeFile(files[1]));
}
