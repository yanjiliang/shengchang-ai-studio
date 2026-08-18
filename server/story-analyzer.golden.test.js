import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Golden-file regression for the rule-based 拆解 (§8 follow-up): the fixture
// is a fixed two-chapter excerpt exercising every attribution path (quoted
// speech with 名字+说道, pronoun continuation, unattributed quote -> narrator,
// plain narration, chapter splitting). Any change to the heuristics that
// alters speaker attribution or line splitting must be a conscious one:
// update the golden by re-running the generator in the fixture header.
process.env.SHENGCHANG_RUNTIME_DIR ??= '/tmp/shengchang-golden-test';
const { heuristicAnalysis } = await import('./story-analyzer.js');

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'heuristic-golden.json');
export const GOLDEN_TEXT = ['第一章 雨夜', '出租车停在巷口，林夏付了钱。雨点砸在车顶上，像有人不耐烦地敲着桌子。', '', '「就是这里？」她问。', '', '司机没有回答，只是抬了抬下巴，指向那扇亮着灯的木门。门上的漆剥落了大半，露出底下更旧的漆。', '', '林夏推开门，风铃响了。柜台后坐着一个老人，正在读一份三天前的报纸。', '', '「你终于来了。」老人低声说道，「等了七年。」', '', '「我需要知道真相。」她答道，「关于我父亲。」', '', '老人放下报纸，笑了。', '', '第二章 灯', '灯亮了。走廊尽头传来水声。林夏站在原地，听见自己的心跳。'].join('\n');

export function canonicalize(result) {
  return {
    project: result.project,
    characters: result.characters.map((character) => ({ id: character.id, name: character.name })),
    scenes: result.scenes.map((scene) => ({ title: scene.title, lines: scene.lines.map((line) => ({ speakerId: line.speakerId, text: line.text })) })),
  };
}

test('规则拆解 golden：说话人归属与切分结构不回归', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const canonical = canonicalize(heuristicAnalysis(GOLDEN_TEXT, 'golden-demo'));
  assert.deepEqual(canonical, golden);
  // Guard the specific regression the golden caught once: quoted text
  // containing 知道 must never leak into a character name.
  assert.ok(!canonical.characters.some((character) => character.name.includes('知道')));
});
