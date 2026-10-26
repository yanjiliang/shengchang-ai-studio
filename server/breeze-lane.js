// 引擎生成通道：每个语音引擎一条进程内通道，所有发往该引擎的生成请求
// （/tts、/voice_design、豆包 HTTP ...）都经过它：
//   - 同一时刻最多 concurrency 个在飞请求（Breeze 默认 1：本机服务一次只跑一个
//     生成；可在配置 engineConcurrency 里按引擎调整）；
//   - 两档优先级：interactive（试听、单句重生成、音色设计）先于 batch（整场/批量/
//     一键成片），同档按到达顺序；
//   - queuePosition：0 = 正在生成，1 = 下一个，依此类推；不在通道里 = null；
//   - cancelJob(jobId)：该任务排队中的项直接移除；在飞的那一项无法中断上游，
//     立刻以 TASK_CANCELLED 拒绝调用方（任务马上变成已取消），上游返回的结果被丢弃，
//     槽位等上游真正结束后才释放（Breeze 仍在算，不能把下一个塞给它）。
// 通道只在内存里：服务重启后由 tasks 表的恢复逻辑重新入队。
export const PRIORITY = Object.freeze({ interactive: 0, batch: 1 });

function cancelledError() {
  const error = new Error('任务已取消');
  error.code = 'TASK_CANCELLED';
  return error;
}

const byPriority = (a, b) => a.priority - b.priority || a.sequence - b.sequence;

export function createLane({ concurrency = 1 } = {}) {
  const waiting = [];
  const running = new Set();
  let limit = Math.max(1, Math.floor(concurrency) || 1);
  let sequence = 0;

  function pump() {
    while (running.size < limit && waiting.length) {
      waiting.sort(byPriority);
      const item = waiting.shift();
      running.add(item);
      Promise.resolve().then(item.fn).then(
        (value) => { if (!item.discarded) item.resolve(value); },
        (error) => { if (!item.discarded) item.reject(error); },
      ).finally(() => { running.delete(item); pump(); });
    }
  }

  return {
    run({ jobId, priority = PRIORITY.batch, fn }) {
      return new Promise((resolve, reject) => {
        waiting.push({ jobId: String(jobId || ''), priority: priority === PRIORITY.interactive ? 0 : 1, sequence: sequence += 1, fn, resolve, reject, discarded: false });
        pump();
      });
    },
    setConcurrency(value) {
      limit = Math.max(1, Math.floor(Number(value)) || 1);
      pump();
    },
    get concurrency() { return limit; },
    // 这个任务“最靠前”的一项的位置。
    positionOf(jobId) {
      if ([...running].some((item) => item.jobId === jobId && !item.discarded)) return 0;
      const index = [...waiting].sort(byPriority).findIndex((item) => item.jobId === jobId);
      return index === -1 ? null : index + 1;
    },
    cancelJob(jobId) {
      let removed = 0;
      for (let index = waiting.length - 1; index >= 0; index -= 1) {
        if (waiting[index].jobId !== jobId) continue;
        const [item] = waiting.splice(index, 1);
        item.reject(cancelledError());
        removed += 1;
      }
      let discardedInFlight = 0;
      for (const item of running) {
        if (item.jobId !== jobId || item.discarded) continue;
        item.discarded = true;
        item.reject(cancelledError());
        discardedInFlight += 1;
      }
      return { removed, discardedInFlight };
    },
    snapshot() {
      const inFlight = [...running].map((item) => item.jobId);
      return { concurrency: limit, inFlight: inFlight[0] ?? null, inFlightJobs: inFlight, waiting: waiting.length };
    },
  };
}

// 默认并发：Breeze 1（本机单卡）；豆包 / 自定义 HTTP 2（与旧任务泵一致）；demo 4。
export const DEFAULT_ENGINE_CONCURRENCY = Object.freeze({ breeze: 1, 'volcengine-api-key': 2, custom: 2, demo: 4 });
export const ENGINE_CONCURRENCY_MAX = 8;

export function normalizeEngineConcurrency(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return Object.fromEntries(Object.entries(DEFAULT_ENGINE_CONCURRENCY).map(([engine, fallback]) => {
    const value = Number(source[engine]);
    return [engine, Number.isInteger(value) && value >= 1 && value <= ENGINE_CONCURRENCY_MAX ? value : fallback];
  }));
}

const lanes = new Map();

export function laneFor(engine, config = {}) {
  const key = String(engine || 'demo');
  const concurrency = normalizeEngineConcurrency(config.engineConcurrency)[key] ?? 2;
  if (!lanes.has(key)) lanes.set(key, createLane({ concurrency }));
  const lane = lanes.get(key);
  if (lane.concurrency !== concurrency) lane.setConcurrency(concurrency);
  return lane;
}

// 取消 / 查询位置时不知道任务走的是哪条通道：全部问一遍。
export function cancelJobEverywhere(jobId) {
  let removed = 0;
  let discardedInFlight = 0;
  for (const lane of lanes.values()) {
    const outcome = lane.cancelJob(jobId);
    removed += outcome.removed;
    discardedInFlight += outcome.discardedInFlight;
  }
  return { removed, discardedInFlight };
}

export function queuePositionOf(jobId) {
  for (const lane of lanes.values()) {
    const position = lane.positionOf(jobId);
    if (position !== null) return position;
  }
  return null;
}

// Breeze 通道（音色设计等直接用）；与 laneFor('breeze') 是同一个对象。
export const breezeLane = laneFor('breeze');
