import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// docs/openapi.yaml 和代码别漂移：生产链路路由都要有文档，抛出的错误码都要在 ErrorCode 里。
// 纯文本检查（仓库没有 YAML 依赖）；结构校验用 `npx @redocly/cli lint docs/openapi.yaml`。
const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const spec = read('../docs/openapi.yaml');
const documentedPaths = new Set([...spec.matchAll(/^ {2}(\/api\S*):$/gm)].map((match) => match[1]));
const toOpenApi = (route) => route.replace(/:(\w+)/g, '{$1}');

test('生产链路路由都写进了 openapi.yaml', () => {
  const breeze = read('./breeze-routes.js');
  const roleBase = breeze.match(/const ROLE_BASE = '([^']+)'/)[1];
  const routes = [
    ...[...breeze.matchAll(/app\.(get|post|put|delete)\(`\$\{ROLE_BASE\}([^`]*)`/g)].map((match) => [match[1], roleBase + match[2]]),
    ...[...`${breeze}\n${read('./production-routes.js')}`.matchAll(/app\.(get|post|put|delete)\('([^']+)'/g)].map((match) => [match[1], match[2]]),
  ];
  assert.ok(routes.length >= 12, `应找到生产链路路由，实际 ${routes.length}`);
  for (const [method, route] of routes) {
    const documented = toOpenApi(route);
    assert.ok(documentedPaths.has(documented), `${method.toUpperCase()} ${route} 不在 openapi.yaml`);
    const block = spec.slice(spec.indexOf(`  ${documented}:\n`)).split(/\n {2}\/api/)[0];
    assert.match(block, new RegExp(`^ {4}${method}:$`, 'm'), `${method.toUpperCase()} ${route} 缺少该方法`);
  }
});

test('服务端抛出的错误码都在 ErrorCode 枚举里', () => {
  const enumStart = spec.indexOf('    ErrorCode:');
  const enumBlock = spec.slice(enumStart, spec.indexOf('    Error:\n', enumStart));
  assert.ok(enumBlock.length > 100, '找不到 ErrorCode 枚举');
  const documented = new Set([...enumBlock.matchAll(/^ {8}- ([A-Z_]+)/gm)].map((match) => match[1]));
  const sources = ['breeze.js', 'breeze-routes.js', 'production-routes.js', 'line-takes.js', 'voice-references.js', 'voice-design.js', 'one-click.js'].map((file) => read(`./${file}`)).join('\n');
  const thrown = new Set([...sources.matchAll(/code(?:: |\s*=\s*)'([A-Z][A-Z_]{3,})'/g), ...sources.matchAll(/httpError\(\d{3}, '([A-Z_]+)'/g)].map((match) => match[1]));
  thrown.delete('TASK_CANCELLED'); // 内部控制流，不会出现在 HTTP 响应里
  for (const code of thrown) assert.ok(documented.has(code), `${code} 不在 openapi.yaml 的 ErrorCode 里`);
});
