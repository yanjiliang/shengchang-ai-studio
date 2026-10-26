// Breeze 生成通道：本机 Breeze 一次只能跑一个生成，所以所有发往 Breeze 的生成
// 请求（/tts、/voice_design ...）都经过这条进程内通道：
//   - 同一时刻最多 1 个在飞请求；
//   - 两档优先级：interactive（试听、单句重生成、音色设计）先于 batch（整场/批量/
//     一键成片），同档按到达顺序；
//   - queuePosition：0 = 正在生成，1 = 下一个，依此类推；不在通道里 = null；
//   - cancelJob(jobId)：该任务排队中的项直接移除（reject TASK_CANCELLED）；
//     在飞的那一项无法中断 Breeze，但它的结果会被丢弃（同样 reject）。
// 通道只在内存里：服务重启后由 tasks 表的恢复逻辑重新入队。
export const PRIORITY = Object.freeze({ interactive: 0, batch: 1 });

function cancelledError() {
  const error = new Error('任务已取消');
  error.code = 'TASK_CANCELLED';
  return error;
}

export function createLane() {
  const waiting = [];
  let current = null;
  let sequence = 0;

  function pump() {
    if (current || !waiting.length) return;
    waiting.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    current = waiting.shift();
    const item = current;
    Promise.resolve().then(item.fn).then(
      (value) => (item.discarded ? item.reject(cancelledError()) : item.resolve(value)),
      (error) => (item.discarded ? item.reject(cancelledError()) : item.reject(error)),
    ).finally(() => { current = null; pump(); });
  }

  return {
    run({ jobId, priority = PRIORITY.batch, fn }) {
      return new Promise((resolve, reject) => {
        waiting.push({ jobId: String(jobId || ''), priority: priority === PRIORITY.interactive ? 0 : 1, sequence: sequence += 1, fn, resolve, reject, discarded: false });
        pump();
      });
    },
    // 这个任务“最靠前”的一项的位置。
    positionOf(jobId) {
      if (current?.jobId === jobId) return 0;
      const ordered = [...waiting].sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
      const index = ordered.findIndex((item) => item.jobId === jobId);
      return index === -1 ? null : index + (current ? 1 : 0);
    },
    cancelJob(jobId) {
      let removed = 0;
      for (let index = waiting.length - 1; index >= 0; index -= 1) {
        if (waiting[index].jobId !== jobId) continue;
        const [item] = waiting.splice(index, 1);
        item.reject(cancelledError());
        removed += 1;
      }
      const discardedInFlight = current?.jobId === jobId && !current.discarded;
      if (discardedInFlight) current.discarded = true;
      return { removed, discardedInFlight };
    },
    snapshot() {
      return { inFlight: current ? current.jobId : null, waiting: waiting.length };
    },
  };
}

export const breezeLane = createLane();
