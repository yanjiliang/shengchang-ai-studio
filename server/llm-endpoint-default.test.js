import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(tmpdir(), 'sc-llm-default-'));
process.env.HOME = home;
const { DEFAULT_CONFIG, readConfig, writeConfig } = await import('./config-store.js');
const { validateLlmConfig } = await import('./story-analyzer.js');
test.after(() => rmSync(home, { recursive: true, force: true }));

test('fresh install: text-model address is empty, not prefilled with Ark', async () => {
  assert.equal(DEFAULT_CONFIG.llmEndpoint, '');
  assert.equal((await readConfig()).llmEndpoint, '');
});

test('saving an empty address keeps it empty after reload', async () => {
  await writeConfig({ ...(await readConfig()), llmEndpoint: '' });
  const saved = await readConfig();
  assert.equal(saved.llmEndpoint, '');
  assert.throws(() => validateLlmConfig({ ...saved, llmModel: 'm' }), /请填写服务地址/);
});

test('a user-entered address is kept as typed (trimmed)', async () => {
  await writeConfig({ ...(await readConfig()), llmEndpoint: '  http://127.0.0.1:1/v1  ' });
  assert.equal((await readConfig()).llmEndpoint, 'http://127.0.0.1:1/v1');
});
