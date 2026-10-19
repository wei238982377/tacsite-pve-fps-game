/* ============================================================================
   AI GAME · 沙漠对决 —— 程序化音频引擎  window.GAME.Audio
   ----------------------------------------------------------------------------
   设计目标（参考 CS2 听感，全部实时合成，零外部音频素材 / 零网络请求）：

   · AK-47    : 清脆尖锐的枪口爆音 -> 中频“砰” -> 短促房间尾音，轻微失真颗粒
   · 沙漠之鹰 : 更低更沉的大口径爆音，70~120Hz 低频明显，尾音更空更长
   · AWM      : 最锐利的超音速尖啸 + 巨大低频轰鸣 + 长距离回声（dust2 空旷感）

   主输出链：
       各音效 gain -> StereoPanner(仅远端) -> masterGain(默认 0.55)
                   -> DynamicsCompressor(限幅) -> Analyser(仅调试读数) -> destination

   远端声源（shot(pos) 等）：声速传播延迟 + 距离衰减 + 距离低通（闷化）
                   + StereoPanner 声像（依据 listener yaw / pos）+ 更长的回声
   回声：共享回声总线（DelayNode + 低通 + 反馈），不用 ConvolverNode，
                   不为每条声音新建 Delay，避免开销与内存泄漏。

   性能 / 鲁棒性：
     · 单发枪声节点数 < 15；噪声 buffer 全局缓存复用；
     · 活跃声源上限 24，超限丢弃“最低优先级 / 最早”的声源（新声优先级更低则丢弃新声）；
     · 每个音效用 setTimeout 在结束后自动 stop + disconnect；
     · 未 init / AudioContext 不可用 / 静音 / ctx 非 running 时所有 API 安全 no-op；
     · init 可重复调用；unlock() 在用户手势后 resume；另装自动 unlock 兜底监听；
     · 所有公开 API 内部 try/catch，绝不会把异常抛给游戏主循环。

   接口见 fps/docs/interfaces.md 5.4 节。
   ============================================================================ */
"use strict";

