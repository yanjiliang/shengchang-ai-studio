import { AlertCircle, AudioWaveform, BrainCircuit, Check, KeyRound, LoaderCircle, Save, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

const providerPresets = {
  demo: { endpoint: '本地内置，无外部请求', resourceId: 'demo', model: 'demo-voice-engine', audioFormat: 'wav' },
  'volcengine-api-key': { endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', resourceId: 'seed-tts-2.0', model: '', audioFormat: 'mp3' },
  custom: { endpoint: '', resourceId: '', model: '', audioFormat: 'mp3' },
};

export function SettingsView({ config, onSave, onTestLlm, onToast, onReload }) {
  const [draft, setDraft] = useState(config);
  const [saving, setSaving] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);
  const [llmResult, setLlmResult] = useState(null);
  const [demoBannerDismissed, setDemoBannerDismissed] = useState(false);

  useEffect(() => setDraft(config), [config]);

  const change = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const changeProvider = (provider) => setDraft((current) => ({ ...current, provider, ...providerPresets[provider] }));
  const save = async () => {
    setSaving(true);
    try { await onSave(draft); onToast('模型连接已保存'); }
    catch (error) { onToast(error.message); }
    finally { setSaving(false); }
  };
  const testLlm = async () => {
    setTestingLlm(true); setLlmResult(null);
    try {
      const result = await onTestLlm(draft);
      setLlmResult({ type: 'success', text: `连接通过 · ${result.latencyMs} ms · 识别到 ${result.sceneCount} 个场景` });
    } catch (error) { setLlmResult({ type: 'error', text: error.message }); }
    finally { setTestingLlm(false); }
  };

  if (!draft) return <main className="asset-view settings-view"><div className="settings-loading"><AlertCircle size={20} /><p>本地配置读取失败，无法编辑。</p><button className="button secondary-button" type="button" onClick={onReload}>重新读取</button></div></main>;
  const requiresCredential = draft.provider !== 'demo';
  return (
    <main className="asset-view settings-view">
      <header className="view-header"><div><span className="view-kicker">凭证仅存储在本机</span><h2>模型连接</h2><p>这里只配置语音与文本模型。角色音色在当前作品的“角色音色”中单独锁定。</p></div><span className={`provider-state ${draft.provider === 'demo' || draft.hasAccessKey ? 'is-ready' : ''}`}><ShieldCheck size={14} />{draft.provider === 'demo' ? '开发测试模式' : draft.hasAccessKey ? '凭证已保存' : '等待配置'}</span></header>
      {draft.provider === 'demo' && !demoBannerDismissed ? <div className="demo-provider-banner"><span>当前为离线演示引擎，生成的是占位音——链路是真的，声音是假的。配置豆包语音 API Key 后即可生成真实语音。</span><button type="button" onClick={() => setDemoBannerDismissed(true)}>知道了</button></div> : null}
      <div className="settings-columns expanded-settings">
        <section className="settings-panel model-settings-panel">
          <div className="settings-panel-head"><KeyRound size={17} /><div><strong>语音模型</strong><p>新版豆包语音仅使用 API Key；角色 voice_id 在“角色音色”中固定。</p></div></div>
          <label className="setting-field"><span>接口类型</span><select value={draft.provider} onChange={(event) => changeProvider(event.target.value)}><option value="volcengine-api-key">豆包语音 · 新版 API Key</option><option value="custom">自定义 HTTP 接口</option><option value="demo">开发测试引擎 · 不用于成片</option></select></label>
          <label className="setting-field"><span>接口地址</span><input value={draft.endpoint} disabled={draft.provider === 'demo'} onChange={(event) => change('endpoint', event.target.value)} /></label>
          {requiresCredential ? <label className="setting-field"><span>{draft.provider === 'volcengine-api-key' ? 'API Key' : '访问凭证'} {draft.hasAccessKey ? <em>已保存 {draft.secretHint}</em> : null}</span><input type="password" value={draft.accessKey} placeholder={draft.hasAccessKey ? '留空则继续使用已保存凭证' : draft.provider === 'volcengine-api-key' ? '新版豆包语音 API Key' : 'Access Key / Token'} autoComplete="new-password" onChange={(event) => change('accessKey', event.target.value)} /></label> : null}
          {draft.provider === 'volcengine-api-key' ? <label className="setting-field"><span>合成模型</span><select value={draft.resourceId} onChange={(event) => { const resourceId = event.target.value; change('resourceId', resourceId); change('model', resourceId === 'seed-icl-2.0' ? 'seed-tts-2.0-standard' : ''); }}><option value="seed-tts-2.0">豆包语音合成模型 2.0 · 官方音色</option><option value="seed-icl-2.0">豆包声音复刻模型 2.0 · 复刻音色</option></select><small>复刻音色必须选“声音复刻模型 2.0”；官方音色无需填写额外模型版本。</small></label> : null}
          {draft.provider === 'custom' ? <label className="setting-field"><span>模型标识</span><input value={draft.model} placeholder="服务端要求的模型名" onChange={(event) => change('model', event.target.value)} /></label> : null}
          {draft.provider === 'custom' ? <><label className="setting-field"><span>自定义请求头 JSON</span><textarea rows="3" value={draft.customHeaders} onChange={(event) => change('customHeaders', event.target.value)} /></label><label className="setting-field"><span>请求体模板</span><textarea rows="5" value={draft.customBodyTemplate} onChange={(event) => change('customBodyTemplate', event.target.value)} /><small>变量：{'{{text}}'}、{'{{voiceId}}'}、{'{{emotion}}'}、{'{{emotionScale}}'}、{'{{speed}}'}、{'{{model}}'}、{'{{subtext}}'}、{'{{distance}}'}</small></label></> : null}
          <div className="settings-actions"><button className="button primary-button" type="button" disabled={saving} onClick={save}><Save size={14} />{saving ? '保存中' : '保存语音连接'}</button></div>
        </section>
        <div className="settings-side-column">
          <section className="settings-panel llm-settings-panel">
            <div className="settings-panel-head"><BrainCircuit size={17} /><div><strong>文本理解模型</strong><p>用于把小说原文拆解为人物、场景、对白和声音事件。</p></div></div>
            <label className="setting-field"><span>Chat Completions 地址</span><input value={draft.llmEndpoint || ''} placeholder="https://.../chat/completions" onChange={(event) => change('llmEndpoint', event.target.value)} /></label>
            <label className="setting-field"><span>API Key {draft.hasLlmApiKey ? <em>已保存 {draft.llmSecretHint}</em> : null}</span><input type="password" value={draft.llmApiKey || ''} placeholder={draft.hasLlmApiKey ? '留空则继续使用已保存凭证' : '文本模型 API Key'} autoComplete="new-password" onChange={(event) => change('llmApiKey', event.target.value)} /></label>
            <label className="setting-field"><span>模型名称</span><input value={draft.llmModel || ''} placeholder="例如 doubao-seed-1-6-250615" onChange={(event) => change('llmModel', event.target.value)} /></label>
            {llmResult ? <div className={`test-result is-${llmResult.type}`}>{llmResult.type === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}<span>{llmResult.text}</span></div> : null}
            <div className="settings-actions"><button className="button secondary-button" type="button" disabled={testingLlm} onClick={testLlm}>{testingLlm ? <LoaderCircle size={14} className="spin" /> : <BrainCircuit size={14} />}{testingLlm ? '正在测试' : '测试文本理解'}</button></div>
          </section>
          <section className="settings-panel sfx-settings-panel">
            <div className="settings-panel-head"><AudioWaveform size={17} /><div><strong>音效与音乐生成</strong><p>在场景里按描述生成音效、环境声与音乐垫，与语音模型相互独立。</p></div></div>
            <label className="setting-field"><span>生成引擎</span><select value={draft.sfxProvider || 'demo'} onChange={(event) => change('sfxProvider', event.target.value)}><option value="demo">演示引擎 · 离线占位音</option><option value="custom">自定义 HTTP 接口（text-to-SFX 服务）</option></select></label>
            {draft.sfxProvider === 'custom' ? <>
              <label className="setting-field"><span>接口地址</span><input value={draft.sfxEndpoint || ''} placeholder="https://.../sound-effects" onChange={(event) => change('sfxEndpoint', event.target.value)} /></label>
              <label className="setting-field"><span>访问凭证 {draft.hasSfxAccessKey ? <em>已保存</em> : null}</span><input type="password" value={draft.sfxAccessKey || ''} placeholder={draft.hasSfxAccessKey ? '留空则继续使用已保存凭证' : 'API Key / Token'} autoComplete="new-password" onChange={(event) => change('sfxAccessKey', event.target.value)} /></label>
              <label className="setting-field"><span>模型标识</span><input value={draft.sfxModel || ''} placeholder="服务端要求的模型名（可选）" onChange={(event) => change('sfxModel', event.target.value)} /></label>
              <label className="setting-field"><span>请求头 JSON</span><textarea rows="2" value={draft.sfxCustomHeaders || '{}'} onChange={(event) => change('sfxCustomHeaders', event.target.value)} /></label>
              <label className="setting-field"><span>请求体模板</span><textarea rows="4" value={draft.sfxCustomBodyTemplate || ''} onChange={(event) => change('sfxCustomBodyTemplate', event.target.value)} /><small>变量：{'{{prompt}}'}、{'{{durationSec}}'}、{'{{type}}'}、{'{{model}}'}；响应需为音频或含 base64 音频的 JSON。</small></label>
            </> : <p className="picker-note">演示引擎产出离线占位音（链路真实，声音为合成示意），用于零密钥体验生成流程。</p>}
          </section>
          <div className="local-security-note"><ShieldCheck size={17} /><div><strong>本地安全边界</strong><p>访问凭证写入 <code>{draft.configPath || '~/.shengchang/config.json'}</code>，文件权限仅限当前用户；浏览器不会读取明文凭证。</p></div></div>
        </div>
      </div>
    </main>
  );
}
