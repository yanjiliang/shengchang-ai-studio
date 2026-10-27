// 本机联调用：起一个模拟 Breeze 服务（默认 127.0.0.1:4180），不需要 GPU/模型。
// 用法：node scripts/mock-breeze.mjs [port] [delayMs]
import { startMockBreeze } from '../server/test-support/mock-breeze.js';

const port = Number(process.argv[2] || 4180);
const delayMs = Number(process.argv[3] || 300);
const mock = await startMockBreeze({ port, delayMs, clipSeconds: 1.5 });
console.log(`模拟 Breeze 服务：${mock.endpoint}（每次生成延迟 ${delayMs}ms；/tts 接受任何 preset- 开头或已注册的 voiceId）`);
