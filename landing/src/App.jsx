import { LISTEN } from './listen.js';
import { AnimatedContent, Aurora, CountUp, SpotlightCard, SplitText, StarBorder } from './components/ReactBits.jsx';

const GITHUB = 'https://github.com/yanjiliang/shengchang-ai-studio';
// 副标题单独一行，方便 Product 改。Design 的备选：「本地运行、开源免费；每个角色用自己的克隆声音」。
const SUBTITLE = '本地运行、开源免费；每个角色都有自己的声音，从头到尾不换人';
const INSTALL_BREEZE = `${GITHUB}#安装-breeze`;
const GithubIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>
);

function Section({ id, kicker, title, sub, children }) {
  return (
    <section id={id}>
      <div className="wrap">
        <AnimatedContent><div className="sec-kicker">{kicker}</div></AnimatedContent>
        <AnimatedContent delay={0.06}><h2>{title}</h2></AnimatedContent>
        {sub ? <AnimatedContent delay={0.12}><p className="sec-sub">{sub}</p></AnimatedContent> : null}
        {children}
      </div>
    </section>
  );
}

function ListenSection({ sample }) {
  return (
    <Section id="listen" kicker="真实成片" title="《西游记》第二十七回，本机 Breeze 配音" sub={sample.sub}>
      <AnimatedContent>
        <div className="listen">
          <audio className="listen-audio" controls preload="none" src={sample.src} aria-label="试听：西游记第二十七回成片">
            你的浏览器不支持在线播放，可以<a href={sample.src}>下载 MP3</a>收听。
          </audio>
          <p className="listen-meta">{sample.meta}</p>
          <p className="listen-note">原文为公版作品 · 示例音频由 Breeze 生成，仅供非商业试听。</p>
          <details className="listen-script">
            <summary>文字稿（{sample.script.length} 句）</summary>
            <ol>
              {sample.script.map(([who, line], i) => <li key={i}><b>{who}</b>{line}</li>)}
            </ol>
          </details>
        </div>
      </AnimatedContent>
    </Section>
  );
}

