import { AlertTriangle, Check, CheckCircle2, ChevronRight, RefreshCcw, ShieldCheck, WandSparkles } from 'lucide-react';

function Metric({ label, value }) {
  return <div className="quality-metric"><span>{label}</span><strong>{value}%</strong><div><i style={{ width: `${value}%` }} /></div></div>;
}

export function QualityView({ report, onToast, onExport, onOpenProduction, onGenerateMissing, onRegenerateStale, generating, exporting }) {
  const issueAction = (issue) => {
    if (issue.id === 'coverage') return onGenerateMissing;
    if (issue.id === 'stale') return onRegenerateStale;
    if (issue.id === 'media') return onOpenProduction;
    return () => onToast(issue.actionMessage);
  };
  const issueLabel = (issue) => {
    if (issue.id === 'coverage') return generating ? '正在补全' : '补全对白';
    if (issue.id === 'stale') return generating ? '正在生成' : '重新生成';
    if (issue.id === 'media') return '查看制作';
    return issue.action;
  };
  return (
    <main className="asset-view quality-view">
      <header className="view-header"><div><span className="view-kicker">本地实时审听</span><h2>质量审听</h2><p>根据当前场景的音频覆盖、角色映射、声音素材与文本状态生成检查结果。</p></div><button className="button primary-button" type="button" onClick={() => onToast(`检查完成：${report.issues.length} 项需要处理`)}><RefreshCcw size={15} />重新检查</button></header>
      <section className="quality-summary"><div className="score-ring"><strong>{report.score}</strong><span>本场质量</span></div><Metric label="对白覆盖" value={report.metrics.coverage} /><Metric label="音频健康" value={report.metrics.media ?? 100} /><Metric label="角色音色" value={report.metrics.voices} /><Metric label="声音世界" value={report.metrics.soundWorld} /><Metric label="文本状态" value={report.metrics.text} /></section>
      <div className="quality-body"><section className="issue-list"><div className="issue-head"><div><ShieldCheck size={16} /><strong>检查结果</strong><span>{report.issues.length} 个建议 · {report.passed.length} 项通过</span></div>{report.metrics.coverage < 100 ? <button type="button" disabled={generating} onClick={onGenerateMissing}><WandSparkles size={14} />{generating ? '正在补全' : '补全缺失对白'}</button> : <button type="button" onClick={onOpenProduction}><WandSparkles size={14} />打开制作中心</button>}</div>
        {[...report.issues, ...report.passed].map((issue) => <article className={`issue-row issue-${issue.level}`} key={issue.id}><span className="issue-icon">{issue.level === 'passed' ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}</span><div className="issue-copy"><div><strong>{issue.title}</strong><span>{issue.scope}</span></div><p>{issue.detail}</p></div><button className="button tertiary-button" type="button" onClick={issueAction(issue)} disabled={generating && ['coverage', 'stale'].includes(issue.id)}>{issueLabel(issue)}<ChevronRight size={13} /></button></article>)}
      </section><aside className="export-readiness"><div className="section-caption">导出准备</div><h3>{report.canExport ? '可以生成本场成片' : '暂时不能导出'}</h3><p>{report.canExport ? '系统会拼接对白、混入已绑定声床，并执行响度标准化。' : report.metrics.media < 100 ? '存在无法读取的音频文件，请修复后再导出。' : '至少需要生成一条有效对白音频。'}</p><ul><li><Check size={13} />48 kHz 双声道</li><li><Check size={13} />峰值低于 -1 dBTP</li><li><Check size={13} />MP3 192 kbps</li><li className={report.metrics.media < 100 ? 'needs-attention' : ''}>{report.metrics.media < 100 ? <AlertTriangle size={13} /> : <Check size={13} />}{report.metrics.media < 100 ? '音频文件健康检查未通过' : '音频文件可正常解码'}</li><li className={report.metrics.soundWorld < 100 ? 'needs-attention' : ''}>{report.metrics.soundWorld < 100 ? <AlertTriangle size={13} /> : <Check size={13} />}{report.metrics.soundWorld < 100 ? '背景音乐/环境声仍有未绑定项' : '声音事件已绑定素材'}</li></ul><button className="button secondary-button full-button" type="button" disabled={!report.canExport || exporting} onClick={onExport}>{exporting ? '正在混音导出' : '导出当前场景 MP3'}</button></aside></div>
    </main>
  );
}