(function () {
  var GAME = (window.GAME = window.GAME || {});

  /* ============================ 常量 ============================ */
  var VERSION = '1.0.0';
  var DEFAULT_VOLUME = 0.55;   // master gain 默认值（与文档一致）
  var MAX_VOICES = 24;         // 同时活跃声源上限

  /* ============================ 运行状态 ============================ */
  var ctx = null;              // AudioContext
  var master = null;           // 主音量
  var limiter = null;          // 限幅压缩器
  var analyser = null;         // 仅用于自测/调试读峰值
  var analyserBuf = null;
  var readyFlag = false;
  var volume = DEFAULT_VOLUME;
  var muted = false;
  var noiseBuf = null;         // 2s 白噪声缓存（所有噪声源复用）
  var driveCurve = null;       // WaveShaper 失真曲线（缓存）
  var echoNearIn = null;       // 近场短回声总线入口
  var echoFarIn = null;        // 远场长回声总线入口
  var voices = [];             // 活跃声源记录
  var voiceTotal = 0;
  var amb = null;              // 环境声常驻节点
  var ambienceWanted = false;
  var autoUnlockInstalled = false;
  var lastResumeTry = 0;
  var hurtLast = 0;
  var listener = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };

  /* ============================ 基础工具 ============================ */
  function clamp(v, lo, hi) {
    v = +v;
    if (!isFinite(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }
  function num(v, d) {
    v = +v;
    return isFinite(v) ? v : d;
  }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function now() { return ctx ? ctx.currentTime : 0; }

  // 兼容 [x,y,z] 与 {x,y,z} / {pos:[...]} 两种写法
  function readPos(pos) {
    if (!pos) return null;
    try {
      if (typeof pos.length === 'number' && pos.length >= 3) {
        return [num(pos[0], 0), num(pos[1], 0), num(pos[2], 0)];
      }
      if (typeof pos === 'object') {
        var x = num(pos.x, NaN), y = num(pos.y, NaN), z = num(pos.z, NaN);
        if (isFinite(x) && isFinite(y) && isFinite(z)) return [x, y, z];
        if (pos.pos) return readPos(pos.pos);
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function tryResume(force) {
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    var t = Date.now();
    if (!force && t - lastResumeTry < 500) return;
    lastResumeTry = t;
    try {
      var p = ctx.resume();
      if (p && typeof p.then === 'function') p.catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  function playable() {
    if (!ctx || !readyFlag) return false;
    if (muted) return false;
    if (ctx.state !== 'running') { tryResume(false); return false; }
    return true;
  }

  /* ============================ 节点工厂 ============================ */
  function mkGain(v) {
    var g = ctx.createGain();
    g.gain.value = (v == null ? 1 : v);
    return g;
  }
  function mkFilter(type, freq, q) {
    var f = ctx.createBiquadFilter();
    f.type = type || 'lowpass';
    f.frequency.value = clamp(freq || 1000, 20, 20000);
    if (q != null) f.Q.value = q;
    return f;
  }
  function mkPan(p) {
    if (typeof ctx.createStereoPanner !== 'function') return null;
    var n = ctx.createStereoPanner();
    n.pan.value = clamp(p, -1, 1);
    return n;
  }

  // 包络：attack 到峰值，再指数衰减到 0.0001
  function envGain(t0, peak, attack, decay) {
    var g = ctx.createGain();
    var a = Math.max(0.002, attack || 0.003);
    var d = Math.max(0.008, decay || 0.05);
    var p = Math.max(0.0002, peak == null ? 0.2 : peak);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(p, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    return g;
  }

  /* ============================ 活跃声源管理 ============================ */
  function reg(v, node) {
    if (node) v.nodes.push(node);
    return node;
  }
  function regSrc(v, node) {
    if (node) { v.nodes.push(node); v.srcs.push(node); }
    return node;
  }

  function killVoice(v) {
    if (!v || v.dead) return;
    v.dead = true;
    if (v.timer) {
      try { clearTimeout(v.timer); } catch (e) { /* ignore */ }
      v.timer = 0;
    }
    var i;
    for (i = 0; i < v.srcs.length; i++) {
      var s = v.srcs[i];
      try { s.onended = null; } catch (e) { /* ignore */ }
      try { s.stop(); } catch (e) { /* ignore */ }
    }
    for (i = 0; i < v.nodes.length; i++) {
      try { v.nodes[i].disconnect(); } catch (e) { /* ignore */ }
    }
    var idx = voices.indexOf(v);
    if (idx >= 0) voices.splice(idx, 1);
  }

  function reserveVoice(priority) {
    if (voices.length >= MAX_VOICES) {
      // 找“优先级最低，其次最早”的声源
      var victim = null;
      for (var i = 0; i < voices.length; i++) {
        var c = voices[i];
        if (c.dead) continue;
        if (!victim || c.pri < victim.pri || (c.pri === victim.pri && c.start < victim.start)) victim = c;
      }
      if (!victim) return null;
      // 现有声源优先级都更高 -> 丢弃新声；否则淘汰最低优先级的最早声源
      if (victim.pri > priority) return null;
      killVoice(victim);
    }
    var v = { pri: priority, start: now(), nodes: [], srcs: [], timer: 0, dead: false };
    voices.push(v);
    voiceTotal++;
    return v;
  }

  // 在 endTime（AudioContext 时间）之后自动销毁整条音效子图
  function finishAt(v, endTime) {
    var ms = Math.max(60, (endTime - now()) * 1000 + 150);
    v.timer = setTimeout(function () { killVoice(v); }, ms);
  }

  /* ============================ 空间化 ============================ */
  // 返回 {remote, gain, pan, lpFreq, echoMul, dist, delay}
  function spatial(pos) {
    var p = readPos(pos);
    if (!p) return { remote: false, gain: 1, pan: 0, lpFreq: 19000, echoMul: 1, dist: 0, delay: 0 };

    var dx = p[0] - listener.x;
    var dy = p[1] - listener.y;
    var dz = p[2] - listener.z;
    var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!isFinite(d) || d < 0) d = 0;

    // 距离衰减（约 7m 内接近满音量，20m 约 -14dB，40m 约 -20dB）
    var gain = Math.pow(1 + d / 7, -1.5);
    gain = clamp(gain, 0.05, 1);

    // 声像：把声源方向投影到 listener 的右向量
    var horiz = Math.sqrt(dx * dx + dz * dz);
    var pan = 0;
    if (horiz > 0.35) {
      var rx = Math.cos(listener.yaw);
      var rz = -Math.sin(listener.yaw);
      pan = (dx * rx + dz * rz) / horiz;
      pan = clamp(pan, -1, 1) * 0.92;
    }

    // 背后方向再闷一点（没有 HRTF 时的近似）
    var fx = -Math.sin(listener.yaw);
    var fz = -Math.cos(listener.yaw);
    var front = horiz > 0.35 ? (dx * fx + dz * fz) / horiz : 1;
    var lpFreq = 19000 / (1 + d / 4.5);
    if (front < 0) lpFreq *= (0.72 + 0.28 * (1 + front));
    lpFreq = clamp(lpFreq, 620, 19000);

    // 距离越远，回声占比越大（CS2 空旷地图听感）
    var echoMul = 0.85 + Math.min(d / 24, 1.5) * 0.85;
    // 声音传播延迟（343m/s），上限 0.22s 避免打击感丢失
    var delay = Math.min(d / 343, 0.22);

    return { remote: true, gain: gain, pan: pan, lpFreq: lpFreq, echoMul: echoMul, dist: d, delay: delay };
  }

  // 把一个“单声道音效输出 out”接到主链（含远端低通/声像/回声发送）
  function routeOut(v, out, sp, echoLvl) {
    if (sp.remote) {
      var flt = reg(v, mkFilter('lowpass', sp.lpFreq, 0.7));
      out.connect(flt);
      var pan = mkPan(sp.pan);
      if (pan) {
        reg(v, pan);
        flt.connect(pan);
        pan.connect(master);
      } else {
        flt.connect(master);
      }
      if (echoNearIn && echoLvl > 0.0001) {
        var send = reg(v, mkGain(echoLvl * sp.echoMul));
        flt.connect(send);
        send.connect(echoNearIn);
        send.connect(echoFarIn);
      }
    } else {
      out.connect(master);
      if (echoNearIn && echoLvl > 0.0001) {
        var send2 = reg(v, mkGain(echoLvl));
        out.connect(send2);
        send2.connect(echoNearIn);
        send2.connect(echoFarIn);
      }
    }
  }

  /* ============================ 通用合成积木 ============================ */
  function newNoiseSrc(v) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = false;
    return regSrc(v, s);
  }
  function startNoise(src, t0, dur) {
    // 随机起点避免每发噪声完全一致；留出最长尾音余量，避免超出 2s 缓存
    try { src.start(t0, Math.random() * 1.2); }
    catch (e) { try { src.start(t0); } catch (e2) { /* ignore */ } }
    try { src.stop(t0 + dur); } catch (e) { /* ignore */ }
  }

  // 一段滤波噪声瞬态：o = {type,f0,f1,q,dur,lvl,attack}
  function noiseBurst(v, dest, t0, o) {
    o = o || {};
    var dur = o.dur == null ? 0.05 : o.dur;
    var f0 = Math.max(20, o.f0 || 2000);
    var flt = reg(v, mkFilter(o.type || 'bandpass', f0, o.q == null ? 1 : o.q));
    var g = reg(v, envGain(t0, o.lvl == null ? 0.3 : o.lvl, o.attack == null ? 0.002 : o.attack, dur));
    if (o.f1) {
      flt.frequency.setValueAtTime(f0, t0);
      flt.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + dur);
    }
    var src = newNoiseSrc(v);
    src.connect(flt);
    flt.connect(g);
    g.connect(dest);
    startNoise(src, t0, dur + 0.07);
    return t0 + dur;
  }

  // 一段振荡器音：o = {type,f0,f1,dur,lvl,attack,filter:{type,f0,q}}
  function tone(v, dest, t0, o) {
    o = o || {};
    var dur = o.dur == null ? 0.1 : o.dur;
    var osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    var f0 = Math.max(20, o.f0 || 440);
    osc.frequency.setValueAtTime(f0, t0);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + dur);
    var g = reg(v, envGain(t0, o.lvl == null ? 0.2 : o.lvl, o.attack == null ? 0.003 : o.attack, dur));
    if (o.filter) {
      var flt = reg(v, mkFilter(o.filter.type || 'bandpass', o.filter.f0 || 600, o.filter.q == null ? 1 : o.filter.q));
      osc.connect(flt);
      flt.connect(g);
    } else {
      osc.connect(g);
    }
    g.connect(dest);
    regSrc(v, osc);
    try { osc.start(t0); osc.stop(t0 + dur + 0.08); } catch (e) { /* ignore */ }
    return t0 + dur;
  }

  /* ============================ 主输出链 / 初始化 ============================ */
  function makeDriveCurve(amount) {
    var n = 1024;
    var curve = new Float32Array(n);
    var k = Math.max(0.1, amount || 2.2);
    var norm = Math.tanh(k);
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * k) / norm;
    }
    return curve;
  }

  function buildNoiseBuffer() {
    var len = Math.floor(ctx.sampleRate * 2.0);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    noiseBuf = buf;
  }

  // 共享回声总线：input -> delay -> lowpass -> (反馈 + wet->master)
  function buildEcho(delaySec, feedback, lpFreq, wet) {
    var input = ctx.createGain();
    input.gain.value = 1;
    var delay = ctx.createDelay(2.5);
    delay.delayTime.value = clamp(delaySec, 0.001, 2);
    var lp = mkFilter('lowpass', lpFreq, 0.6);
    var fb = ctx.createGain();
    fb.gain.value = clamp(feedback, 0, 0.85);
    var wetG = ctx.createGain();
    wetG.gain.value = clamp(wet, 0, 1);
    input.connect(delay);
    delay.connect(lp);
    lp.connect(fb);
    fb.connect(delay);
    lp.connect(wetG);
    wetG.connect(master);
    return input;
  }

  function applyVolume() {
    if (!master || !ctx) return;
    var target = muted ? 0 : volume;
    try { master.gain.setTargetAtTime(target, ctx.currentTime, 0.03); }
    catch (e) { try { master.gain.value = target; } catch (e2) { /* ignore */ } }
  }

  function installAutoUnlock() {
    if (autoUnlockInstalled) return;
    autoUnlockInstalled = true;
    try {
      if (typeof document === 'undefined' || !document.addEventListener) return;
      var handler = function () {
        tryResume(true);
        if (ambienceWanted) ensureAmbience();
      };
      var evs = ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'click'];
      for (var i = 0; i < evs.length; i++) document.addEventListener(evs[i], handler, true);
    } catch (e) { /* ignore */ }
  }

  function initAudio() {
    if (ctx) {
      tryResume(true);
      if (ambienceWanted) ensureAmbience();
      return;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
    } catch (e) {
      ctx = null;
      return;
    }
    try {
      master = ctx.createGain();
      master.gain.value = muted ? 0 : volume;

      limiter = ctx.createDynamicsCompressor();
      try {
        limiter.threshold.value = -12;   // 限幅，防连发叠加削波
        limiter.knee.value = 8;
        limiter.ratio.value = 9;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.14;
      } catch (e) { /* 旧浏览器参数可能只读，忽略 */ }

      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0;
      analyserBuf = new Float32Array(analyser.fftSize);

      master.connect(limiter);
      limiter.connect(analyser);
      analyser.connect(ctx.destination);

      buildNoiseBuffer();
      driveCurve = makeDriveCurve(2.6);

      // 近场短回声（枪声房间尾）+ 远场长回声（空旷 dust2 感）
      echoNearIn = buildEcho(0.085, 0.26, 3200, 0.20);
      echoFarIn = buildEcho(0.24, 0.52, 1400, 0.26);

      readyFlag = true;
      installAutoUnlock();
    } catch (e) {
      try { if (ctx && ctx.close) ctx.close(); } catch (e2) { /* ignore */ }
      ctx = null;
      master = null;
      limiter = null;
      analyser = null;
      readyFlag = false;
      return;
    }
    tryResume(true);
    if (ambienceWanted) ensureAmbience();
  }

  /* ============================ 枪械音色表 ============================ */
  // 每把枪 = 1 个噪声源 + crack/body/tail 三层滤波噪声 + (可选)低频振荡
  // 节点数：AK 11 本机 / 13 远端；沙鹰 11 / 13；AWM 12 / 14（均 < 15）
  var GUNS = {
    ak47: {
      out: 0.40, pri: 4, echo: 0.13, drive: 2.6,
      crack: { type: 'highpass', f0: 2300, f1: 1500, q: 0.8, dur: 0.030, lvl: 0.90 },
      body: { type: 'lowpass', f0: 2500, f1: 760, q: 1.1, dur: 0.10, lvl: 0.85 },
      tail: { type: 'bandpass', f0: 1300, q: 0.8, dur: 0.22, lvl: 0.26 },
      bass: null
    },
    deagle: {
      out: 0.48, pri: 4, echo: 0.20, drive: 1.6,
      crack: { type: 'highpass', f0: 1350, f1: 900, q: 0.7, dur: 0.040, lvl: 0.70 },
      body: { type: 'lowpass', f0: 1700, f1: 330, q: 1.0, dur: 0.26, lvl: 0.95 },
      tail: null,
      bass: { f0: 118, f1: 46, dur: 0.24, lvl: 0.95 }
    },
    awm: {
      out: 0.62, pri: 4, echo: 0.30, drive: 0,
      crack: { type: 'bandpass', f0: 3500, f1: 2500, q: 2.0, dur: 0.045, lvl: 1.00 },
      body: { type: 'lowpass', f0: 2100, f1: 240, q: 0.9, dur: 0.24, lvl: 1.00 },
      tail: { type: 'lowpass', f0: 1200, q: 0.7, dur: 0.52, lvl: 0.30 },
      bass: { f0: 84, f1: 27, dur: 0.44, lvl: 1.00 }
    }
  };

  function playShot(id, pos) {
    if (!playable()) return;
    var g = GUNS[id] || GUNS.ak47;
    var sp = spatial(pos);
    var v = reserveVoice(sp.remote ? 3 : g.pri);
    if (!v) return;

    var t0 = now() + 0.004 + sp.delay;
    var detune = rand(0.94, 1.07);      // 每发轻微音高随机化，避免机械重复
    var tScale = rand(0.95, 1.06);

    var bus = reg(v, mkGain(1));
    var out = reg(v, mkGain(g.out * sp.gain * rand(0.93, 1.06)));

    var preOut = bus;
    if (g.drive && driveCurve) {
      var shaper = ctx.createWaveShaper();
      shaper.curve = driveCurve;
      shaper.oversample = 'none';
      reg(v, shaper);
      bus.connect(shaper);
      preOut = shaper;
    }
    preOut.connect(out);

    // 一个白噪声源并行喂给 crack/body/tail 三层滤波
    var noise = newNoiseSrc(v);
    var noiseEnd = 0;
    var layers = [g.crack, g.body, g.tail];
    for (var i = 0; i < layers.length; i++) {
      var cfg = layers[i];
      if (!cfg) continue;
      var f0 = Math.max(20, (cfg.f0 || 1000) * detune);
      var flt = reg(v, mkFilter(cfg.type, f0, cfg.q));
      var env = reg(v, envGain(t0, cfg.lvl, 0.003, cfg.dur * tScale));
      if (cfg.f1) {
        flt.frequency.setValueAtTime(f0, t0);
        flt.frequency.exponentialRampToValueAtTime(Math.max(20, cfg.f1 * detune), t0 + cfg.dur * tScale);
      }
      noise.connect(flt);
      flt.connect(env);
      env.connect(bus);
      if (cfg.dur > noiseEnd) noiseEnd = cfg.dur * tScale;
    }
    startNoise(noise, t0, noiseEnd + 0.08);

    // 低频轰鸣（沙鹰 / AWM 的核心辨识点）
    var bassEnd = 0;
    if (g.bass) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(g.bass.f0, t0);
      osc.frequency.exponentialRampToValueAtTime(g.bass.f1, t0 + g.bass.dur);
      var bg = reg(v, envGain(t0, g.bass.lvl, 0.006, g.bass.dur));
      osc.connect(bg);
      bg.connect(bus);
      regSrc(v, osc);
      try { osc.start(t0); osc.stop(t0 + g.bass.dur + 0.1); } catch (e) { /* ignore */ }
      bassEnd = g.bass.dur;
    }

    // 输出路由：远端 = 距离低通 + 声像 + 更长回声
    var echoLvl = g.echo * sp.echoMul;
    if (sp.remote) {
      var lp = reg(v, mkFilter('lowpass', sp.lpFreq, 0.7));
      out.connect(lp);
      var pan = mkPan(sp.pan);
      if (pan) {
        reg(v, pan);
        lp.connect(pan);
        pan.connect(master);
      } else {
        lp.connect(master);
      }
      if (echoNearIn && echoLvl > 0.0001) {
        var send = reg(v, mkGain(echoLvl));
        lp.connect(send);
        send.connect(echoNearIn);
        send.connect(echoFarIn);
      }
    } else {
      out.connect(master);
      if (echoNearIn && echoLvl > 0.0001) {
        var send2 = reg(v, mkGain(echoLvl));
        out.connect(send2);
        send2.connect(echoNearIn);
        send2.connect(echoFarIn);
      }
    }

    finishAt(v, t0 + Math.max(noiseEnd + 0.12, bassEnd + 0.12));
  }

  /* ============================ 空仓击针 ============================ */
  var DRY_FIRE = {
    ak47: { f: 2900, q: 4.0, tone: 2500, lvl: 0.16 },
    deagle: { f: 1900, q: 3.0, tone: 1500, lvl: 0.20 },
    awm: { f: 2300, q: 3.2, tone: 1900, lvl: 0.18 }
  };

  function playDryFire(id, pos) {
    if (!playable()) return;
    var sp = spatial(pos);
    var cfg = DRY_FIRE[id] || DRY_FIRE.ak47;
    var v = reserveVoice(2);
    if (!v) return;
    var t0 = now() + 0.003 + sp.delay;
    var out = reg(v, mkGain(cfg.lvl * sp.gain));
    routeOut(v, out, sp, 0.05);
    noiseBurst(v, out, t0, { type: 'bandpass', f0: cfg.f * rand(0.94, 1.06), q: cfg.q, dur: 0.02, lvl: 0.9 });
    noiseBurst(v, out, t0 + 0.006, { type: 'highpass', f0: 4500, q: 0.7, dur: 0.012, lvl: 0.5 });
    tone(v, out, t0 + 0.002, { type: 'triangle', f0: cfg.tone, dur: 0.025, lvl: 0.14 });
    finishAt(v, t0 + 0.09);
  }

  /* ============================ 换弹 / 拉栓 ============================ */
  var RELOAD_W = {
    ak47: { p: 1.0, w: 1.0 },
    deagle: { p: 1.12, w: 1.15 },
    awm: { p: 0.84, w: 1.6 }
  };

  function playReload(id, stage, pos) {
    if (!playable()) return;
    var sp = spatial(pos);
    var w = RELOAD_W[id] || RELOAD_W.ak47;
    var v = reserveVoice(2);
    if (!v) return;
    var t0 = now() + 0.004 + sp.delay;
    var out = reg(v, mkGain(0.34 * sp.gain));
    routeOut(v, out, sp, 0.07);

    var p = w.p;
    var wgt = w.w;
    var end = t0;
    function nb(at, o) {
      noiseBurst(v, out, at, o);
      end = Math.max(end, at + (o.dur || 0.05));
    }
    function tn(at, o) {
      tone(v, out, at, o);
      end = Math.max(end, at + (o.dur || 0.1));
    }

    var st = String(stage || 'start');
    switch (st) {
      case 'start':
        // 抓握把 + 衣服/背带摩擦
        nb(t0, { type: 'lowpass', f0: 1450 * p, dur: 0.075, lvl: 0.10 });
        nb(t0 + 0.035, { type: 'bandpass', f0: 2600 * p, q: 3, dur: 0.018, lvl: 0.20 });
        tn(t0 + 0.04, { type: 'sine', f0: 170, f1: 120, dur: 0.05, lvl: 0.05 });
        break;

      case 'magout':
        // 弹匣卡笋 -> 弹匣滑出 -> 金属轻碰
        nb(t0, { type: 'bandpass', f0: 3100 * p, q: 3.5, dur: 0.018, lvl: 0.38 });
        nb(t0 + 0.025, { type: 'bandpass', f0: 1700 * p, f1: 900 * p, q: 1.4, dur: 0.10 * wgt, lvl: 0.20 });
        nb(t0 + 0.10 * wgt, { type: 'bandpass', f0: 2200 * p, q: 2.4, dur: 0.018, lvl: 0.14 });
        break;

      case 'magin':
        // 弹匣插入（低频撞）-> 拍实（金属响）-> 弹簧回弹
        nb(t0, { type: 'lowpass', f0: 520 * p, dur: 0.08 * wgt, lvl: 0.34 });
        nb(t0 + 0.02, { type: 'bandpass', f0: 2700 * p, q: 3.0, dur: 0.02, lvl: 0.30 });
        nb(t0 + 0.075 * wgt, { type: 'bandpass', f0: 1400 * p, q: 2.0, dur: 0.035, lvl: 0.22 });
        tn(t0 + 0.01, { type: 'sine', f0: 150 * p, f1: 90, dur: 0.10 * wgt, lvl: 0.16 });
        break;

      case 'bolt':
        // 拉栓 / 上膛：三把枪循环节奏明显不同，AWM 更长更重
        if (id === 'awm') {
          nb(t0, { type: 'bandpass', f0: 2300 * p, f1: 850 * p, q: 1.2, dur: 0.20, lvl: 0.24 });
          nb(t0 + 0.20, { type: 'bandpass', f0: 3000 * p, q: 4.0, dur: 0.022, lvl: 0.42 });
          nb(t0 + 0.33, { type: 'lowpass', f0: 900, dur: 0.05, lvl: 0.30 });
          tn(t0 + 0.335, { type: 'triangle', f0: 1400 * p, dur: 0.10, lvl: 0.10 });
          tn(t0 + 0.02, { type: 'sine', f0: 150, f1: 90, dur: 0.16, lvl: 0.16 });
        } else if (id === 'deagle') {
          nb(t0, { type: 'bandpass', f0: 2600 * p, q: 3.2, dur: 0.020, lvl: 0.40 });
          nb(t0 + 0.04, { type: 'bandpass', f0: 1900 * p, f1: 1100 * p, q: 1.5, dur: 0.07, lvl: 0.16 });
          nb(t0 + 0.105, { type: 'bandpass', f0: 2800 * p, q: 3.5, dur: 0.022, lvl: 0.34 });
          tn(t0 + 0.105, { type: 'sine', f0: 170 * p, f1: 100, dur: 0.09, lvl: 0.14 });
        } else {
          nb(t0, { type: 'bandpass', f0: 2900 * p, q: 3.4, dur: 0.022, lvl: 0.38 });
          nb(t0 + 0.030, { type: 'bandpass', f0: 1700 * p, q: 1.2, dur: 0.05, lvl: 0.14 });
          nb(t0 + 0.078, { type: 'bandpass', f0: 3200 * p, q: 4.0, dur: 0.020, lvl: 0.32 });
          tn(t0 + 0.02, { type: 'sine', f0: 180 * p, f1: 110, dur: 0.07, lvl: 0.10 });
        }
        break;

      case 'end':
      default:
        // 收尾：衣服摩擦 + 小咔（也作为未知 stage 的兜底）
        nb(t0, { type: 'lowpass', f0: 900, dur: 0.09, lvl: 0.09 });
        nb(t0 + 0.05, { type: 'bandpass', f0: 2400 * p, q: 3, dur: 0.016, lvl: 0.18 });
        break;
    }

    finishAt(v, end + 0.08);
  }

  /* ============================ 切枪 / 开镜 ============================ */
  function playEquip(id, pos) {
    if (!playable()) return;
    var sp = spatial(pos);
    var v = reserveVoice(2);
    if (!v) return;
    var t0 = now() + 0.004 + sp.delay;
    var out = reg(v, mkGain(0.30 * sp.gain));
    routeOut(v, out, sp, 0.06);
    var heavy = id === 'awm' ? 1.55 : (id === 'deagle' ? 1.15 : 1.0);
    var p = 1 / Math.sqrt(heavy);

    noiseBurst(v, out, t0, { type: 'lowpass', f0: 1400, dur: 0.11 * heavy, lvl: 0.14 });                 // 衣服/装备摩擦
    noiseBurst(v, out, t0 + 0.05, { type: 'bandpass', f0: 2800 * p, q: 3.0, dur: 0.020, lvl: 0.30 });    // 金属壳
    tone(v, out, t0 + 0.055, { type: 'sine', f0: 210, f1: 120, dur: 0.08 * heavy, lvl: 0.18 });          // 枪身撞手
    if (heavy > 1.2) {
      noiseBurst(v, out, t0 + 0.10, { type: 'lowpass', f0: 700, dur: 0.06, lvl: 0.20 });
      tone(v, out, t0 + 0.10, { type: 'sine', f0: 110, f1: 70, dur: 0.12, lvl: 0.16 });
    }
    finishAt(v, t0 + 0.12 * heavy + 0.22);
  }

  function playScope(zoomIn) {
    if (!playable()) return;
    var v = reserveVoice(1);
    if (!v) return;
    var t0 = now() + 0.003;
    var out = reg(v, mkGain(zoomIn ? 0.22 : 0.16));
    out.connect(master);
    if (zoomIn) {
      noiseBurst(v, out, t0, { type: 'bandpass', f0: 3400, q: 4.0, dur: 0.012, lvl: 0.55 });
      tone(v, out, t0 + 0.004, { type: 'sine', f0: 2400, dur: 0.03, lvl: 0.10 });
      tone(v, out, t0, { type: 'sine', f0: 120, f1: 90, dur: 0.045, lvl: 0.14 });
    } else {
      noiseBurst(v, out, t0, { type: 'bandpass', f0: 2200, q: 3.0, dur: 0.014, lvl: 0.34 });
      tone(v, out, t0 + 0.003, { type: 'sine', f0: 1500, dur: 0.025, lvl: 0.07 });
    }
    finishAt(v, t0 + 0.12);
  }

  /* ============================ 战斗反馈 ============================ */
  function playHitmarker(headshot) {
    if (!playable()) return;
    var head = !!headshot;
    var v = reserveVoice(4);
    if (!v) return;
    var t0 = now() + 0.002;
    var out = reg(v, mkGain(head ? 0.34 : 0.20));
    out.connect(master);

    // 命中瞬态
    noiseBurst(v, out, t0, {
      type: 'bandpass', f0: head ? 4200 : 1400, q: 2.0,
      dur: head ? 0.012 : 0.016, lvl: head ? 0.50 : 0.38
    });

    if (head) {
      // CS2 标志性爆头“叮”：2.2~3kHz 正弦 + 泛音快速衰减
      tone(v, out, t0 + 0.002, { type: 'sine', f0: 2460, dur: 0.24, lvl: 0.50, attack: 0.002 });
      tone(v, out, t0 + 0.002, { type: 'sine', f0: 3420, dur: 0.16, lvl: 0.22, attack: 0.002 });
      tone(v, out, t0 + 0.002, { type: 'sine', f0: 5150, dur: 0.09, lvl: 0.10, attack: 0.002 });
    } else {
      // 身体命中：低沉闷“噗/嗒”
      tone(v, out, t0, { type: 'sine', f0: 190, f1: 118, dur: 0.06, lvl: 0.38 });
      noiseBurst(v, out, t0, { type: 'lowpass', f0: 720, dur: 0.045, lvl: 0.52 });
    }
    finishAt(v, t0 + 0.32);
  }

  function playHurt() {
    if (!playable()) return;
    var t = now();
    if (t - hurtLast < 0.045) return;   // 极短时间内叠加时合并，防止爆音
    hurtLast = t;
    var v = reserveVoice(4);
    if (!v) return;
    var t0 = t + 0.002;
    var out = reg(v, mkGain(0.38));
    out.connect(master);

    // 低频冲击
    tone(v, out, t0, { type: 'sine', f0: 98, f1: 52, dur: 0.16, lvl: 0.60 });
    // 闷哼：锯齿波 + 两个共振峰
    tone(v, out, t0 + 0.005, {
      type: 'sawtooth', f0: 155, f1: 108, dur: 0.17, lvl: 0.22,
      filter: { type: 'bandpass', f0: 520, q: 4.5 }
    });
    tone(v, out, t0 + 0.005, {
      type: 'sawtooth', f0: 150, f1: 104, dur: 0.15, lvl: 0.10,
      filter: { type: 'bandpass', f0: 980, q: 4.0 }
    });
    noiseBurst(v, out, t0, { type: 'bandpass', f0: 800, q: 1.2, dur: 0.12, lvl: 0.12 });
    finishAt(v, t0 + 0.26);
  }

  function playKillConfirm() {
    if (!playable()) return;
    var v = reserveVoice(4);
    if (!v) return;
    var t0 = now() + 0.002;
    var out = reg(v, mkGain(0.30));
    out.connect(master);

    // 比身体命中更亮的确认音：短促上行两音 + 金属泛音
    noiseBurst(v, out, t0, { type: 'bandpass', f0: 3000, q: 3.0, dur: 0.014, lvl: 0.30 });
    tone(v, out, t0, { type: 'sine', f0: 1180, dur: 0.09, lvl: 0.50, attack: 0.002 });
    tone(v, out, t0 + 0.004, { type: 'sine', f0: 1770, dur: 0.07, lvl: 0.28, attack: 0.002 });
    tone(v, out, t0 + 0.075, { type: 'triangle', f0: 2350, dur: 0.13, lvl: 0.16, attack: 0.002 });
    finishAt(v, t0 + 0.32);
  }

  function playDeath(pos) {
    if (!playable()) return;
    var sp = spatial(pos);
    var v = reserveVoice(3);
    if (!v) return;
    var t0 = now() + 0.004 + sp.delay;
    var out = reg(v, mkGain(0.38 * sp.gain));
    routeOut(v, out, sp, 0.08);

    // 倒地闷响 + 布料 + 装备金属碰撞
    tone(v, out, t0, { type: 'sine', f0: 105, f1: 42, dur: 0.28, lvl: 0.70 });
    noiseBurst(v, out, t0, { type: 'lowpass', f0: 430, dur: 0.24, lvl: 0.45 });
    noiseBurst(v, out, t0 + 0.06, { type: 'bandpass', f0: 2200, q: 2.5, dur: 0.05, lvl: 0.22 });
    noiseBurst(v, out, t0 + 0.13, { type: 'bandpass', f0: 1700, q: 2.0, dur: 0.04, lvl: 0.15 });
    tone(v, out, t0 + 0.10, { type: 'triangle', f0: 900, dur: 0.08, lvl: 0.05 });
    finishAt(v, t0 + 0.50);
  }

  /* ============================ 移动 ============================ */
  var SURFACES = {
    sand: {
      noise: { type: 'lowpass', f0: 780, f1: 380, q: 0.8, dur: 0.075, lvl: 0.15 },
      thump: { f0: 95, f1: 62, dur: 0.05, lvl: 0.10 },
      extra: { kind: 'noise', type: 'bandpass', f0: 1600, q: 1.0, dur: 0.028, lvl: 0.07, delay: 0.016 }
    },
    stone: {
      noise: { type: 'bandpass', f0: 2500, f1: 1400, q: 1.5, dur: 0.055, lvl: 0.20 },
      thump: { f0: 135, f1: 88, dur: 0.045, lvl: 0.12 },
      extra: { kind: 'noise', type: 'bandpass', f0: 4200, q: 2.0, dur: 0.014, lvl: 0.16, delay: 0.004 }
    },
    wood: {
      noise: { type: 'bandpass', f0: 640, f1: 430, q: 5.5, dur: 0.08, lvl: 0.22 },
      thump: { f0: 112, f1: 76, dur: 0.06, lvl: 0.15 },
      extra: { kind: 'tone', type: 'sine', f0: 262, f1: 210, dur: 0.10, lvl: 0.07, delay: 0.008 }
    },
    metal: {
      noise: { type: 'highpass', f0: 2700, q: 0.8, dur: 0.05, lvl: 0.20 },
      thump: { f0: 150, f1: 92, dur: 0.05, lvl: 0.10 },
      extra: { kind: 'tone', type: 'sine', f0: 3300, f1: 2900, dur: 0.08, lvl: 0.10, delay: 0.002 }
    },
    concrete: {
      noise: { type: 'bandpass', f0: 1750, f1: 950, q: 1.3, dur: 0.055, lvl: 0.18 },
      thump: { f0: 125, f1: 84, dur: 0.045, lvl: 0.12 },
      extra: null
    }
  };

  function playFootstep(surface, pos) {
    if (!playable()) return;
    var sp = spatial(pos);
    var cfg = SURFACES[surface] || SURFACES.concrete;
    var v = reserveVoice(2);
    if (!v) return;
    var t0 = now() + 0.003 + sp.delay;
    var vol = rand(0.82, 1.18);
    var pitch = rand(0.92, 1.09);
    var out = reg(v, mkGain(0.30 * vol * sp.gain));
    routeOut(v, out, sp, 0.05);

    var n = cfg.noise;
    noiseBurst(v, out, t0, {
      type: n.type, f0: n.f0 * pitch, f1: n.f1 ? n.f1 * pitch : 0,
      q: n.q, dur: n.dur, lvl: n.lvl
    });
    if (cfg.thump) {
      tone(v, out, t0, {
        type: 'sine', f0: cfg.thump.f0 * pitch, f1: cfg.thump.f1 * pitch,
        dur: cfg.thump.dur, lvl: cfg.thump.lvl
      });
    }
    var e = cfg.extra;
    if (e) {
      if (e.kind === 'tone') {
        tone(v, out, t0 + (e.delay || 0), {
          type: e.type, f0: e.f0 * pitch, f1: e.f1 ? e.f1 * pitch : 0, dur: e.dur, lvl: e.lvl
        });
      } else {
        noiseBurst(v, out, t0 + (e.delay || 0), {
          type: e.type, f0: e.f0 * pitch, q: e.q, dur: e.dur, lvl: e.lvl
        });
      }
    }
    finishAt(v, t0 + 0.18);
  }

  function playLand(pos) {
    if (!playable()) return;
    var sp = spatial(pos);
    var v = reserveVoice(2);
    if (!v) return;
    var t0 = now() + 0.004 + sp.delay;
    var out = reg(v, mkGain(0.42 * sp.gain));
    routeOut(v, out, sp, 0.06);
    tone(v, out, t0, { type: 'sine', f0: 95, f1: 40, dur: 0.20, lvl: 0.75 });
    noiseBurst(v, out, t0, { type: 'lowpass', f0: 340, dur: 0.15, lvl: 0.45 });
    noiseBurst(v, out, t0 + 0.015, { type: 'bandpass', f0: 1500, q: 1.5, dur: 0.05, lvl: 0.15 });
    finishAt(v, t0 + 0.32);
  }

  function playJump(pos) {
    if (!playable()) return;
    var sp = spatial(pos);
    var v = reserveVoice(1);
    if (!v) return;
    var t0 = now() + 0.003 + sp.delay;
    var out = reg(v, mkGain(0.20 * sp.gain));
    routeOut(v, out, sp, 0.03);
    // 起跳时衣服/背带摩擦，不是“boing”
    noiseBurst(v, out, t0, { type: 'bandpass', f0: 1200, f1: 2300, q: 1.0, dur: 0.14, lvl: 0.11, attack: 0.02 });
    noiseBurst(v, out, t0 + 0.01, { type: 'lowpass', f0: 620, dur: 0.10, lvl: 0.08, attack: 0.012 });
    tone(v, out, t0 + 0.02, { type: 'sine', f0: 190, f1: 150, dur: 0.05, lvl: 0.05 });
    finishAt(v, t0 + 0.20);
  }

  /* ============================ 流程 / UI 音乐性提示 ============================ */
  function playNotes(v, dest, t0, notes, opts) {
    opts = opts || {};
    var t = t0;
    for (var i = 0; i < notes.length; i++) {
      tone(v, dest, t, {
        type: opts.type || 'triangle',
        f0: notes[i],
        dur: opts.dur || 0.2,
        lvl: opts.lvl || 0.18,
        attack: opts.attack || 0.004
      });
      t += opts.stagger || 0.12;
    }
    return t;
  }

  function playRoundStart() {
    if (!playable()) return;
    var v = reserveVoice(3);
    if (!v) return;
    var t0 = now() + 0.002;
    var out = reg(v, mkGain(0.26));
    out.connect(master);
    // 短促提示音，不做长旋律
    noiseBurst(v, out, t0, { type: 'bandpass', f0: 2200, q: 2.0, dur: 0.012, lvl: 0.18 });
    tone(v, out, t0, { type: 'triangle', f0: 660, dur: 0.09, lvl: 0.30 });
    tone(v, out, t0 + 0.11, { type: 'triangle', f0: 990, dur: 0.12, lvl: 0.26 });
    finishAt(v, t0 + 0.32);
  }

  function playRoundWin() {
    if (!playable()) return;
    var v = reserveVoice(3);
    if (!v) return;
    var t0 = now() + 0.002;
    var out = reg(v, mkGain(0.34));
    out.connect(master);
    // C 大调上行短琶音 + 低音铺底
    playNotes(v, out, t0, [523.25, 659.25, 783.99, 1046.50], { stagger: 0.10, dur: 0.20, lvl: 0.17, type: 'triangle' });
    tone(v, out, t0 + 0.02, { type: 'sine', f0: 130.81, dur: 0.80, lvl: 0.10 });
    tone(v, out, t0 + 0.05, { type: 'sine', f0: 523.25, dur: 0.70, lvl: 0.05 });
    tone(v, out, t0 + 0.05, { type: 'sine', f0: 783.99, dur: 0.70, lvl: 0.05 });
    finishAt(v, t0 + 1.05);
  }

  function playRoundLose() {
    if (!playable()) return;
    var v = reserveVoice(3);
    if (!v) return;
    var t0 = now() + 0.002;
    var out = reg(v, mkGain(0.30));
    out.connect(master);
    // 下行小调，低沉克制
    playNotes(v, out, t0, [392.00, 349.23, 293.66, 246.94], { stagger: 0.13, dur: 0.26, lvl: 0.15, type: 'triangle' });
    tone(v, out, t0 + 0.05, { type: 'sine', f0: 98.00, dur: 0.90, lvl: 0.10 });
    finishAt(v, t0 + 1.35);
  }

  function playMatchWin() {
    if (!playable()) return;
    var v = reserveVoice(3);
    if (!v) return;
    var t0 = now() + 0.002;
    var out = reg(v, mkGain(0.38));
    out.connect(master);
    // 1.7s 胜利小号角：上行五音 + 大三和弦铺底 + 高音闪光
    playNotes(v, out, t0, [392.00, 523.25, 659.25, 783.99, 1046.50], { stagger: 0.12, dur: 0.26, lvl: 0.16, type: 'triangle' });
    tone(v, out, t0 + 0.10, { type: 'sine', f0: 261.63, dur: 1.2, lvl: 0.07 });
    tone(v, out, t0 + 0.10, { type: 'sine', f0: 329.63, dur: 1.2, lvl: 0.06 });
    tone(v, out, t0 + 0.10, { type: 'sine', f0: 392.00, dur: 1.2, lvl: 0.06 });
    tone(v, out, t0 + 0.55, { type: 'sine', f0: 1567.98, dur: 0.55, lvl: 0.045 });
    finishAt(v, t0 + 1.75);
  }

  function playMatchLose() {
    if (!playable()) return;
    var v = reserveVoice(3);
    if (!v) return;
    var t0 = now() + 0.002;
    var out = reg(v, mkGain(0.34));
    out.connect(master);
    // 1.9s 下行失败动机 + 低频持续音
    playNotes(v, out, t0, [349.23, 311.13, 261.63, 233.08, 174.61], { stagger: 0.16, dur: 0.30, lvl: 0.14, type: 'triangle' });
    tone(v, out, t0 + 0.06, { type: 'sine', f0: 87.31, dur: 1.65, lvl: 0.12 });
    tone(v, out, t0 + 0.30, { type: 'sine', f0: 174.61, dur: 1.2, lvl: 0.05 });
    finishAt(v, t0 + 1.95);
  }

  function playCountdownBeep(last) {
    if (!playable()) return;
    var v = reserveVoice(3);
    if (!v) return;
    var t0 = now() + 0.002;
    var isLast = !!last;
    var out = reg(v, mkGain(isLast ? 0.34 : 0.26));
    out.connect(master);
    noiseBurst(v, out, t0, { type: 'bandpass', f0: isLast ? 3200 : 2600, q: 2.5, dur: 0.012, lvl: 0.16 });
    if (isLast) {
      tone(v, out, t0, { type: 'triangle', f0: 1320, dur: 0.17, lvl: 0.42 });
      tone(v, out, t0, { type: 'sine', f0: 660, dur: 0.17, lvl: 0.13 });
    } else {
      tone(v, out, t0, { type: 'triangle', f0: 880, dur: 0.085, lvl: 0.28 });
    }
    finishAt(v, t0 + 0.30);
  }

  function playUiClick() {
    if (!playable()) return;
    var v = reserveVoice(1);
    if (!v) return;
    var t0 = now() + 0.002;
    var out = reg(v, mkGain(0.18));
    out.connect(master);
    noiseBurst(v, out, t0, { type: 'bandpass', f0: 1400, q: 1.5, dur: 0.016, lvl: 0.55 });
    tone(v, out, t0, { type: 'sine', f0: 850, dur: 0.025, lvl: 0.09 });
    finishAt(v, t0 + 0.09);
  }

  function playUiHover() {
    if (!playable()) return;
    var v = reserveVoice(1);
    if (!v) return;
    var t0 = now() + 0.002;
    var out = reg(v, mkGain(0.10));
    out.connect(master);
    tone(v, out, t0, { type: 'sine', f0: 1900, dur: 0.014, lvl: 0.30, attack: 0.002 });
    noiseBurst(v, out, t0, { type: 'bandpass', f0: 3200, q: 2.0, dur: 0.008, lvl: 0.22 });
    finishAt(v, t0 + 0.06);
  }

  /* ============================ 环境声（风声 + 低鸣循环） ============================ */
  function ensureAmbience() {
    if (amb || !ctx || !master || !noiseBuf) return;
    try {
      var out = ctx.createGain();
      out.gain.value = 0.0001;
      out.connect(master);

      // 风：低通白噪声 + 0.06Hz 缓慢 LFO 摆动
      var wind = ctx.createBufferSource();
      wind.buffer = noiseBuf;
      wind.loop = true;
      var windLp = mkFilter('lowpass', 460, 0.7);
      var windGain = ctx.createGain();
      windGain.gain.value = 0.055;
      var lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.06;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.025;
      wind.connect(windLp);
      windLp.connect(windGain);
      windGain.connect(out);
      lfo.connect(lfoGain);
      lfoGain.connect(windGain.gain);

      // 空气层：中频带通噪声，很轻
      var air = ctx.createBufferSource();
      air.buffer = noiseBuf;
      air.loop = true;
      var airBp = mkFilter('bandpass', 1300, 0.6);
      var airGain = ctx.createGain();
      airGain.gain.value = 0.012;
      air.connect(airBp);
      airBp.connect(airGain);
      airGain.connect(out);

      // 低鸣：两个略微失谐的低频正弦
      var hum1 = ctx.createOscillator();
      hum1.type = 'sine';
      hum1.frequency.value = 52;
      var hum2 = ctx.createOscillator();
      hum2.type = 'sine';
      hum2.frequency.value = 55.4;
      var humGain = ctx.createGain();
      humGain.gain.value = 0.012;
      hum1.connect(humGain);
      hum2.connect(humGain);
      humGain.connect(out);

      try { wind.start(0, Math.random()); } catch (e) { try { wind.start(0); } catch (e2) { /* ignore */ } }
      try { air.start(0, Math.random()); } catch (e) { try { air.start(0); } catch (e2) { /* ignore */ } }
      try { lfo.start(0); } catch (e) { /* ignore */ }
      try { hum1.start(0); } catch (e) { /* ignore */ }
      try { hum2.start(0); } catch (e) { /* ignore */ }

      amb = {
        out: out,
        nodes: [wind, windLp, windGain, lfo, lfoGain, air, airBp, airGain, hum1, hum2, humGain]
      };
      applyAmbienceGain();
    } catch (e) {
      amb = null;
    }
  }

  function applyAmbienceGain() {
    if (!amb || !ctx) return;
    var target = ambienceWanted ? 0.55 : 0.0001;
    try { amb.out.gain.setTargetAtTime(target, ctx.currentTime, ambienceWanted ? 0.8 : 0.5); }
    catch (e) { try { amb.out.gain.value = target; } catch (e2) { /* ignore */ } }
  }

  function playAmbience(on) {
    ambienceWanted = !!on;
    ensureAmbience();
    applyAmbienceGain();
  }

  /* ============================ updateListener ============================ */
  function updateListenerFn(pos, yaw, pitch) {
    var p = readPos(pos);
    if (p) {
      listener.x = p[0];
      listener.y = p[1];
      listener.z = p[2];
    }
    var y = +yaw;
    if (isFinite(y)) listener.yaw = y;
    var pt = +pitch;
    if (isFinite(pt)) listener.pitch = pt;
  }

  /* ============================ 调试读数（自测 / F3） ============================ */
  function getDebugState() {
    var info = {
      version: VERSION,
      ok: !!(ctx && readyFlag),
      state: ctx ? ctx.state : 'none',
      sampleRate: ctx ? ctx.sampleRate : 0,
      voices: voices.length,
      maxVoices: MAX_VOICES,
      started: voiceTotal,
      muted: muted,
      volume: volume,
      ambience: !!(amb && ambienceWanted),
      listener: { x: listener.x, y: listener.y, z: listener.z, yaw: listener.yaw },
      peak: 0
    };
    if (analyser && analyserBuf) {
      try {
        analyser.getFloatTimeDomainData(analyserBuf);
        var peak = 0;
        for (var i = 0; i < analyserBuf.length; i++) {
          var a = analyserBuf[i] < 0 ? -analyserBuf[i] : analyserBuf[i];
          if (a > peak) peak = a;
        }
        info.peak = peak;
      } catch (e) { /* ignore */ }
    }
    return info;
  }

  /* ============================ 公开 API（全部 try/catch 兜底） ============================ */
  function guard(fn, fallback) {
    return function () {
      try {
        return fn.apply(null, arguments);
      } catch (e) {
        if (window.__AUDIO_DEBUG__) {
          try { console.warn('[GAME.Audio]', e && e.message ? e.message : e); } catch (e2) { /* ignore */ }
        }
        return fallback;
      }
    };
  }

  var Audio = {
    VERSION: VERSION,

    init: guard(initAudio),
    unlock: guard(function () {
      initAudio();
      tryResume(true);
      if (ambienceWanted) ensureAmbience();
    }),
    ready: guard(function () { return !!(ctx && readyFlag && ctx.state === 'running'); }, false),

    setVolume: guard(function (v) {
      volume = clamp(num(v, DEFAULT_VOLUME), 0, 1);
      applyVolume();
    }),
    setMuted: guard(function (b) {
      muted = !!b;
      applyVolume();
    }),
    isMuted: guard(function () { return muted; }, false),
    toggleMute: guard(function () {
      muted = !muted;
      applyVolume();
      return muted;
    }, false),

    updateListener: guard(updateListenerFn),

    /* ---- 枪械 ---- */
    shot: guard(function (weaponId, pos) { playShot(weaponId, pos); }),
    dryFire: guard(function (weaponId, pos) { playDryFire(weaponId, pos); }),
    reload: guard(function (weaponId, stage, pos) { playReload(weaponId, stage, pos); }),
    equip: guard(function (weaponId, pos) { playEquip(weaponId, pos); }),
    scopeIn: guard(function () { playScope(true); }),
    scopeOut: guard(function () { playScope(false); }),

    /* ---- 战斗反馈 ---- */
    hitmarker: guard(function (headshot) { playHitmarker(headshot); }),
    hurt: guard(playHurt),
    killConfirm: guard(playKillConfirm),
    death: guard(function (pos) { playDeath(pos); }),

    /* ---- 移动 ---- */
    footstep: guard(function (surface, pos) { playFootstep(surface, pos); }),
    land: guard(function (pos) { playLand(pos); }),
    jump: guard(function (pos) { playJump(pos); }),

    /* ---- 流程 / UI ---- */
    roundStart: guard(playRoundStart),
    roundWin: guard(playRoundWin),
    roundLose: guard(playRoundLose),
    countdownBeep: guard(function (last) { playCountdownBeep(last); }),
    matchWin: guard(playMatchWin),
    matchLose: guard(playMatchLose),
    uiClick: guard(playUiClick),
    uiHover: guard(playUiHover),
    ambience: guard(function (on) { playAmbience(on); }),

    /* ---- 调试（不属于契约，供自测/F3 用） ---- */
    getDebug: guard(getDebugState, { ok: false })
  };

  GAME.Audio = Audio;
})();
