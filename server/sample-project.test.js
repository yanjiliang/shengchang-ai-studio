import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSampleState, SAMPLE_SEED, SAMPLE_NAME } from './sample-project.js';

const DIRECTION_KEYS = ['subtext', 'emotion', 'intensity', 'pace', 'distance'];

test('sample state: every dialogue line carries full direction data', () => {
  const state = buildSampleState();
  const lines = state.scenes.flatMap((scene) => scene.lines.filter((line) => line.type === 'dialogue'));
  assert.ok(lines.length >= 19, `expect >= 19 dialogue lines, got ${lines.length}`);
  for (const line of lines) {
    for (const key of DIRECTION_KEYS) {
      assert.ok(line[key] !== undefined && line[key] !== '', `line ${line.id} missing direction ${key}`);
    }
    assert.ok(Number(line.intensity) >= 0 && Number(line.intensity) <= 100, `line ${line.id} intensity out of range`);
    assert.ok(Number(line.pace) >= 50 && Number(line.pace) <= 150, `line ${line.id} pace out of range`);
  }
});

test('sample state: ids are unique; speakers resolve to the character roster', () => {
  const state = buildSampleState();
  const ids = state.scenes.flatMap((scene) => scene.lines.map((line) => line.id));
  assert.equal(new Set(ids).size, ids.length, 'duplicate line ids');
  assert.equal(new Set(state.scenes.map((scene) => scene.id)).size, state.scenes.length, 'duplicate scene ids');
  const speakers = new Set(state.scenes.flatMap((scene) => scene.lines.filter((line) => line.type === 'dialogue').map((line) => line.speakerId)));
  const roster = new Map(state.characters.map((c) => [c.id, c.name]));
  for (const speakerId of speakers) {
    assert.ok(roster.has(speakerId), `speaker ${speakerId} missing from roster`);
  }
});

test('sample state: scene cast strings derive from actual speakers', () => {
  const state = buildSampleState();
  for (const scene of state.scenes) {
    const speakers = [...new Set(scene.lines.filter((line) => line.type === 'dialogue').map((line) => line.speaker))].join(' · ');
    assert.equal(scene.cast, speakers || '旁白', `scene ${scene.id} cast out of sync`);
    assert.equal(scene.duration, '待生成');
    assert.equal(scene.status, 'pending');
  }
});

test('sample state: sounds and marker survive round-trip', () => {
  const state = buildSampleState();
  const sounds = state.scenes.flatMap((scene) => scene.lines.filter((line) => line.type !== 'dialogue'));
  assert.equal(sounds.length, 3, 'expect 3 sound events');
  assert.ok(sounds.every((s) => ['ambient', 'sfx', 'music'].includes(s.type)));
  assert.equal(state.sampleSeed, SAMPLE_SEED);
  assert.ok(SAMPLE_NAME.includes('三打白骨精'));
});