export function App() {
  return (
    <>
      <nav className="nav">
        <div className="wrap nav-inner">
          <a className="brand" href="#"><img src="assets/icon-256.png" alt="" /><span>声场</span><small>SHENGCHANG</small></a>
          <div className="nav-links">
            {LISTEN ? <a className="hide-sm" href="#listen">先听一段</a> : null}
            <a className="hide-sm" href="#features">核心能力</a>
            <a className="hide-sm" href="#pipeline">制作管线</a>
            <a className="hide-sm" href="#zero">零密钥体验</a>
            <a className="hide-sm" href="#requirements">运行要求</a>
            <a className="hide-sm" href="#quickstart">快速开始</a>
            <a className="gh" href={GITHUB} target="_blank" rel="noopener"><GithubIcon />GitHub</a>
          </div>
        </div>
      </nav>

      <header className="hero">
        <Aurora />
        <div className="wrap hero-inner">
          <div>
            <AnimatedContent delay={0.05}>
              <span className="kicker">多人广播剧工作台 · 本地运行 · MIT 开源</span>
            </AnimatedContent>
            <h1>
              <SplitText text="一部小说，" />
              <br />
              <SplitText text="一键变成多人广播剧" accent="广播剧" initialDelay={0.55} />
            </h1>
            <AnimatedContent delay={1.15}><p className="sub"><strong>{SUBTITLE}。</strong>粘贴一章小说，声场把它拆成场景与角色，逐句生成带表演方向的配音，混入声音世界，导出广播响度标准的整集成片。</p></AnimatedContent>
            <AnimatedContent delay={1.3}>
              <div className="cta-row">
                <StarBorder className="cta-star">
                  <a className="btn btn-primary" href={GITHUB} target="_blank" rel="noopener">进入 GitHub 仓库</a>
                </StarBorder>
                <a className="btn btn-ghost" href={LISTEN ? '#listen' : '#quickstart'}>{LISTEN ? '先听一段 →' : '三分钟跑通示例 →'}</a>
              </div>
            </AnimatedContent>
            <AnimatedContent delay={1.45}>
              <div className="hero-meta">
                <span><b><CountUp to={20} /></b> 条内置 CC0 素材</span>
                <span><b><CountUp to={5} /></b> 阶段断点流水线</span>
                <span><b><CountUp to={0} /></b> 密钥即可跑通</span>
                <span>项目和音频<b> 只存在你的电脑上</b></span>
              </div>
            </AnimatedContent>
          </div>
          <AnimatedContent delay={0.9} distance={44} className="hero-art-anim">
            <figure className="hero-art">
              <img src="assets/launch-cover.jpg" alt="声场工作台" />
              <figcaption>WORKBENCH · 场景导演 / 方向实验室 / 混音时间轴</figcaption>
            </figure>
          </AnimatedContent>
        </div>
      </header>

      {LISTEN ? <ListenSection sample={LISTEN} /> : null}

      <Section id="features" kicker="为什么是声场" title="不只是一台配音机，是一位能被你指挥的导演" sub="市面上的工具停在“角色换个音色”。声场把每一句台词的表演——情绪、强度、潜台词、声音距离——变成可编辑、可缓存、可断点恢复的生产参数。">
        <div className="grid-3">
          {[
            { chip: '◆ 导演层', title: '逐句调表演', body1: '每句台词独立携带情绪 / 强度 / 潜台词 / 声音距离，折叠为一条语音指令送入模型。', body2: '方向实验室：同一句台词三种演法并排试听，满意再应用——应用后再生成立即命中缓存。', spot: 'rgb(240 150 60 / 12%)' },
            { chip: '◆ 工程可靠性', title: '一条流水线跑完整本书', body1: '拆解 → 音色 → 生成 → 体检 → 导出，五阶段断点续跑；单句失败不废整批，重试只补失败句。', body2: '没改过的句子不会重配，也不会重复扣费；300 多句的整集，审听页 2 秒内打开。', spot: 'rgb(103 212 174 / 10%)' },
            { chip: '◆ 本地优先', title: '项目和音频攥在自己手里', body1: '项目、音频与任务全部留在本机；凭证权限 0600，服务只绑回环地址。', body2: '语音引擎四选一：本机 Breeze（免费、离线、声音克隆）/ 豆包语音 / 自定义 HTTP / 离线演示。各引擎的设置分开保存，切换不丢配置。', spot: 'rgb(180 140 232 / 12%)' },
          ].map((card, index) => (
            <AnimatedContent key={card.title} delay={index * 0.12}>
              <SpotlightCard className="card" spotlightColor={card.spot}>
                <span className="chip">{card.chip}</span>
                <h3>{card.title}</h3>
                <p>{card.body1}</p>
                <p>{card.body2}</p>
              </SpotlightCard>
            </AnimatedContent>
          ))}
        </div>
      </Section>

      <Section id="pipeline" kicker="制作管线" title="从一章小说到一集成片" sub="每个环节都有可视化界面与质量检查，任何一步都可以人工介入修正。">
        <div className="pipe">
          {[
            { i: '01', b: '小说导入', s: 'TXT 粘贴或上传' },
            { i: '02', b: '智能拆解', s: '场景 / 角色 / 对白 / 声音事件' },
            { i: '03', b: '音色映射', s: '声音克隆（5–30 秒录音）/ 豆包音色' },
            { i: '04', b: '导演与生成', s: '逐句表演参数 · 方向实验室', accent: true },
            { i: '05', b: '声音世界', s: '推荐 / 内置 CC0 / AI 生成 / 导入' },
            { i: '06', b: '混音导出', s: '侧链闪避 · 整集 MP3 + 来源清单' },
          ].map((step, index) => (
            <AnimatedContent key={step.i} delay={index * 0.1} distance={22} className={`step-slot ${step.accent ? 'is-accent-slot' : ''}`}>
              <div className={`step ${step.accent ? 'is-accent' : ''}`}><i>{step.i}</i><b>{step.b}</b><small>{step.s}</small></div>
            </AnimatedContent>
          ))}
        </div>
      </Section>

      <Section id="zero" kicker="零密钥体验" title="装完即跑，先听为敬">
        <div className="zero">
          <AnimatedContent distance={26}>
            <ul>
              <li><span><b>示例项目自动就位</b>：《西游记 · 三打白骨精》公版节选，19 句台词带完整导演参数。</span></li>
              <li><span><b>离线演示引擎</b>：不配任何密钥即可体验完整的一键成片流水线。</span></li>
              <li><span><b>内置 CC0 素材库</b>：20 条环境声 / 音效 / 音乐情绪床，按描述智能推荐。</span></li>
              <li><span><b>规则拆解兜底</b>：没有文本模型也能导入自己的小说（标记人工校对）。</span></li>
            </ul>
            <p className="note"><b>演示引擎的定位：链路是真的，声音是假的。</b>接上本机 Breeze 就是免费的真实人声；想用云端，也可以填豆包语音的 Key。</p>
          </AnimatedContent>
          <AnimatedContent delay={0.15} distance={30}>
            <div className="code">
              <header><i /><i /><i /><span>TERMINAL</span></header>
              <pre><span className="c"># 需要 Node.js 22.5+ 与 FFmpeg</span>{'\n'}<span className="p">$</span> git clone https://github.com/yanjiliang/shengchang-ai-studio{'\n'}<span className="p">$</span> cd shengchang-ai-studio{'\n'}<span className="p">$</span> npm install{'\n'}<span className="p">$</span> npm run dev{'\n\n'}<span className="a">➜</span> 工作台  http://127.0.0.1:4173{'\n'}<span className="a">➜</span> 制作中心 → 一键成片 → 等待整集 MP3</pre>
            </div>
          </AnimatedContent>
        </div>
      </Section>

      <Section id="requirements" kicker="运行要求" title="装在你自己的电脑上">
        <AnimatedContent distance={26}>
          <ul className="reqs">
            <li><span><b>在本机运行 Breeze</b>：声场默认连接 <code>http://127.0.0.1:4180</code>，配音在本机完成。</span></li>
            <li><span><b>Breeze 权重自己下载</b>：权重许可仅限非商业用途，声场不附带、不分发权重。</span></li>
            <li><span><b>自己配文本模型</b>：任意 OpenAI 兼容服务，填 Base URL、Key 和模型名。</span></li>
            <li><span><b>电脑</b>：目前只支持 Apple Silicon（M 系列）的 Mac（Intel Mac、Windows、Linux 暂不支持）。</span></li>
            <li><span><b>内存</b>：跑完整一集内存峰值约 12 GB，建议 24 GB 以上（16 GB 未测试）。</span></li>
            <li><span><b>磁盘</b>：首次需下载约 7.1 GB 的 Breeze 权重。</span></li>
            <li><span><b>基础环境</b>：Node.js 22.5+，FFmpeg 与 ffprobe 在 PATH 中。</span></li>
          </ul>
          <p className="reqs-link">安装步骤见 README 的 <a href={INSTALL_BREEZE} target="_blank" rel="noopener">「安装 Breeze」</a>。</p>
        </AnimatedContent>
      </Section>

      <Section id="quickstart" kicker="三分钟跑通" title="你的第一集成片" sub="克隆、安装、运行，打开示例项目点「一键成片」——预估、进度、注意事项与逐句失败重试都在任务历史里等你。">
        <AnimatedContent>
          <div className="code">
            <header><i /><i /><i /><span>QUICKSTART</span></header>
            <pre><span className="c"># 打开示例项目「西游记 · 三打白骨精」</span>{'\n'}<span className="c"># 1. 制作中心 → 一键成片 → 确认预估</span>{'\n'}<span className="c"># 2. 自动执行：拆解 → 配音色 → 生成 → 体检 → 导出</span>{'\n'}<span className="c"># 3. 下载整集 MP3 与《来源清单》</span>{'\n\n'}<span className="c"># 想要真实人声？启动本机 Breeze，设置页选 Breeze（见 README）</span>{'\n'}<span className="c"># 想拆自己的小说？设置页填文本模型的 Base URL、Key 和模型名（OpenAI 兼容），点「测试连接」</span></pre>
          </div>
          <p className="reqs-link">真实人声需要本机 Breeze（只支持 Apple Silicon Mac），安装见 README 的 <a href={INSTALL_BREEZE} target="_blank" rel="noopener">「安装 Breeze」</a>。</p>
        </AnimatedContent>
      </Section>

      <footer>
        <div className="wrap foot-inner">
          <div className="foot-brand">
            <img src="assets/logo-light.png" alt="声场" />
            <div><strong>声场 SHENGCHANG</strong><small>一部小说，一键变成多人广播剧。</small></div>
          </div>
          <div className="foot-links">
            <a href={GITHUB} target="_blank" rel="noopener">GitHub</a>
            <a href={`${GITHUB}/discussions`} target="_blank" rel="noopener">讨论区</a>
            <a href={`${GITHUB}/blob/main/README.md`} target="_blank" rel="noopener">文档</a>
          </div>
        </div>
        <div className="wrap foot-note">MIT 开源 · 本地运行，项目和音频只存在你的电脑上 · Breeze 权重许可仅限非商业用途 · 声场与豆包、火山引擎等商标无隶属关系。</div>
      </footer>
    </>
  );
}
