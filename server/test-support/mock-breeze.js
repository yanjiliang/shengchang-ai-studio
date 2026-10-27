// Breeze-TTS-2 本地服务的模拟实现（只用于测试和本机联调，不发任何外部请求）。
// 契约照 Tavi 的服务：JSON 请求体；成功 audio/wav + X-Seed；失败 400/500 纯文本；
// 一次只处理一个生成（同时到达第二个生成请求时 inFlightPeak 会 >1，测试据此
// 断言我们的排队确实是单飞）。
import http from 'node:http';

export function toneWav(seconds = 1, { sampleRate = 16000, frequency = 220 } = {}) {
  const samples = Math.max(1, Math.floor(seconds * sampleRate));
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.2 * 32767), index * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const GENERATION_PATHS = new Set(['/tts', '/voice_design', '/voice_clone', '/voice_direction']);

export async function startMockBreeze({ port = 0, delayMs = 0, clipSeconds = 1.2 } = {}) {
  const state = {
    requests: [], voices: new Map(), inFlight: 0, inFlightPeak: 0, delayMs, clipSeconds,
    // failNext: { path, method?, status, text } —— 下一次命中该路径时返回错误。
    failNext: null,
    // hold: true 时生成请求挂起，直到调用 release()（用来测取消/排队）。
    hold: false, held: [],
    // GET /voices 的返回形状。真 Breeze 返回 { id: transcript }（'object'）；
    // 'array' = [{id, transcript}]，'wrapped' = { voices: [...] }，'garbage' = 无法识别。
    voicesShape: 'object',
    // resetNext: n —— 接下来 n 个生成请求直接断开连接（客户端看到 ECONNRESET / socket hang up）。
    resetNext: 0,
    // voicesBlockWhileGenerating: true 时 GET /voices 要等所有生成结束才回（真 Breeze 单线程的样子）。
    voicesBlockWhileGenerating: false,
    // dieAfter: n —— 再成功回 n 个生成请求之后“挂掉”：down = true，之后所有请求（含 GET /voices）直接断开连接。
    // 设 down = false 即“恢复”（真重启还要 restart() 清注册表）。
    dieAfter: null, down: false, generated: 0,
  };
  const idleWaiters = [];
  const notifyIdle = () => { if (state.inFlight === 0) for (const resume of idleWaiters.splice(0)) resume(); };
  const release = () => { const pending = state.held.splice(0); for (const resume of pending) resume(); };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const url = new URL(request.url, 'http://mock');
      let body = null;
      if (chunks.length) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { response.writeHead(400, { 'Content-Type': 'text/plain' }); return response.end('invalid json'); }
      }
      state.requests.push({ method: request.method, path: url.pathname, body, raw: Buffer.concat(chunks).toString('utf8'), headers: { authorization: request.headers.authorization }, at: Date.now() });
      if (state.down) { request.socket.destroy(); return; }
      const fail = state.failNext && state.failNext.path === url.pathname && (!state.failNext.method || state.failNext.method === request.method) ? state.failNext : null;
      if (fail) { state.failNext = null; response.writeHead(fail.status, { 'Content-Type': 'text/plain' }); return response.end(fail.text || 'mock failure'); }
      if (url.pathname === '/voices' && request.method === 'GET') {
        if (state.voicesBlockWhileGenerating && state.inFlight > 0) await new Promise((resume) => idleWaiters.push(resume));
        const list = [...state.voices.values()].map(({ id, transcript }) => ({ id, transcript }));
        const payload = state.voicesShape === 'array' ? list
          : state.voicesShape === 'wrapped' ? { voices: list }
            : state.voicesShape === 'garbage' ? 'not a voice list'
              : Object.fromEntries(list.map(({ id, transcript }) => [id, transcript]));
        response.writeHead(200, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify(payload));
      }
      if (url.pathname === '/voices' && request.method === 'POST') {
        if (!body?.id || !body?.transcript || !(body.wav_base64 || body.wav_path)) { response.writeHead(400, { 'Content-Type': 'text/plain' }); return response.end('id, transcript and wav_path|wav_base64 are required'); }
        state.voices.set(body.id, { id: body.id, transcript: body.transcript, bytes: body.wav_base64 ? Buffer.from(body.wav_base64, 'base64').length : 0 });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ ok: true, id: body.id }));
      }
      if (request.method === 'POST' && GENERATION_PATHS.has(url.pathname)) {
        if (!String(body?.text || '').trim()) { response.writeHead(400, { 'Content-Type': 'text/plain' }); return response.end('text is required'); }
        if (url.pathname === '/tts' && body.voiceId && !state.voices.has(body.voiceId) && !String(body.voiceId).startsWith('preset-')) {
          response.writeHead(400, { 'Content-Type': 'text/plain' }); return response.end(`unknown voiceId: ${body.voiceId}`);
        }
        if (state.resetNext > 0) { state.resetNext -= 1; request.socket.destroy(); return; }
        state.inFlight += 1; state.inFlightPeak = Math.max(state.inFlightPeak, state.inFlight);
        if (state.hold) await new Promise((resume) => state.held.push(resume));
        if (state.delayMs) await new Promise((resume) => setTimeout(resume, state.delayMs));
        state.inFlight -= 1;
        notifyIdle();
        const seed = Number.isSafeInteger(body.seed) ? body.seed : 42;
        // 真 Breeze：请求里有 instruction（字符串，含 ''）就用它，缺省 / null 自己拼；
        // X-Instruction-B64 回显实际用的。instructionOverride 用来模拟“没按声场的来”。
        const usedInstruction = state.instructionOverride ?? (typeof body.instruction === 'string' ? body.instruction : '[breeze 自拟]');
        response.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Seed': String(seed), ...(state.echoInstruction === false ? {} : { 'X-Instruction-B64': Buffer.from(usedInstruction, 'utf8').toString('base64') }) });
        state.generated += 1;
        if (Number.isInteger(state.dieAfter) && (state.dieAfter -= 1) <= 0) { state.dieAfter = null; state.down = true; }
        return response.end(toneWav(state.clipSeconds, { frequency: 180 + (seed % 200) }));
      }
      response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end('not found');
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  // restart()：模拟 Breeze 进程重启——注册表清空（它不落盘）。
  const restart = () => { state.voices.clear(); };
  return { endpoint, state, release, restart, close: () => new Promise((resolve) => { release(); server.closeAllConnections?.(); server.close(resolve); }) };
}
