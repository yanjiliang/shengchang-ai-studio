// 语音生成任务的“诚实计费”展示（对应后端 0005 的 summarizeBilling）。
// 任务 result 字段：
//   freshCount        新生成（调用了接口）的句数
//   cacheHits         复用缓存的句数：未调用接口、不计费
//   billedCharacters  已知的计费字数之和；没有任何句子返回用量时为 null
//   missingUsageCount 本该返回用量（豆包 API Key）却没返回的新生成句数
// 0005 之前的旧任务没有 freshCount：能从 results[].cached 推出来就推，推不出就不显示。

const count = (value) => (Number.isFinite(value) ? value : null);

export function billingSummary(result) {
  if (!result) return null;
  let freshCount = count(result.freshCount);
  let cacheHits = count(result.cacheHits);
  if (freshCount === null && Array.isArray(result.results)) {
    cacheHits = result.results.filter((item) => item.cached).length;
    freshCount = result.results.length - cacheHits;
  }
  if (freshCount === null) return null;
  cacheHits = cacheHits ?? 0;
  const missingUsageCount = count(result.missingUsageCount) ?? 0;
  const billed = count(result.billedCharacters);
  // 全部命中缓存时后端给 null（没有用量可加），但实际就是 0 字。
  const billedCharacters = billed ?? (freshCount === 0 ? 0 : null);
  return { freshCount, cacheHits, billedCharacters, missingUsageCount };
}

export function billingText(summary) {
  if (!summary) return '';
  const { freshCount, cacheHits, billedCharacters, missingUsageCount } = summary;
  const billed = billedCharacters === null
    ? '未返回计费字数'
    : missingUsageCount ? `已知计费 ${billedCharacters} 字` : `计费 ${billedCharacters} 字`;
  return `本次新生成 ${freshCount} 句，复用缓存 ${cacheHits} 句（未调用接口、不计费），${billed}`;
}

export function missingUsageText(summary) {
  if (!summary?.missingUsageCount) return '';
  return `${summary.missingUsageCount} 句新生成的语音没有返回计费字数，计费字数只含已知部分`;
}

// 一键成片预估（/one-click-estimate）：
//   cacheHits             已绑定音色那部分句子的预计命中数；一句都还没绑定时为 null
//   cacheHitsUnknownCount 还没绑定音色、要等选角后才知道缓存键的句数
// 只要有未知部分就不能说“命中 0 句”。
export function estimateCacheText(estimate) {
  if (!estimate) return '';
  const unknown = Number(estimate.cacheHitsUnknownCount) || 0;
  const hits = count(estimate.cacheHits);
  // fe-0010（Design）：一句都还没绑音色 = 没有数据，这一行整行不显示（以前是「预计缓存命中：未知（…）」）。
  if (hits === null) return '';
  if (unknown > 0) return `预计缓存命中：至少 ${hits} 句，另有 ${unknown} 句未知（部分角色还没分配音色，无法预估缓存）`;
  return hits ? `预计缓存命中 ${hits} 句` : '';
}

// 一键成片费用一行（Design 定稿）。返回 { main, note }：main 是主数字，note 是小字。
//   characters                  全部待生成句的字数，是上限（没扣缓存）
//   estimatedBillableCharacters 0007：已绑音色、且不是已知缓存命中的字数；一句都没绑音色时为 null
//   unknownCharacters           0007：还没绑音色的句子字数，绑完才知道能不能复用缓存
// 只要还有未知部分就给区间，不给一个看起来很确定的单数。旧接口（无 0007 字段）同样给区间。
export function estimateCostText(estimate) {
  if (!estimate) return { main: '', note: '' };
  // 全部已有音频：0 句要生成。0007 对空列表会给 estimatedBillableCharacters=null（像“未知”），
  // 后端以后也可能改成 0；两种都按 requestCount 直接判定为无需扣费。
  if (estimate.requestCount === 0) return { main: '无需扣费，全部已有音频', note: '' };
  if (estimate.provider === 'demo') return { main: '离线演示引擎 · 免费', note: '' };
  const total = count(estimate.characters) ?? 0;
  const unknownLines = Number(estimate.cacheHitsUnknownCount) || 0;
  const has0007 = 'estimatedBillableCharacters' in estimate || 'unknownCharacters' in estimate;
  let low;
  let high;
  if (has0007) {
    low = count(estimate.estimatedBillableCharacters) ?? 0;
    high = Math.min(total, low + (count(estimate.unknownCharacters) ?? 0));
  } else if (unknownLines === 0 && count(estimate.cacheHits) === 0) {
    low = total; high = total; // 全部已绑音色且一句都不命中缓存：上限就是实际
  } else {
    low = 0; high = total; // 旧接口不知道命中句的字数，只能给 0 到上限
  }
  // 0008：有句子但都能复用缓存时 estimatedBillableCharacters=0 且没有未知部分 → 无需扣费。
  if (has0007 && high === 0 && unknownLines === 0) return { main: '无需扣费', note: '' };
  return {
    main: low === high ? `真实语音 · 预计扣费约 ${low} 字` : `真实语音 · 预计扣费 ${low}–${high} 字`,
    note: unknownLines > 0 ? `有 ${unknownLines} 句还没分音色，暂时算不出能不能复用缓存` : `最多 ${total} 字，未计入缓存`,
  };
}

// 逐句结果用的是哪个音色：0007 起 results[].voiceId 是实际合成用的音色（缓存命中、
// 磁盘恢复、新生成都带），优先用它；旧任务没有就回退到当前项目的 voiceMap 推断。
// 逐句计费字数：生成任务在 usage.billedCharacters，一键成片（0007）直接给 billedCharacters。
export function resultBilledCharacters(item) {
  if (Number.isFinite(item?.usage?.billedCharacters)) return item.usage.billedCharacters;
  return Number.isFinite(item?.billedCharacters) ? item.billedCharacters : null;
}

export function resultVoiceId(item, { voiceMap, speakerByLine } = {}) {
  if (item?.voiceId) return item.voiceId;
  const speakerId = speakerByLine?.get?.(item?.lineId);
  return (speakerId && voiceMap?.[speakerId]) || '';
}
