"""Local Breeze-TTS-2 (MLX) HTTP service for 声场. Binds 127.0.0.1 only.

Endpoints (JSON in, audio/wav out; errors are non-200 text/plain):
  GET  /health
  GET  /voices
  POST /voices          {id, transcript, wav_base64 | wav_path}   register a reference voice
  POST /voice_design    {text, instruction, cfg_scale=4, seed=42}
  POST /voice_clone     {text, ref_audio | voiceId, ref_text, seed=42}
  POST /voice_direction {text, instruction, ref_audio | voiceId, ref_text, cfg_scale=4, seed=42}
  POST /tts             {text, voiceId, [instruction] | emotion, subtext, speed, [emotionScale], [pauseBackstop], [rawName]}  (声场 custom adapter)
                        pause backstop default on (env BREEZE_PAUSE_BACKSTOP=0 to disable; request pauseBackstop overrides)
ref_audio = absolute path on this machine or base64 WAV.

Env: BREEZE_MODEL_DIR (alias BREEZE_MODEL; default ./models/Breeze-TTS-2-mlx), BREEZE_PORT (default 4180),
     BREEZE_SEED (42), BREEZE_CFG (4), BREEZE_STABLE_CLAUSE (0), BREEZE_PAUSE_BACKSTOP (1), BREEZE_RAW_DIR (unset).
Requires Apple Silicon (MLX / Metal). Weights are NOT in this repo: see INSTALL / README 「安装 Breeze」.
"""
import base64, io, json, os, re, tempfile, threading, time
from pathlib import Path
import numpy as np, soundfile as sf, psutil
import mlx.core as mx
from fastapi import FastAPI, Request
from fastapi.responses import Response, PlainTextResponse, JSONResponse
from mlx_audio.tts import load

ROOT = Path(__file__).resolve().parent
MODEL_DIR = os.environ.get("BREEZE_MODEL_DIR") or os.environ.get("BREEZE_MODEL", str(ROOT / "models" / "Breeze-TTS-2-mlx"))
VOICES = ROOT / "voices"; VOICES.mkdir(exist_ok=True)
(ROOT / "logs").mkdir(exist_ok=True)  # fresh clone: logs/ is gitignored
DEFAULT_SEED = int(os.environ.get("BREEZE_SEED", "42"))
DEFAULT_CFG = float(os.environ.get("BREEZE_CFG", "4"))
STABLE_CLAUSE = os.environ.get("BREEZE_STABLE_CLAUSE", "0") == "1"
BACKSTOP_DEFAULT = os.environ.get("BREEZE_PAUSE_BACKSTOP", "1") != "0"
RAW_DIR = os.environ.get("BREEZE_RAW_DIR")  # optional: save pre-backstop audio here for diagnostics
SIL_DB, FRAME = -40.0, 240  # 10 ms frames @ 24 kHz
LOG = open(ROOT / "logs" / "requests.jsonl", "a", buffering=1)

t0 = time.time(); model = load(MODEL_DIR); LOAD_SECS = round(time.time() - t0, 1)
lock = threading.Lock(); stats = {"requests": 0, "errors": 0, "max_peak_gb": 0.0}
app = FastAPI()

# --- v3 instruction builder (mirrors shengchang server/model-adapters.js voiceInstructions @3617387),
#     except slow pacing: no pause wording (was 语速放慢，句间多停顿一下) ---
EMOTION_DEGREE = [(0.8, "特别特别"), (0.6, "特别"), (0.4, "比较"), (0, "略带一点")]
def pacing_phrase(speed):
    try: v = float(speed) or 1
    except (TypeError, ValueError): v = 1
    if v <= 0.9: return "语速稍慢、从容"
    if v >= 1.1: return "语速加快，说得紧凑一些"
    return ""
def voice_instruction(emotion, emotion_scale=None, speed=None, subtext=None):
    frags = []
    if emotion:
        try: s = float(emotion_scale) or 0.4
        except (TypeError, ValueError): s = 0.4
        s = min(1, max(0.1, s))
        frags.append(f"用{next(w for m, w in EMOTION_DEGREE if s >= m)}{emotion}的语气说")
    p = pacing_phrase(speed)
    if p: frags.append(p)
    st = str(subtext or "").strip()[:100]
    if st: frags.append(f"这句话的情绪来由是：{st}")
    if STABLE_CLAUSE and frags: frags.append("保持当前基础音色稳定")
    return f"{'，'.join(frags)}。" if frags else ""


