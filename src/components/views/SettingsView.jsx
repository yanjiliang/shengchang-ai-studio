import { AlertCircle, AudioWaveform, BrainCircuit, Check, Cpu, Eye, EyeOff, KeyRound, LoaderCircle, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { HEADERS_REENTER, REENTER_KEY, configForSave, hasSavedHeaderSecret, llmSecretState, maskHeaders, providerSaved, secretState, ttsDraftFor, unmaskHeaders } from '../../lib/secrets.js';
import { sameEndpoint } from '../../../shared/endpoint.mjs';
import { TTS_UI_PRESETS } from '../../../shared/tts-presets.mjs';
import { effectiveTtsEndpoint } from '../../../server/tts-providers.js';
import { LLM_BASE_PLACEHOLDER, LLM_KEY_NOTE, LLM_MODEL_PLACEHOLDER, llmBaseHint, llmFieldErrors, llmFingerprint, llmKeyPlaceholder, llmTestOutcome, llmUrlChanged, normalizeLlmBase, writeLlmVerified } from '../../lib/llm.js';
import { BREEZE_DEFAULT_BASE, BREEZE_HARDWARE_NOTE, BREEZE_LICENSE_FULL, BREEZE_START_HINT, BREEZE_TIME_NOTE, DOUBAO_PRESET, breezeBaseHint, breezeBaseOf, breezePreset, normalizeBreezeBase, engineOf, llmKeyRequired, needsCredential } from '../../lib/engine.js';
import { useBreezeStatus } from '../../lib/useBreezeStatus.js';

// 配音引擎二选一：本地 Breeze-TTS-2（不计费，按时间）/ 豆包语音（按字计费，可导演）。
// 演示引擎和自定义接口留在下面的「接口类型」里。
export function EngineSwitch({ draft, savedConfig, onPick, status, checking, onRefresh }) {
  const engine = engineOf(draft);
  const base = engine === 'breeze' ? breezeBaseOf(draft) : '';
  const options = [
    { id: 'breeze', title: '本地 Breeze-TTS-2', text: '在本机生成，不按字计费；按声音描述设计角色音色', pick: () => onPick(breezePreset(engine === 'breeze' ? base : savedConfig?.breezeEndpoint || BREEZE_DEFAULT_BASE)) },
    { id: 'doubao', title: '豆包语音', text: '火山引擎云端合成，按台词字数扣费；部分音色可导演', pick: () => onPick(DOUBAO_PRESET) },
  ];
  return (
    <div className="engine-switch">
      <div className="engine-options" role="radiogroup" aria-label="配音引擎">
        {options.map((option) => <button key={option.id} type="button" role="radio" aria-checked={engine === option.id} className={`engine-option ${engine === option.id ? 'is-selected' : ''}`} onClick={option.pick}><span className="engine-option-mark" aria-hidden="true">{engine === option.id ? <Check size={12} /> : null}</span><strong>{option.title}</strong><small>{option.text}</small></button>)}
      </div>
      {engine === 'breeze' ? (
        <div className="breeze-settings">
          <div className={`breeze-status is-${status.state}`} role="status"><span className="breeze-status-dot" aria-hidden="true" /><strong>Breeze 服务 · {status.label}</strong>{status.detail ? <small>{status.detail}</small> : null}<button className="button ghost-button" type="button" disabled={checking} onClick={onRefresh}>{checking ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}重新检测</button></div>
          {status.state === 'disconnected' ? <p className="breeze-hint">{BREEZE_START_HINT}</p> : null}
          {status.state === 'unknown' ? <p className="breeze-hint">服务端还没有提供 Breeze 状态接口，保存后用一句台词试生成来确认连接。</p> : null}
          <label className="setting-field"><span>Breeze 服务地址</span><input value={draft.provider === 'breeze' ? draft.breezeEndpoint ?? '' : base} placeholder={BREEZE_DEFAULT_BASE} onChange={(event) => onPick({ provider: 'breeze', breezeEndpoint: event.target.value })} /><small>由声场服务端连接这个地址，浏览器不直接连 Breeze。只填 http://主机:端口，不用加 /tts。</small>{breezeBaseHint(draft.breezeEndpoint) ? <small className="field-warning" role="note">{breezeBaseHint(draft.breezeEndpoint)}</small> : null}</label>
          <ul className="breeze-notes">
            <li><Cpu size={13} aria-hidden="true" />{BREEZE_HARDWARE_NOTE}</li>
            <li><LoaderCircle size={13} aria-hidden="true" />{BREEZE_TIME_NOTE}；一次只生成一句，不按字计费。</li>
            <li className="license-note"><ShieldCheck size={13} aria-hidden="true" />{BREEZE_LICENSE_FULL}</li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}


// 密钥输入：已保存时只显示「已设置 ···abc」+「更换」；点更换（或地址改了需要重填）才出输入框，带「显示」。
export function SecretField({ label, state, value, onChange, placeholder, note, error, autoFocusOnOpen = true }) {
  const id = useId();
  const inputRef = useRef(null);
  const [replacing, setReplacing] = useState(false);
  const [show, setShow] = useState(false);
  useEffect(() => { if (replacing && autoFocusOnOpen) inputRef.current?.focus(); }, [replacing, autoFocusOnOpen]);
  const collapsed = state.kept && !replacing && !String(value || '');
  return (
    <div className="setting-field secret-field">
      <label htmlFor={collapsed ? undefined : id} id={`${id}-label`}>{label} {state.kept ? <em className="key-saved">{state.label}</em> : null}</label>
      {collapsed
        ? <div className="secret-saved"><button type="button" className="button ghost-button" aria-describedby={`${id}-label`} onClick={() => setReplacing(true)}>更换</button></div>
        : <div className="secret-input"><input id={id} ref={inputRef} type={show ? 'text' : 'password'} value={value || ''} placeholder={state.kept ? '留空就继续用已设置的 Key' : placeholder} aria-invalid={Boolean(error)} aria-describedby={`${id}-note`} autoComplete="new-password" spellCheck={false} onChange={(event) => onChange(event.target.value)} /><button type="button" className="button ghost-button" aria-pressed={show} aria-controls={id} onClick={() => setShow(!show)}>{show ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}{show ? '隐藏' : '显示'}</button></div>}
      <span id={`${id}-note`}>{error ? <small className="field-error" role="alert">{error}</small> : null}{state.reenter ? <small className="field-warning" role="note">{REENTER_KEY}</small> : null}{note ? <small>{note}</small> : null}</span>
    </div>
  );
}

// 请求头 JSON：已保存的密钥值显示成「已保存，不显示」，保存时换回 __SAVED_SECRET__ 原样送回。
function HeadersField({ label, value, onChange, moved, rows = 3 }) {
  return <label className="setting-field"><span>{label}</span><textarea rows={rows} value={maskHeaders(value || '{}')} spellCheck={false} onChange={(event) => onChange(unmaskHeaders(event.target.value))} />{hasSavedHeaderSecret(value) ? <small className={moved ? 'field-warning' : ''} role={moved ? 'note' : undefined}>{moved ? HEADERS_REENTER : '「已保存，不显示」的值保存时原样保留。'}</small> : null}</label>;
}

// 文本模型（Design）：Base URL + API Key + 模型名 +「测试连接」。和 Breeze 分开，自己的保存按钮；
// 没测试也能保存，但导入小说要等测试通过（llm.js llmReady）。
export function LlmSettings({ draft, config, keyRequired, onChange, onSave, onTest }) {
  const ids = { base: useId(), model: useId(), result: useId() };
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [errors, setErrors] = useState({});
  const [strippedHint, setStrippedHint] = useState('');
  // 改了地址 / Key / 模型名，上一次的测试结果就不算数了。
  const edit = (field, value) => { setResult(null); setErrors((current) => ({ ...current, [field]: undefined })); onChange(field, value); };
  const urlChanged = llmUrlChanged(draft.llmEndpoint, config.llmEndpoint);
  // 服务端规则：换了地址又没填新 Key，已保存的 Key 不再沿用（保存时会清掉）。
  const keyState = llmSecretState({ hasKey: config.hasLlmApiKey, hint: config.llmSecretHint, savedEndpoint: config.llmEndpoint, draftEndpoint: draft.llmEndpoint, typedKey: draft.llmApiKey });
  const keySaved = keyState.kept;
  const fields = () => { const { base, stripped } = normalizeLlmBase(draft.llmEndpoint); return { fields: { llmEndpoint: base, llmModel: String(draft.llmModel || '').trim(), llmApiKey: String(draft.llmApiKey || '').trim() }, stripped }; };
  const tidy = () => {
    const { fields: next, stripped } = fields();
    if (next.llmEndpoint !== draft.llmEndpoint) onChange('llmEndpoint', next.llmEndpoint);
    setStrippedHint(stripped ? llmBaseHint(draft.llmEndpoint) : '');
    return next;
  };
  const save = async () => {
    const next = tidy();
    const found = llmFieldErrors({ ...draft, ...next, hasLlmApiKey: keySaved }, { keyRequired });
    setErrors(found);
    if (found.llmModel || found.llmEndpoint) { document.getElementById(found.llmEndpoint ? ids.base : ids.model)?.focus(); return; }
    setSaving(true);
    try {
      const saved = await onSave(next);
      // 刚测通的就是这套设置：存完按保存后的样子记一次，导入时认得出来。
      if (result?.ok && result.fingerprint === llmFingerprint({ ...draft, ...next })) writeLlmVerified(saved, { latencyMs: result.latencyMs });
      onChange('llmApiKey', '');
    } catch (error) { setResult({ ok: false, text: error.message }); }
    finally { setSaving(false); }
  };
  const test = async () => {
    const next = tidy();
    setTesting(true); setResult(null); setErrors({});
    try {
      const outcome = llmTestOutcome(await onTest(next));
      const fingerprint = llmFingerprint({ ...draft, ...next });
      setResult({ ...outcome, fingerprint });
      if (outcome.field) setErrors({ [outcome.field]: outcome.text });
      // 测的就是已保存的设置（没改地址 / 模型 / Key）：直接记为连通。
      if (outcome.ok && !next.llmApiKey && !urlChanged && next.llmModel === String(config.llmModel || '').trim()) writeLlmVerified(config, { latencyMs: outcome.latencyMs });
    } catch (error) {
      const outcome = llmTestOutcome(error);
      setResult(outcome);
      if (outcome.field) setErrors({ [outcome.field]: outcome.text });
    } finally { setTesting(false); }
  };
  const unsavedVerified = result?.ok && (fields().fields.llmApiKey || urlChanged || fields().fields.llmModel !== String(config.llmModel || '').trim());
  return (
    <section className="settings-panel llm-settings-panel" aria-labelledby={`${ids.base}-title`}>
      <div className="settings-panel-head"><BrainCircuit size={17} /><div><strong id={`${ids.base}-title`}>文本模型</strong><p>用来把小说拆成角色、场景和台词。填任意 OpenAI 兼容服务的地址、Key 和模型名。</p></div></div>
      <label className="setting-field" htmlFor={ids.base}><span>Base URL</span><input id={ids.base} value={draft.llmEndpoint || ''} placeholder={LLM_BASE_PLACEHOLDER} aria-invalid={Boolean(errors.llmEndpoint)} aria-describedby={`${ids.base}-hint`} onChange={(event) => { setStrippedHint(''); edit('llmEndpoint', event.target.value); }} />
        <span id={`${ids.base}-hint`}>{errors.llmEndpoint ? <small className="field-error" role="alert">{errors.llmEndpoint}</small> : null}{strippedHint || llmBaseHint(draft.llmEndpoint) ? <small className="field-warning" role="note">{strippedHint || llmBaseHint(draft.llmEndpoint)}</small> : null}</span></label>
      <SecretField label="API Key" state={keyState} value={draft.llmApiKey} onChange={(value) => edit('llmApiKey', value)} placeholder={llmKeyPlaceholder(keyRequired)} note={LLM_KEY_NOTE} error={errors.llmApiKey} />
      <label className="setting-field" htmlFor={ids.model}><span>模型名 <em className="required-mark">必填</em></span><input id={ids.model} value={draft.llmModel || ''} required aria-required="true" aria-invalid={Boolean(errors.llmModel)} placeholder={LLM_MODEL_PLACEHOLDER} onChange={(event) => edit('llmModel', event.target.value)} />{errors.llmModel ? <small className="field-error" role="alert">{errors.llmModel}</small> : null}</label>
      <div className="llm-test-result" id={ids.result} role="status" aria-live="polite">{result && !result.field ? <div className={`test-result is-${result.ok ? 'success' : 'error'}`}>{result.ok ? <Check size={14} /> : <AlertCircle size={14} />}<span>{result.text}{unsavedVerified ? '（记得保存）' : ''}</span></div> : null}</div>
      <div className="settings-actions"><button className="button secondary-button" type="button" aria-disabled={testing} onClick={() => { if (!testing) test(); }}>{testing ? <LoaderCircle size={14} className="spin" /> : <BrainCircuit size={14} />}{testing ? '正在测试' : '测试连接'}</button><button className="button primary-button" type="button" aria-disabled={saving} onClick={() => { if (!saving) save(); }}><Save size={14} />{saving ? '保存中' : '保存文本模型'}</button></div>
    </section>
  );
}

// 和服务端同一份预设（shared/tts-presets.mjs TTS_UI_PRESETS），不在前端另抄一份。
const providerPresets = TTS_UI_PRESETS;

export function SettingsView({ config, onSave, onTestLlm, onToast, onReload }) {
  const [draft, setDraft] = useState(config);
  const [saving, setSaving] = useState(false);
  const [demoBannerDismissed, setDemoBannerDismissed] = useState(false);

  useEffect(() => setDraft(config), [config]);
  const breeze = useBreezeStatus(true);
  // 服务端按已保存的地址算 llmApiKeyRequired；草稿改了地址就按同一规则现算。
  const llmKeyNeeded = (draft.llmEndpoint || '') === (config.llmEndpoint || '') && typeof config.llmApiKeyRequired === 'boolean' ? config.llmApiKeyRequired : llmKeyRequired(draft.llmEndpoint);

  const change = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  // 切引擎时带上那个引擎自己已保存的地址（0035 起每个引擎各存一份；之前只有当前保存的那个）。
  // 切引擎（0035）：载入那个引擎自己已保存的配置，没有才用预设。引擎只在用户自己点了之后才变。
  const pickPreset = (preset) => setDraft((current) => ({ ...current, ...ttsDraftFor(config || {}, preset.provider, providerPresets), ...(preset.provider === 'breeze' ? preset : {}) }));
  const changeProvider = (provider) => pickPreset({ provider });
  const ttsSaved = providerSaved(config || {}, draft?.provider);
  // 豆包空地址 = 官方默认地址：和服务端一样按 effectiveTtsEndpoint 比较，免得误报「改了地址」。
  const ttsKey = secretState({ hasKey: ttsSaved?.hasKey, hint: ttsSaved?.hint, savedEndpoint: effectiveTtsEndpoint(draft?.provider, ttsSaved?.endpoint), draftEndpoint: effectiveTtsEndpoint(draft?.provider, draft?.endpoint), typedKey: draft?.accessKey });
  const sfxKey = secretState({ hasKey: config?.hasSfxAccessKey, hint: config?.sfxSecretHint, savedEndpoint: config?.sfxEndpoint, draftEndpoint: draft?.sfxEndpoint, typedKey: draft?.sfxAccessKey });
  const save = async () => {
    setSaving(true);
    const voiceDraft = configForSave({ ...draft, llmEndpoint: config.llmEndpoint, llmModel: config.llmModel, llmApiKey: '' });
    try { await onSave(draft.provider === 'breeze' && draft.breezeEndpoint ? { ...voiceDraft, breezeEndpoint: normalizeBreezeBase(draft.breezeEndpoint) } : voiceDraft); onToast('语音连接已保存'); }
    catch (error) { onToast(error.message); }
    finally { setSaving(false); }
  };
  // 两块各存各的：语音那块不改文本模型字段，文本模型那块不改语音字段（服务端 PUT 是合并）。
  const saveLlm = async (fields) => {
    const saved = await onSave(configForSave({ ...config, ...fields }));
    onToast('文本模型设置已保存');
    return saved;
  };

  if (!draft) return <main className="asset-view settings-view"><div className="settings-loading"><AlertCircle size={20} /><p>本地配置读取失败，无法编辑。</p><button className="button secondary-button" type="button" onClick={onReload}>重新读取</button></div></main>;
  const engine = engineOf(draft);
  const requiresCredential = needsCredential(draft);
  return (
    <main className="asset-view settings-view">
      <header className="view-header"><div><span className="view-kicker">凭证只保存在这台电脑上</span><h2>模型连接</h2><p>这里只配置语音与文本模型。角色音色在当前作品的“角色音色”中单独锁定。</p></div><span className={`provider-state ${!requiresCredential || ttsKey.kept || (draft.provider === 'custom' && draft.endpoint) ? 'is-ready' : ''}`}><ShieldCheck size={14} />{draft.provider === 'demo' ? '开发测试模式' : engine === 'breeze' ? '本地 Breeze · 无需凭证' : draft.hasAccessKey ? '凭证已保存' : draft.provider === 'custom' && draft.endpoint ? '无需凭证' : '等待配置'}</span></header>
      {draft.provider === 'demo' && !demoBannerDismissed ? <div className="demo-provider-banner"><span>当前为离线演示引擎，生成的是占位音——链路是真的，声音是假的。配置豆包语音 API Key 后即可生成真实语音。</span><button type="button" onClick={() => setDemoBannerDismissed(true)}>知道了</button></div> : null}
      <div className="settings-columns expanded-settings">
        <section className="settings-panel model-settings-panel">
          <div className="settings-panel-head"><KeyRound size={17} /><div><strong>语音模型</strong><p>{engine === 'breeze' ? '本地 Breeze 不需要 API Key；角色的参考音色在“角色音色”里设计并锁定。' : '新版豆包语音仅使用 API Key；角色 voice_id 在“角色音色”中固定。'}</p></div></div>
          <EngineSwitch draft={draft} savedConfig={config} onPick={pickPreset} status={breeze.status} checking={breeze.checking} onRefresh={breeze.refresh} />
          {engine === 'breeze' ? null : <>
          <label className="setting-field"><span>接口类型</span><select value={draft.provider} onChange={(event) => changeProvider(event.target.value)}><option value="volcengine-api-key">豆包语音 · 新版 API Key</option><option value="custom">自定义 HTTP 接口</option><option value="demo">开发测试引擎 · 不用于成片</option></select></label>
          <label className="setting-field"><span>接口地址</span><input value={draft.endpoint} disabled={draft.provider === 'demo'} onChange={(event) => change('endpoint', event.target.value)} /></label>
          {requiresCredential ? <SecretField key={draft.provider} label={draft.provider === 'volcengine-api-key' ? 'API Key' : '访问凭证（可选）'} state={ttsKey} value={draft.accessKey} onChange={(value) => change('accessKey', value)} placeholder={draft.provider === 'volcengine-api-key' ? '新版豆包语音 API Key' : 'Access Key / Token'} note="只保存在这台电脑上" /> : null}
          {draft.provider === 'volcengine-api-key' ? <label className="setting-field"><span>合成模型</span><select value={draft.resourceId} onChange={(event) => { const resourceId = event.target.value; change('resourceId', resourceId); change('model', resourceId === 'seed-icl-2.0' ? 'seed-tts-2.0-standard' : ''); }}><option value="seed-tts-2.0">豆包语音合成模型 2.0 · 官方音色</option><option value="seed-icl-2.0">豆包声音复刻模型 2.0 · 复刻音色</option></select><small>复刻音色必须选“声音复刻模型 2.0”；官方音色无需填写额外模型版本。</small></label> : null}
          {draft.provider === 'custom' ? <label className="setting-field"><span>模型标识</span><input value={draft.model} placeholder="服务端要求的模型名" onChange={(event) => change('model', event.target.value)} /></label> : null}
          {draft.provider === 'custom' ? <><HeadersField label="自定义请求头 JSON" value={draft.customHeaders} onChange={(value) => change('customHeaders', value)} moved={Boolean(ttsSaved) && !sameEndpoint(effectiveTtsEndpoint(draft.provider, draft.endpoint), effectiveTtsEndpoint(draft.provider, ttsSaved.endpoint))} /><label className="setting-field"><span>请求体模板</span><textarea rows="5" value={draft.customBodyTemplate} onChange={(event) => change('customBodyTemplate', event.target.value)} /><small>变量：{'{{text}}'}、{'{{voiceId}}'}、{'{{emotion}}'}、{'{{emotionScale}}'}、{'{{speed}}'}、{'{{model}}'}、{'{{subtext}}'}、{'{{distance}}'}</small></label></> : null}
          </>}
          <div className="settings-actions"><button className="button primary-button" type="button" disabled={saving} onClick={save}><Save size={14} />{saving ? '保存中' : '保存语音连接'}</button></div>
        </section>
        <div className="settings-side-column">
          <LlmSettings draft={draft} config={config} keyRequired={llmKeyNeeded} onChange={change} onSave={saveLlm} onTest={onTestLlm} />
          <section className="settings-panel sfx-settings-panel">
            <div className="settings-panel-head"><AudioWaveform size={17} /><div><strong>音效与音乐生成</strong><p>在场景里按描述生成音效、环境声与音乐垫，与语音模型相互独立。</p></div></div>
            <label className="setting-field"><span>生成引擎</span><select value={draft.sfxProvider || 'demo'} onChange={(event) => change('sfxProvider', event.target.value)}><option value="demo">演示引擎 · 离线占位音</option><option value="custom">自定义 HTTP 接口（text-to-SFX 服务）</option></select></label>
            {draft.sfxProvider === 'custom' ? <>
              <label className="setting-field"><span>接口地址</span><input value={draft.sfxEndpoint || ''} placeholder="https://.../sound-effects" onChange={(event) => change('sfxEndpoint', event.target.value)} /></label>
              <SecretField label="访问凭证" state={sfxKey} value={draft.sfxAccessKey} onChange={(value) => change('sfxAccessKey', value)} placeholder="API Key / Token" note="只保存在这台电脑上" />
              <label className="setting-field"><span>模型标识</span><input value={draft.sfxModel || ''} placeholder="服务端要求的模型名（可选）" onChange={(event) => change('sfxModel', event.target.value)} /></label>
              <HeadersField label="请求头 JSON" rows={2} value={draft.sfxCustomHeaders} onChange={(value) => change('sfxCustomHeaders', value)} moved={!sameEndpoint(draft.sfxEndpoint, config.sfxEndpoint)} />
              <label className="setting-field"><span>请求体模板</span><textarea rows="4" value={draft.sfxCustomBodyTemplate || ''} onChange={(event) => change('sfxCustomBodyTemplate', event.target.value)} /><small>变量：{'{{prompt}}'}、{'{{durationSec}}'}、{'{{type}}'}、{'{{model}}'}；响应需为音频或含 base64 音频的 JSON。</small></label>
            </> : <p className="picker-note">演示引擎产出离线占位音（链路真实，声音为合成示意），用于零密钥体验生成流程。</p>}
          </section>
          <div className="local-security-note"><ShieldCheck size={17} /><div><strong>本地安全边界</strong><p>访问凭证写入 <code>{draft.configPath || '~/.shengchang/config.json'}</code>，文件权限仅限当前用户；浏览器不会读取明文凭证。</p></div></div>
        </div>
      </div>
    </main>
  );
}
