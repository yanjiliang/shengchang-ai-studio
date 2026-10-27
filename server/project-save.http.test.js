// 真实 HTTP 往返：起一个本地服务（临时运行目录、随机端口），PUT 整个项目
// 再 GET，确认角色卡上的 gender/age 被保存下来。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-http-test-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let server;

before(async () => {
  server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')], {
    env: { ...process.env, SHENGCHANG_RUNTIME_DIR: scratch, SHENGCHANG_API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (chunk) => { log += chunk; });
  server.stderr.on('data', (chunk) => { log += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/projects`)).ok) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`服务没起来：${log}`);
});
after(() => { server?.kill(); rmSync(scratch, { recursive: true, force: true }); });

const json = async (response) => { const body = await response.json(); assert.ok(response.ok, JSON.stringify(body)); return body; };

test('整项目 PUT 保存角色性别/年龄，GET 读回；枚举外的值落成“未知”', async () => {
  const { projects } = await json(await fetch(`${base}/api/projects`));
  const sample = projects.find((item) => item.name.includes('西游记'));
  assert.ok(sample, '新安装应自动创建西游记示例');
  const project = await json(await fetch(`${base}/api/projects/${sample.id}`));
  assert.equal(project.state.characters.find((item) => item.id === 'laoweng').age, '老年', '示例自带性别/年龄');
  const characters = project.state.characters.map((item) => (item.id === 'tangseng' ? { ...item, gender: '女', age: '少年' } : item.id === 'zhubajie' ? { ...item, age: '很老' } : item));
  await json(await fetch(`${base}/api/projects/${sample.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: project.name, genre: project.genre, state: { ...project.state, characters } }) }));
  const reloaded = await json(await fetch(`${base}/api/projects/${sample.id}`));
  const byId = Object.fromEntries(reloaded.state.characters.map((item) => [item.id, item]));
  assert.deepEqual([byId.tangseng.gender, byId.tangseng.age, byId.tangseng.genderSource], ['女', '少年', 'user']);
  assert.equal(byId.zhubajie.age, '未知');
  assert.equal(byId.laoyu.gender, '女');
});