# --- pause backstop (Back-end rule): N = count of ……/—— in text; keep the N longest internal
#     silences capped at 1.2 s; other internal silences > 1.2 s -> 0.6 s; lead/trail -> 0.15 s ---
def silence_runs(audio):
    n = len(audio) // FRAME
    if n == 0: return [], 0, 0
    fr = audio[: n * FRAME].reshape(n, FRAME)
    db = 20 * np.log10(np.sqrt((fr ** 2).mean(1)) + 1e-9)
    voiced = np.where(db > SIL_DB)[0]
    if len(voiced) == 0: return [], 0, n
    first, last = voiced[0], voiced[-1] + 1
    runs, i = [], first
    while i < last:
        if db[i] <= SIL_DB:
            j = i
            while j < last and db[j] <= SIL_DB: j += 1
            runs.append((i * FRAME, j * FRAME)); i = j
        else: i += 1
    return runs, first * FRAME, last * FRAME

def internal_silence_secs(audio, min_s=0.3):
    runs, _, _ = silence_runs(audio)
    return float(sum((b - a) for a, b in runs if (b - a) >= min_s * 24000)) / 24000

def pause_backstop(audio, text):
    sr = 24000
    n_marks = len(re.findall(r"…+|—+", text or ""))
    runs, start, end = silence_runs(audio)
    if end <= start: return audio, {"marks": n_marks, "changed": 0}
    long_runs = sorted([r for r in runs if (r[1] - r[0]) > 1.2 * sr], key=lambda r: r[0] - r[1])
    keep = set(long_runs[:n_marks])
    target = {r: (int(1.2 * sr) if r in keep else int(0.6 * sr)) for r in long_runs}
    lead = min(start, int(0.15 * sr)); trail = min(len(audio) - end, int(0.15 * sr))
    out, cur = [audio[start - lead:start]], start
    for (a, b) in sorted(target):
        out.append(audio[cur:a]); t = target[(a, b)]
        out.append(audio[a:a + t // 2]); out.append(audio[b - (t - t // 2):b]); cur = b
    out.append(audio[cur:end]); out.append(audio[end:end + trail])
    return np.concatenate(out), {"marks": n_marks, "changed": len(target), "lead_s": round(float(start) / sr, 2), "trail_s": round(float(len(audio) - end) / sr, 2)}

class Bad(Exception): pass

def resolve_ref(body):
    vid = body.get("voiceId")
    if vid:
        if not re.fullmatch(r"[A-Za-z0-9_\-]+", vid): raise Bad("invalid voiceId")
        wav, txt = VOICES / f"{vid}.wav", VOICES / f"{vid}.txt"
        if not wav.exists() or not txt.exists(): raise Bad(f"unknown voiceId: {vid}")
        return str(wav), txt.read_text("utf-8").strip()
    ref, ref_text = body.get("ref_audio"), body.get("ref_text")
    if not ref or not ref_text: raise Bad("ref_audio/voiceId and ref_text are required")
    if os.path.isabs(ref) and os.path.exists(ref): return ref, ref_text
    try: data = base64.b64decode(ref, validate=True)
    except Exception: raise Bad("ref_audio must be an existing absolute path or base64 WAV")
    f = tempfile.NamedTemporaryFile(suffix=".wav", delete=False); f.write(data); f.close()
    return f.name, ref_text

def synth(kind, text, instruct=None, ref=None, cfg=None, seed=None, meta=None, backstop=False):
    if not text or not str(text).strip(): raise Bad("text is required")
    seed = DEFAULT_SEED if seed is None else int(seed)
    kw = dict(text=text, seed=seed)
    if instruct: kw["instruct"] = instruct
    if instruct or kind == "voice_design": kw["cfg_scale"] = float(DEFAULT_CFG if cfg is None else cfg)
    if ref: kw["ref_audio"], kw["ref_text"] = ref
    with lock:
        mx.reset_peak_memory(); t = time.time()
        chunks = [np.array(r.audio, dtype=np.float32).reshape(-1) for r in model.generate(**kw)]
        gen = time.time() - t; peak = mx.get_peak_memory() / 1e9
    audio = np.concatenate(chunks) if chunks else np.zeros(0, np.float32)
    raw_dur = len(audio) / 24000
    if raw_dur <= 0: raise Bad("model produced no audio")
    raw_sil = internal_silence_secs(audio); bs = None
    if RAW_DIR and meta and meta.get("rawName"):
        os.makedirs(RAW_DIR, exist_ok=True); sf.write(os.path.join(RAW_DIR, meta["rawName"]), audio, 24000, subtype="PCM_16")
    if backstop: audio, bs = pause_backstop(audio, text)
    dur = len(audio) / 24000
    buf = io.BytesIO(); sf.write(buf, audio, 24000, format="WAV", subtype="PCM_16")
    rss = psutil.Process().memory_info().rss / 1e9
    stats["requests"] += 1; stats["max_peak_gb"] = max(stats["max_peak_gb"], peak)
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "kind": kind, "chars": len(text), "gen_s": round(gen, 2), "audio_s": round(dur, 2), "rtf": round(gen / dur, 2), "mlx_peak_gb": round(peak, 2), "rss_gb": round(rss, 2), "seed": seed, "instruct": instruct, "raw_audio_s": round(raw_dur, 2), "raw_internal_sil_s": round(raw_sil, 2), "out_internal_sil_s": round(internal_silence_secs(audio), 2), "backstop": bs, **(meta or {})}
    LOG.write(json.dumps(rec, ensure_ascii=False) + "\n")
    hdr = {"X-Gen-Seconds": f"{gen:.2f}", "X-Audio-Seconds": f"{dur:.2f}", "X-RTF": f"{gen/dur:.2f}", "X-Peak-Memory-GB": f"{peak:.2f}", "X-Seed": str(seed), "X-Raw-Audio-Seconds": f"{raw_dur:.2f}", "X-Backstop": "on" if backstop else "off"}
    if instruct: hdr["X-Instruction-B64"] = base64.b64encode(instruct.encode()).decode()
    return Response(buf.getvalue(), media_type="audio/wav", headers=hdr)

async def body_of(req):
    try: b = await req.json()
    except Exception: raise Bad("body must be JSON")
    if not isinstance(b, dict): raise Bad("body must be a JSON object")
    return b

def handle(fn):
    async def w(req: Request):
        try: return fn(await body_of(req))
        except Bad as e: stats["errors"] += 1; return PlainTextResponse(str(e), status_code=400)
        except Exception as e: stats["errors"] += 1; return PlainTextResponse(f"{type(e).__name__}: {e}", status_code=500)
    return w

@app.get("/health")
def health():
    return JSONResponse({"ok": True, "model": MODEL_DIR, "runtime": "mlx-audio", "pause_backstop_default": BACKSTOP_DEFAULT, "device": str(mx.default_device()), "load_seconds": LOAD_SECS, "voices": sorted(p.stem for p in VOICES.glob("*.wav")), **stats})

@app.get("/voices")
def voices():
    return {p.stem: (VOICES / f"{p.stem}.txt").read_text("utf-8").strip() if (VOICES / f"{p.stem}.txt").exists() else None for p in VOICES.glob("*.wav")}

def _register(b):
    vid, tr = b.get("id"), b.get("transcript")
    if not vid or not re.fullmatch(r"[A-Za-z0-9_\-]+", vid) or not tr: raise Bad("id (alnum/_/-) and transcript required")
    if b.get("wav_base64"): data = base64.b64decode(b["wav_base64"])
    elif b.get("wav_path") and os.path.exists(b["wav_path"]): data = Path(b["wav_path"]).read_bytes()
    else: raise Bad("wav_base64 or existing wav_path required")
    (VOICES / f"{vid}.wav").write_bytes(data); (VOICES / f"{vid}.txt").write_text(tr.strip() + "\n", "utf-8")
    return JSONResponse({"ok": True, "id": vid})
app.post("/voices")(handle(_register))
app.post("/voice_design")(handle(lambda b: synth("voice_design", b.get("text"), instruct=b.get("instruction") or None, cfg=b.get("cfg_scale"), seed=b.get("seed"))))
app.post("/voice_clone")(handle(lambda b: synth("voice_clone", b.get("text"), ref=resolve_ref(b), seed=b.get("seed"))))
app.post("/voice_direction")(handle(lambda b: synth("voice_direction", b.get("text"), instruct=b.get("instruction") or None, ref=resolve_ref(b), cfg=b.get("cfg_scale"), seed=b.get("seed"))))
def _tts(b):
    if not b.get("voiceId"): raise Bad("voiceId is required")
    # 声场-supplied instruction wins; build our own only when the field is absent/null
    ins = str(b["instruction"]).strip()[:300] if b.get("instruction") is not None else voice_instruction(b.get("emotion"), b.get("emotionScale"), b.get("speed"), b.get("subtext"))
    return synth("tts_direction" if ins else "tts_clone", b.get("text"), instruct=ins or None, ref=resolve_ref({"voiceId": b["voiceId"]}), cfg=b.get("cfg_scale"), seed=b.get("seed"), meta={"voiceId": b["voiceId"], **({"rawName": re.sub(r"[^A-Za-z0-9_.-]", "", str(b["rawName"]))} if b.get("rawName") else {})}, backstop=BACKSTOP_DEFAULT if b.get("pauseBackstop") is None else bool(b.get("pauseBackstop")))
app.post("/tts")(handle(_tts))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("BREEZE_PORT", "4180")), log_level="info")
