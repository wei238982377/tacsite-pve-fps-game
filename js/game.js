/* ============================================================
   AI GAME · 沙漠对决 — 对战流程 / 战斗判定 / HUD / 输入
   状态机：menu ↔ playing ↔ paused → results → menu
   ============================================================ */
"use strict";
(function () {
  var G = window.GAME = window.GAME || {};
  var M = G.M;

  var $ = function (id) { return document.getElementById(id); };
  var canvas = null, loadingText = null;

  var DIFF_LABEL = { easy: '简单', normal: '普通', hard: '困难' };
  var TARGET_KILLS = 8;
  var RESPAWN_TIME = 3.0;
  var SPAWN_PROTECT = 1.6;
  var WEAPON_NAMES = { deagle: '沙漠之鹰', awm: 'AWM', ak47: 'AK-47' };
  var STORAGE_KEY = 'aigame_dustduel_v1';

  var state = 'menu';       // menu | playing | paused | results
  var difficulty = 'normal';
  var selectedDiff = 'normal';
  var testMode = false;
  var freeze = false;
  var manual = false;
  var botFrozen = false;

  var player = null, bot = null;
  var scoreP = 0, scoreB = 0;
  var stats = { shots: 0, hits: 0, headshots: 0, kills: 0, deaths: 0, streak: 0, bestStreak: 0 };
  var matchStart = 0, now = 0;
  var realTime = 0;
  var respawnP = 0, respawnB = 0;
  var botProtect = 0;
  var botDeathT = 0;
  var hitT = 0, hitHead = false, hitKill = false;
  var damageT = 0, damageDir = 0;
  var lowHpT = 0;
  var centerMsgT = 0;
  var killBannerT = 0;
  var spawnPairIndex = 0;
  var pausedFromState = 'playing';
  var settingsReturn = 'menu';
  var debugVisible = false;
  var input = {
    mouseDX: 0, mouseDY: 0,
    forward: false, back: false, left: false, right: false,
    jump: false, crouch: false, walk: false,
    fire: false, reloadPressed: false, switchTo: null, scopePressed: false,
    sens: 1
  };
  var firePrev = false;
  var lastShotSound = -1;
  var lastPlayerShotAbs = -99;
  var soundThisFrame = false;
  var botPrevReloading = false;
  var botFootAccum = 0;
  var botMovePhase = 0;
  var botLastPos = null;
  var settings = { sens: 1.0, volume: 0.7, scale: 'auto', crosshair: 'green' };
  var best = {};
  var currentScale = 0.8;
  var fpsAccum = 0, fpsFrames = 0, fpsShown = 60;
  var lastAutoScaleCheck = 0;
  var audioReady = false;
  var info = { bullets: [] };
  var cinematic = { t: 0, eye: [0, 3, 0], yaw: 0 };
  var testPose = false;

  var el = {};
  function cacheEls() {
    var ids = ['menu', 'help', 'settings', 'pause-menu', 'results', 'hud', 'loading', 'scope-overlay',
      'btn-start', 'btn-help', 'btn-settings', 'btn-help-back', 'btn-settings-back',
      'btn-resume', 'btn-restart', 'btn-pause-settings', 'btn-pause-menu',
      'btn-rematch', 'btn-change-diff', 'btn-results-menu',
      'menu-best', 'menu-title',
      'score-player', 'score-bot', 'match-diff', 'match-mode',
      'killfeed', 'kill-banner', 'center-msg', 'hitmarker', 'crosshair',
      'health-value', 'health-bar-fill', 'health-panel', 'armor-box',
      'ammo-value', 'ammo-reserve', 'weapon-name', 'ammo-panel', 'reload-hint', 'reload-bar', 'reload-bar-fill',
      'weapon-slots', 'fps', 'debug', 'streak', 'damage-vignette', 'lowhp-vignette',
      'damage-dir', 'spawn-shield', 'pause-score-player', 'pause-score-bot',
      'result-title', 'result-score', 'stat-kills', 'stat-deaths', 'stat-hs', 'stat-acc', 'stat-best', 'stat-diff',
      'sens', 'sens-value', 'vol', 'vol-value', 'scale-options', 'crosshair-options', 'fps-counter'];
    for (var i = 0; i < ids.length; i++) el[ids[i]] = $(ids[i]);
  }

  /* ---------------- localStorage ---------------- */
  function loadStorage() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (data && data.settings) {
        if (typeof data.settings.sens === 'number') settings.sens = M.clamp(data.settings.sens, 0.1, 3);
        if (typeof data.settings.volume === 'number') settings.volume = M.clamp(data.settings.volume, 0, 1);
        if (data.settings.scale) settings.scale = data.settings.scale;
        if (data.settings.crosshair) settings.crosshair = data.settings.crosshair;
      }
      if (data && data.best) best = data.best;
      if (data && data.difficulty && DIFF_LABEL[data.difficulty]) selectedDiff = data.difficulty;
    } catch (e) { /* ignore */ }
  }
  function saveStorage() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        settings: settings, best: best, difficulty: selectedDiff
      }));
    } catch (e) { /* ignore */ }
  }

  function bestFor(diff) {
    if (!best[diff]) best[diff] = { wins: 0, losses: 0, bestScore: '0:0', bestHs: 0, bestAcc: 0 };
    return best[diff];
  }

  /* ---------------- 屏幕切换 ---------------- */
  var SCREENS = ['menu', 'help', 'settings', 'pause-menu', 'results'];
  function hideScreens() {
    for (var i = 0; i < SCREENS.length; i++) {
      if (el[SCREENS[i]]) el[SCREENS[i]].classList.add('hidden');
    }
  }
  function showScreen(id) {
    hideScreens();
    if (id && el[id]) el[id].classList.remove('hidden');
  }
  function showHud(v) {
    if (!el.hud) return;
    if (v) el.hud.classList.remove('hidden'); else el.hud.classList.add('hidden');
  }
  function showLoading(v, text) {
    if (v) { el.loading.classList.remove('hidden'); } else { el.loading.classList.add('hidden'); }
    if (text && loadingText) loadingText.textContent = text;
  }

  /* ---------------- HUD ---------------- */
  function setText(node, txt) { if (node && node.textContent !== txt) node.textContent = txt; }
  function updateHUD() {
    if (!el.hud || state === 'menu') return;
    var p = player;
    if (!p) return;
    var def = p.weapon;
    var st = p.ammoStates[p.weaponId];
    setText(el['weapon-name'], def.name);
    setText(el['ammo-value'], String(st.ammo));
    setText(el['ammo-reserve'], '/ ' + st.reserve);
    if (el['health-value']) setText(el['health-value'], String(Math.ceil(p.health)));
    if (el['health-bar-fill']) el['health-bar-fill'].style.width = Math.max(0, Math.min(100, p.health)) + '%';
    if (el['health-panel']) el['health-panel'].classList.toggle('low', p.health <= 30);
    if (el['ammo-panel']) el['ammo-panel'].classList.toggle('low', st.ammo <= Math.ceil(def.mag * 0.25));
    if (el['reload-hint']) el['reload-hint'].classList.toggle('show', p.reloading || (st.ammo === 0 && !p.reloading));
    if (el['reload-bar']) {
      el['reload-bar'].classList.toggle('show', p.reloading);
      if (p.reloading && el['reload-bar-fill']) {
        el['reload-bar-fill'].style.width = Math.min(100, (p.reloadT / p.reloadDur) * 100) + '%';
      }
    }
    setText(el['score-player'], String(scoreP));
    setText(el['score-bot'], String(scoreB));
    setText(el['match-diff'], DIFF_LABEL[difficulty] || '普通');
    setText(el['match-mode'], '先到 ' + TARGET_KILLS + ' 杀');
    // 武器槽
    if (el['weapon-slots']) {
      var slots = el['weapon-slots'].children;
      for (var i = 0; i < slots.length; i++) {
        var sid = G.Weapons.ORDER[i];
        slots[i].classList.toggle('active', sid === p.weaponId);
      }
    }
    // 准星
    if (el.crosshair) {
      el.crosshair.classList.toggle('hidden', p.scoped || !p.alive || state !== 'playing');
      el.crosshair.classList.remove('ch-ak47', 'ch-deagle', 'ch-awm');
      el.crosshair.classList.add('ch-' + (def.crosshair || 'ak47'));
      var speed = p.speed || 0;
      var spread = 4 + speed * 1.7 + (p.shotSpread || 0) * 4 + (p.actor.onGround ? 0 : 8);
      el.crosshair.style.setProperty('--spread', spread.toFixed(1) + 'px');
      el.crosshair.classList.toggle('firing', !!p.firing);
    }
    // 开镜 overlay
    if (el['scope-overlay']) {
      var scoped = p.scoped && p.alive;
      el['scope-overlay'].classList.toggle('hidden', !scoped);
    }
    // 命中反馈
    if (el.hitmarker) {
      el.hitmarker.classList.toggle('show', hitT > 0);
      el.hitmarker.classList.toggle('headshot', hitT > 0 && hitHead);
      el.hitmarker.classList.toggle('kill', hitT > 0 && hitKill);
    }
    if (el['kill-banner']) {
      el['kill-banner'].classList.toggle('show', killBannerT > 0);
    }
    if (el['center-msg']) {
      el['center-msg'].classList.toggle('show', centerMsgT > 0);
    }
    // 受伤暗角 / 低血 / 方向
    if (el['damage-vignette']) el['damage-vignette'].classList.toggle('show', damageT > 0.02);
    if (el['lowhp-vignette']) el['lowhp-vignette'].classList.toggle('show', p.alive && p.health <= 30 && state === 'playing');
    if (el['damage-dir']) {
      el['damage-dir'].classList.toggle('show', damageT > 0.02);
      el['damage-dir'].style.setProperty('--dir', damageDir.toFixed(0) + 'deg');
    }
    if (el['spawn-shield']) el['spawn-shield'].classList.toggle('show', p.alive && p.spawnProtection > 0.05 && state === 'playing');
    if (el.streak) {
      el.streak.textContent = stats.streak >= 2 ? (stats.streak === 2 ? '双杀' : (stats.streak === 3 ? '三连杀' : stats.streak + ' 连杀')) : '';
      el.streak.classList.toggle('hot', stats.streak >= 3);
    }
    // 调试
    if (el.debug) {
      el.debug.classList.toggle('show', debugVisible);
      if (debugVisible && bot) {
        el.debug.textContent = 'FPS ' + fpsShown.toFixed(0) + ' | calls ' + G.Engine.stats.drawCalls +
          ' | tris ' + Math.round(G.Engine.stats.triangles) + '\n' +
          '玩家 ' + player.pos.map(function (v) { return v.toFixed(1); }).join(',') +
          ' hp=' + Math.ceil(player.health) + ' ' + player.weaponId + '\n' +
          'BOT  ' + bot.pos.map(function (v) { return v.toFixed(1); }).join(',') +
          ' hp=' + Math.ceil(bot.health) + ' ' + (bot.state || '') + ' ' + (bot.alive ? 'alive' : 'dead') + '\n' +
          '难度 ' + difficulty + ' | 比分 ' + scoreP + ':' + scoreB + ' | 音效 ' + (audioReady ? 'ok' : '-') +
          ' | 分辨率 ' + currentScale.toFixed(2) + 'x';
      }
    }
    setText(el.fps, fpsShown.toFixed(0) + ' FPS');
  }

  function killfeedAdd(killer, weapon, victim, headshot) {
    if (!el.killfeed) return;
    var row = document.createElement('div');
    row.className = 'kf-row';
    var a = document.createElement('span'); a.className = 'kf-killer'; a.textContent = killer;
    var b = document.createElement('span'); b.className = 'kf-weapon'; b.textContent = weapon;
    var c = document.createElement('span'); c.className = 'kf-victim'; c.textContent = victim;
    row.appendChild(a); row.appendChild(b); row.appendChild(c);
    if (headshot) {
      var d = document.createElement('span'); d.className = 'kf-hs'; d.textContent = '爆头';
      row.appendChild(d);
    }
    el.killfeed.appendChild(row);
    while (el.killfeed.children.length > 5) el.killfeed.removeChild(el.killfeed.firstChild);
    setTimeout(function () { row.classList.add('kf-out'); }, 4600);
    setTimeout(function () {
      if (row.parentNode === el.killfeed) el.killfeed.removeChild(row);
    }, 5000);
  }

  function showCenterMsg(text, dur, warn) {
    if (!el['center-msg']) return;
    el['center-msg'].textContent = text;
    el['center-msg'].classList.toggle('warn', !!warn);
    centerMsgT = dur || 2.0;
  }
  function showKillBanner(text) {
    if (!el['kill-banner']) return;
    el['kill-banner'].textContent = text;
    killBannerT = 1.4;
  }
  function onHitmarker(headshot, kill) {
    hitT = 0.14; hitHead = !!headshot; hitKill = !!kill;
  }
  function onPlayerHurt(amount, dir) {
    damageT = 0.55;
    if (dir) {
      // 计算相对视角的方向角（0=正前，顺时针对应右侧）
      var dx = dir[0], dz = dir[2];
      var fwd = M.forwardFrom(player.yaw + player.viewRecoilYaw, 0, [0, 0, 0]);
      var right = M.rightFrom(player.yaw + player.viewRecoilYaw, [0, 0, 0]);
      var fx = M.v3.dot([dx, 0, dz], fwd), rx = M.v3.dot([dx, 0, dz], right);
      damageDir = Math.atan2(rx, fx) / M.DEG;
    }
  }

  /* ---------------- 音效代理 ---------------- */
  function audioCall(name) {
    var A = G.Audio;
    if (!A || typeof A[name] !== 'function') return;
    try {
      var args = Array.prototype.slice.call(arguments, 1);
      A[name].apply(A, args);
    } catch (e) { /* 静默失败，不影响游戏 */ }
  }
  function ensureAudio() {
    if (!G.Audio) return;
    try {
      if (!audioReady) {
        G.Audio.init();
        G.Audio.setVolume(settings.volume);
        G.Audio.setMuted(false);
        audioReady = true;
      }
      G.Audio.unlock();
    } catch (e) { audioReady = false; }
  }

  /* ---------------- 武器 / 战斗判定 ---------------- */
  var camera = { eye: [0, 0, 0], yaw: 0, pitch: 0 };
  function eyeOf(p) {
    return [p.pos[0], p.pos[1] + (p.actor ? p.actor.eyeHeight : 1.65), p.pos[2]];
  }
  function muzzleWorld(p) {
    var eye = eyeOf(p);
    var f = M.forwardFrom(p.yaw + p.viewRecoilYaw, p.pitch + p.viewRecoilPitch, [0, 0, 0]);
    var r = M.rightFrom(p.yaw, [0, 0, 0]);
    return [eye[0] + f[0] * 0.55 + r[0] * 0.12, eye[1] + f[1] * 0.55 - 0.08, eye[2] + f[2] * 0.55 + r[2] * 0.12];
  }

  function hitboxesFor(actor, isBot) {
    var x = actor.pos[0], y = actor.pos[1], z = actor.pos[2];
    var crouch = 0;
    if (typeof actor.crouch === 'number') crouch = actor.crouch;
    else if (actor.crouching) crouch = 1;
    var h = 1.8 - 0.62 * M.clamp(crouch, 0, 1);
    var w = isBot ? 0.32 : 0.32;
    var legTop = y + h * 0.47;
    var headBottom = y + h - 0.30;
    return [
      { zone: 'head', min: [x - 0.16, headBottom, z - 0.16], max: [x + 0.16, y + h, z + 0.16] },
      { zone: 'body', min: [x - w, legTop, z - w], max: [x + w, headBottom, z + w] },
      { zone: 'legs', min: [x - w, y, z - w], max: [x + w, legTop, z + w] }
    ];
  }

  function rayActor(origin, dir, maxDist, actor, isBot) {
    var boxes = hitboxesFor(actor, isBot);
    var best = null;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      var hit = M.rayAABB(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], b.min, b.max, maxDist);
      if (hit && (!best || hit.t < best.dist)) {
        best = {
          dist: hit.t, zone: b.zone,
          point: [origin[0] + dir[0] * hit.t, origin[1] + dir[1] * hit.t, origin[2] + dir[2] * hit.t],
          normal: hit.normal
        };
      }
    }
    return best;
  }

  function surfaceFromMaterial(mat) {
    var map = { sand: 'sand', wall: 'concrete', brick: 'stone', crate: 'wood', metal: 'metal', concrete: 'concrete', stone: 'stone', tarp: 'sand', wood: 'wood', roof: 'wood' };
    return map[mat] || 'sand';
  }

  function playerShoot(ev) {
    var def = G.Weapons.defs[ev.weaponId];
    var dir = G.Weapons.applySpread(ev.dir, ev.spreadDeg);
    var maxDist = def.range || 90;
    var mapHit = G.Engine.worldRaycast(ev.origin, dir, maxDist);
    var botHit = null;
    if (bot && bot.alive) {
      var limit = mapHit.hit ? mapHit.dist : maxDist;
      botHit = rayActor(ev.origin, dir, limit, bot, true);
    }
    var muzzle = muzzleWorld(player);
    var endPoint;
    stats.shots++;
    if (botHit) {
      endPoint = botHit.point;
      if (botProtect > 0) {
        G.Engine.impact(botHit.point, dir.slice().map(function (v) { return -v; }), 'metal');
        audioCall('hitmarker', false);
      } else {
        var dmg = def.damage[botHit.zone] || def.damage.body;
        var res = bot.takeDamage(dmg, botHit.zone);
        stats.hits++;
        if (botHit.zone === 'head') stats.headshots++;
        G.Engine.blood(botHit.point, dir, botHit.zone === 'head');
        onHitmarker(botHit.zone === 'head', !!res.dead);
        audioCall('hitmarker', botHit.zone === 'head');
        if (res.dead) onBotKilled(botHit.zone === 'head');
      }
    } else if (mapHit.hit) {
      endPoint = mapHit.point;
      G.Engine.impact(mapHit.point, mapHit.normal, mapHit.material);
    } else {
      endPoint = [ev.origin[0] + dir[0] * maxDist, ev.origin[1] + dir[1] * maxDist, ev.origin[2] + dir[2] * maxDist];
    }
    G.Engine.tracer(muzzle, endPoint, def.tracerColor);
    G.Engine.muzzleFlash(muzzle, [1.0, 0.82, 0.35], 0.32);
    audioCall('shot', ev.weaponId);
    lastPlayerShotAbs = realTime;
    if (bot && bot.alive && typeof bot.onHearShot === 'function') {
      try { bot.onHearShot(ev.origin); } catch (e) { /* ignore */ }
    }
  }

  function botFire(dir, opts) {
    if (!bot || !bot.alive || !player) return { hit: false, headshot: false, damage: 0 };
    opts = opts || {};
    var def = G.Weapons.defs[bot.weaponId || 'ak47'];
    // Bot 已经在瞄准方向里叠加了自身的高斯误差，这里不再二次加散布
    var shotDir = dir;
    var origin = bot.eyePos ? bot.eyePos() : [bot.pos[0], bot.pos[1] + 1.65, bot.pos[2]];
    var maxDist = def.range || 90;
    var mapHit = G.Engine.worldRaycast(origin, shotDir, maxDist);
    var playerHit = null;
    if (player.alive) {
      var limit = mapHit.hit ? mapHit.dist : maxDist;
      playerHit = rayActor(origin, shotDir, limit, player, false);
    }
    var muzzle = botMuzzle(origin, shotDir);
    var endPoint;
    if (!soundThisFrame) {
      audioCall('shot', 'ak47', origin);
      soundThisFrame = true;
    }
    G.Engine.muzzleFlash(muzzle, [1.0, 0.8, 0.32], 0.3);
    var result = { hit: false, headshot: false, damage: 0 };
    if (playerHit) {
      endPoint = playerHit.point;
      var dmg = def.damage[playerHit.zone] || def.damage.body;
      var r = G.Player.takeDamage(player, dmg, shotDir);
      if (r.applied > 0) {
        result.hit = true; result.headshot = playerHit.zone === 'head'; result.damage = r.applied;
        G.Engine.blood(playerHit.point, shotDir, result.headshot);
        onPlayerHurt(r.applied, [-shotDir[0], -shotDir[1], -shotDir[2]]);
        if (result.headshot) onHitmarker(true, false);
        if (r.dead) onPlayerKilled();
      }
    } else if (mapHit.hit) {
      endPoint = mapHit.point;
      G.Engine.impact(mapHit.point, mapHit.normal, mapHit.material);
    } else {
      endPoint = [origin[0] + shotDir[0] * maxDist, origin[1] + shotDir[1] * maxDist, origin[2] + shotDir[2] * maxDist];
    }
    G.Engine.tracer(muzzle, endPoint, [1.0, 0.75, 0.35]);
    return result;
  }
  function botMuzzle(eye, dir) {
    return [eye[0] + dir[0] * 0.6, eye[1] + dir[1] * 0.6 - 0.05, eye[2] + dir[2] * 0.6];
  }

  /* ---------------- 击杀 / 重生 / 结算 ---------------- */
  function onBotKilled(headshot) {
    scoreP++; stats.kills++; stats.streak++;
    if (stats.streak > stats.bestStreak) stats.bestStreak = stats.streak;
    respawnB = RESPAWN_TIME;
    botDeathT = 0;
    G.Engine.deathBurst(bot.pos);
    killfeedAdd('你', WEAPON_NAMES[player.weaponId], 'BOT', headshot);
    showKillBanner(headshot ? '爆头击杀！' : '击杀！');
    audioCall('killConfirm');
    audioCall('death', [bot.pos[0], bot.pos[1] + 1.2, bot.pos[2]]);
    if (scoreP >= TARGET_KILLS) endMatch(true);
  }
  function onPlayerKilled() {
    scoreB++; stats.deaths++; stats.streak = 0;
    respawnP = RESPAWN_TIME;
    killfeedAdd('BOT', 'AK-47', '你', false);
    showCenterMsg('你被击杀了 · ' + RESPAWN_TIME.toFixed(0) + ' 秒后复活', 2.6, true);
    audioCall('death', eyeOf(player));
    if (scoreB >= TARGET_KILLS) endMatch(false);
  }

  function pickSpawnPair(enemyPos, forPlayer) {
    var pairs = (G.MAP && G.MAP.duelSpawns) || [];
    if (!pairs.length) return { player: { pos: [0, 0, 0], yaw: 0 }, bot: { pos: [0, 0, 5], yaw: 0 } };
    var bestPair = pairs[0], bestDist = -1;
    for (var i = 0; i < pairs.length; i++) {
      var sp = forPlayer ? pairs[i].player : pairs[i].bot;
      var d = M.v3.dist(sp.pos, enemyPos || [0, 0, 0]);
      if (d > bestDist) { bestDist = d; bestPair = pairs[i]; }
    }
    return bestPair;
  }

  function respawnPlayer() {
    var pair = pickSpawnPair(bot ? bot.pos : [0, 0, 0], true);
    G.Player.reset(player, pair.player);
    player.spawnProtection = SPAWN_PROTECT;
    respawnP = 0;
    audioCall('roundStart');
    showCenterMsg('复活 · 出生保护 1.5 秒', 1.5);
    ensureLock();
  }
  function respawnBot() {
    var pair = pickSpawnPair(player.pos, false);
    try { bot.reset(pair.bot, { difficulty: difficulty }); } catch (e) { /* ignore */ }
    botProtect = SPAWN_PROTECT;
    respawnB = 0;
    botDeathT = 0;
  }

  function endMatch(win) {
    if (state === 'results') return;
    state = 'results';
    if (document.exitPointerLock) { try { document.exitPointerLock(); } catch (e) { /* ignore */ } }
    input.fire = false;
    var b = bestFor(difficulty);
    if (win) { b.wins++; audioCall('matchWin'); } else { b.losses++; audioCall('matchLose'); }
    if (stats.kills > (b.bestKills || 0)) b.bestKills = stats.kills;
    if (stats.bestStreak > (b.bestStreak || 0)) b.bestStreak = stats.bestStreak;
    saveStorage();
    showResults(win);
  }

  function showResults(win) {
    showHud(false);
    showScreen('results');
    if (el['result-title']) {
      el['result-title'].textContent = win ? '胜利' : '失败';
      el.results.classList.toggle('lose', !win);
      el['result-title'].classList.toggle('lose', !win);
    }
    setText(el['result-score'], scoreP + ' : ' + scoreB);
    setText(el['stat-kills'], String(stats.kills));
    setText(el['stat-deaths'], String(stats.deaths));
    setText(el['stat-hs'], String(stats.headshots));
    var acc = stats.shots > 0 ? Math.round(stats.hits / stats.shots * 100) : 0;
    setText(el['stat-acc'], acc + '%');
    setText(el['stat-best'], String(stats.bestStreak));
    setText(el['stat-diff'], DIFF_LABEL[difficulty] || '普通');
    setText(el['btn-rematch'], '再来一局');
  }

  /* ---------------- 开局 / 返回菜单 ---------------- */
  function startMatch(diff) {
    if (!G.Engine || !G.MAP || !G.Bot || !G.Player || !G.Weapons) {
      G.showFatal && G.showFatal('游戏模块未完整加载，请刷新页面重试。');
      return;
    }
    difficulty = diff || selectedDiff || 'normal';
    selectedDiff = difficulty;
    scoreP = 0; scoreB = 0;
    stats = { shots: 0, hits: 0, headshots: 0, kills: 0, deaths: 0, streak: 0, bestStreak: 0 };
    respawnP = 0; respawnB = 0; botProtect = 0; botDeathT = 0;
    hitT = 0; damageT = 0; centerMsgT = 0; killBannerT = 0;
    if (el.killfeed) el.killfeed.innerHTML = '';
    if (!player) player = G.Player.create();
    var pair = pickSpawnPair([0, 0, 0], true);
    G.Player.reset(player, pair.player);
    player.spawnProtection = SPAWN_PROTECT;
    if (!bot || bot.difficulty !== difficulty) {
      try { bot = G.Bot.create(difficulty, {}); } catch (e) {
        G.showFatal && G.showFatal('AI 初始化失败: ' + (e && e.message ? e.message : e));
        return;
      }
    }
    try { bot.reset(pair.bot, { difficulty: difficulty }); } catch (e) { /* ignore */ }
    botProtect = SPAWN_PROTECT;
    botLastPos = [bot.pos[0], bot.pos[1], bot.pos[2]];
    botMovePhase = 0; botFootAccum = 0; botPrevReloading = false;
    state = 'playing';
    matchStart = realTime;
    showScreen(null);
    showHud(true);
    ensureAudio();
    audioCall('ambience', true);
    audioCall('roundStart');
    showCenterMsg('先到 ' + TARGET_KILLS + ' 杀获胜 · 目标：BOT', 2.6);
    updateHUD();
    ensureLock();
    input.fire = false; input.reloadPressed = false; input.scopePressed = false; input.switchTo = null;
    if (testPose) { setTimeout(function () { try { G.Test.poseDuel(8); } catch (e) { /* ignore */ } }, 100); }
  }

  function showMenu() {
    state = 'menu';
    showHud(false);
    showScreen('menu');
    if (document.exitPointerLock) { try { document.exitPointerLock(); } catch (e) { /* ignore */ } }
    selectedDiff = difficulty;
    updateDifficultyCards();
    renderBest();
    audioCall('ambience', true);
  }

  function updateDifficultyCards() {
    var cards = document.querySelectorAll('.diff-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle('selected', cards[i].getAttribute('data-difficulty') === selectedDiff);
    }
  }
  function renderBest() {
    var b = bestFor(selectedDiff);
    if (!el['menu-best']) return;
    var txt = '最佳战绩：' + (DIFF_LABEL[selectedDiff] || '普通') + ' · ' + b.wins + ' 胜 ' + b.losses + ' 负';
    if (b.bestKills) txt += ' · 最高 ' + b.bestKills + ' 杀';
    if (b.bestStreak) txt += ' · 最佳连杀 ' + b.bestStreak;
    el['menu-best'].textContent = txt;
  }

  /* ---------------- 暂停 / 恢复 ---------------- */
  function pauseGame(from) {
    if (state !== 'playing') return;
    pausedFromState = 'playing';
    state = 'paused';
    input.fire = false;
    input.forward = input.back = input.left = input.right = false;
    if (document.exitPointerLock) { try { document.exitPointerLock(); } catch (e) { /* ignore */ } }
    setText(el['pause-score-player'], String(scoreP));
    setText(el['pause-score-bot'], String(scoreB));
    showScreen('pause-menu');
    audioCall('uiClick');
  }
  function resumeGame() {
    if (state !== 'paused') return;
    state = 'playing';
    showScreen(null);
    ensureAudio();
    ensureLock();
  }

  function ensureLock() {
    if (testMode || freeze) return;
    if (state !== 'playing') return;
    if (document.pointerLockElement === canvas) return;
    try {
      if (canvas.requestPointerLock) canvas.requestPointerLock();
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 设置 ---------------- */
  function applySettingsUI() {
    if (el.sens) { el.sens.value = String(Math.round(settings.sens * 100)); }
    if (el['sens-value']) el['sens-value'].textContent = settings.sens.toFixed(2);
    if (el.vol) { el.vol.value = String(Math.round(settings.volume * 100)); }
    if (el['vol-value']) el['vol-value'].textContent = Math.round(settings.volume * 100) + '%';
    if (el['scale-options']) {
      var btns = el['scale-options'].querySelectorAll('.seg-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].getAttribute('data-scale') === String(settings.scale));
      }
    }
    if (el['crosshair-options']) {
      var cb = el['crosshair-options'].querySelectorAll('.seg-btn');
      for (var j = 0; j < cb.length; j++) {
        cb[j].classList.toggle('active', cb[j].getAttribute('data-color') === settings.crosshair);
      }
    }
    applyCrosshairColor();
    input.sens = settings.sens;
  }
  function applyCrosshairColor() {
    if (!el.crosshair) return;
    var colors = { green: '#6cff6c', cyan: '#5ee8ff', yellow: '#ffe14d', white: '#ffffff' };
    el.crosshair.style.setProperty('--ch-color', colors[settings.crosshair] || colors.green);
  }
  function applyVolume() {
    if (G.Audio && G.Audio.setVolume) { try { G.Audio.setVolume(settings.volume); } catch (e) { /* ignore */ } }
  }

  /* ---------------- 输入 ---------------- */
  function isLocked() { return document.pointerLockElement === canvas; }
  function canControl() { return state === 'playing' && (isLocked() || testMode); }

  function onKey(e, down) {
    var code = e.code || e.key;
    if (down) {
      if (state === 'playing') {
        if (code === 'KeyW' || code === 'ArrowUp') input.forward = true;
        else if (code === 'KeyS' || code === 'ArrowDown') input.back = true;
        else if (code === 'KeyA' || code === 'ArrowLeft') input.left = true;
        else if (code === 'KeyD' || code === 'ArrowRight') input.right = true;
        else if (code === 'Space') { input.jump = true; }
        else if (code === 'ShiftLeft' || code === 'ShiftRight') input.walk = true;
        else if (code === 'ControlLeft' || code === 'ControlRight' || code === 'KeyC') input.crouch = true;
        else if (code === 'KeyR' && !e.repeat) input.reloadPressed = true;
        else if (code === 'Digit1') input.switchTo = 'deagle';
        else if (code === 'Digit2') input.switchTo = 'awm';
        else if (code === 'Digit3') input.switchTo = 'ak47';
        else if (code === 'KeyM' && !e.repeat) { var muted = G.Audio && G.Audio.toggleMute ? G.Audio.toggleMute() : false; showCenterMsg(muted ? '已静音' : '声音已开启', 1.0); }
        else if (code === 'F3' && !e.repeat) { debugVisible = !debugVisible; }
        else if (code === 'Escape') { pauseGame(); }
      } else if (state === 'paused') {
        if (code === 'Escape') resumeGame();
      } else if (state === 'menu') {
        if (code === 'Enter' || code === 'NumpadEnter') { if (el['menu'] && !el['menu'].classList.contains('hidden')) startMatch(selectedDiff); }
        else if (code === 'Escape') { if (el.help && !el.help.classList.contains('hidden')) showScreen('menu'); else if (el.settings && !el.settings.classList.contains('hidden')) showScreen('menu'); }
      } else if (state === 'results') {
        if (code === 'Enter') startMatch(difficulty);
        else if (code === 'Escape') showMenu();
      }
      if (code === 'F5') { /* 允许刷新 */ }
    } else {
      if (code === 'KeyW' || code === 'ArrowUp') input.forward = false;
      else if (code === 'KeyS' || code === 'ArrowDown') input.back = false;
      else if (code === 'KeyA' || code === 'ArrowLeft') input.left = false;
      else if (code === 'KeyD' || code === 'ArrowRight') input.right = false;
      else if (code === 'Space') input.jump = false;
      else if (code === 'ShiftLeft' || code === 'ShiftRight') input.walk = false;
      else if (code === 'ControlLeft' || code === 'ControlRight' || code === 'KeyC') input.crouch = false;
    }
    if (state === 'playing' || state === 'paused') {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].indexOf(code) >= 0) e.preventDefault();
    }
  }

  function requestControl() {
    if (state === 'playing' && !isLocked() && !testMode) ensureLock();
  }

  function bindEvents() {
    window.addEventListener('keydown', function (e) { onKey(e, true); });
    window.addEventListener('keyup', function (e) { onKey(e, false); });
    window.addEventListener('blur', function () {
      input.forward = input.back = input.left = input.right = input.fire = false;
      input.jump = input.crouch = input.walk = false;
    });

    canvas.addEventListener('mousedown', function (e) {
      if (state !== 'playing') return;
      if (!isLocked() && !testMode) { ensureLock(); return; }
      if (e.button === 0) input.fire = true;
      else if (e.button === 2) input.scopePressed = true;
    });
    window.addEventListener('mouseup', function (e) {
      if (e.button === 0) input.fire = false;
    });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('mousemove', function (e) {
      if (!canControl()) return;
      if (!isLocked() && !testMode) return;
      input.mouseDX += e.movementX || 0;
      input.mouseDY += e.movementY || 0;
    });
    document.addEventListener('pointerlockchange', function () {
      if (state === 'playing' && !isLocked() && !testMode) {
        pauseGame();
      }
    });
    canvas.addEventListener('click', function () {
      if (state === 'playing' && !isLocked()) ensureLock();
    });

    // 主菜单
    if (el['btn-start']) el['btn-start'].addEventListener('click', function () {
      ensureAudio(); audioCall('uiClick'); startMatch(selectedDiff);
    });
    var cards = document.querySelectorAll('.diff-card');
    for (var i = 0; i < cards.length; i++) {
      (function (card) {
        card.addEventListener('click', function () {
          selectedDiff = card.getAttribute('data-difficulty') || 'normal';
          updateDifficultyCards();
          renderBest();
          ensureAudio(); audioCall('uiClick');
        });
        card.addEventListener('mouseenter', function () { audioCall('uiHover'); });
      })(cards[i]);
    }
    if (el['btn-help']) el['btn-help'].addEventListener('click', function () { ensureAudio(); audioCall('uiClick'); showScreen('help'); });
    if (el['btn-settings']) el['btn-settings'].addEventListener('click', function () { ensureAudio(); audioCall('uiClick'); settingsReturn = 'menu'; showScreen('settings'); });
    if (el['btn-help-back']) el['btn-help-back'].addEventListener('click', function () { audioCall('uiClick'); showScreen('menu'); });
    if (el['btn-settings-back']) el['btn-settings-back'].addEventListener('click', function () {
      audioCall('uiClick');
      showScreen(settingsReturn === 'pause' ? 'pause-menu' : 'menu');
    });

    // 暂停
    if (el['btn-resume']) el['btn-resume'].addEventListener('click', function () { audioCall('uiClick'); resumeGame(); });
    if (el['btn-restart']) el['btn-restart'].addEventListener('click', function () { audioCall('uiClick'); startMatch(difficulty); });
    if (el['btn-pause-settings']) el['btn-pause-settings'].addEventListener('click', function () { audioCall('uiClick'); settingsReturn = 'pause'; showScreen('settings'); });
    if (el['btn-pause-menu']) el['btn-pause-menu'].addEventListener('click', function () { audioCall('uiClick'); showMenu(); });

    // 结算
    if (el['btn-rematch']) el['btn-rematch'].addEventListener('click', function () { audioCall('uiClick'); startMatch(difficulty); });
    if (el['btn-change-diff']) el['btn-change-diff'].addEventListener('click', function () { audioCall('uiClick'); showMenu(); });
    if (el['btn-results-menu']) el['btn-results-menu'].addEventListener('click', function () { audioCall('uiClick'); showMenu(); });

    // 设置
    if (el.sens) el.sens.addEventListener('input', function () {
      settings.sens = M.clamp(parseFloat(el.sens.value) / 100, 0.1, 3);
      if (el['sens-value']) el['sens-value'].textContent = settings.sens.toFixed(2);
      input.sens = settings.sens;
      saveStorage();
    });
    if (el.vol) el.vol.addEventListener('input', function () {
      settings.volume = M.clamp(parseFloat(el.vol.value) / 100, 0, 1);
      if (el['vol-value']) el['vol-value'].textContent = Math.round(settings.volume * 100) + '%';
      applyVolume();
      saveStorage();
    });
    if (el['scale-options']) {
      var sb = el['scale-options'].querySelectorAll('.seg-btn');
      for (var s = 0; s < sb.length; s++) {
        (function (btn) {
          btn.addEventListener('click', function () {
            settings.scale = btn.getAttribute('data-scale');
            for (var k = 0; k < sb.length; k++) sb[k].classList.remove('active');
            btn.classList.add('active');
            if (settings.scale !== 'auto') G.Engine.setRenderScale(parseFloat(settings.scale));
            saveStorage();
            audioCall('uiClick');
          });
        })(sb[s]);
      }
    }
    if (el['crosshair-options']) {
      var cb = el['crosshair-options'].querySelectorAll('.seg-btn');
      for (var c = 0; c < cb.length; c++) {
        (function (btn) {
          btn.addEventListener('click', function () {
            settings.crosshair = btn.getAttribute('data-color');
            for (var k = 0; k < cb.length; k++) cb[k].classList.remove('active');
            btn.classList.add('active');
            applyCrosshairColor();
            saveStorage();
            audioCall('uiClick');
          });
        })(cb[c]);
      }
    }
    window.addEventListener('resize', function () { G.Engine.resize(); });
    window.addEventListener('beforeunload', function () { saveStorage(); });
  }

  /* ---------------- 每帧逻辑 ---------------- */
  function updatePlaying(dt) {
    if (state !== 'playing') return;
    if (freeze) { updateHUD(); return; }
    realTime += dt;
    var p = player;
    // 计时器
    if (hitT > 0) hitT = Math.max(0, hitT - dt);
    if (damageT > 0) damageT = Math.max(0, damageT - dt);
    if (centerMsgT > 0) centerMsgT = Math.max(0, centerMsgT - dt);
    if (killBannerT > 0) killBannerT = Math.max(0, killBannerT - dt);
    if (botProtect > 0) botProtect = Math.max(0, botProtect - dt);
    if (!p.alive) p.deathT += dt;

    // 玩家更新
    if (p.alive) {
      input.fire = !!input.fire;
      var events = G.Player.update(p, dt, input, { physics: G.Physics, engine: G.Engine });
      handlePlayerEvents(events);
    }
    // 输入边沿清空
    input.mouseDX = 0; input.mouseDY = 0;
    input.reloadPressed = false;
    input.scopePressed = false;
    input.switchTo = null;

    // 玩家重生
    if (!p.alive) {
      respawnP -= dt;
      if (respawnP <= 0 && state !== 'results') respawnPlayer();
    }
    // Bot
    soundThisFrame = false;
    if (bot) {
      if (bot.alive) {
        if (!botFrozen) {
          var ctx = makeBotCtx(dt);
          try { bot.update(dt, ctx); } catch (e) { console.error && console.error('Bot error', e); }
        }
        updateBotVisual(dt);
        updateBotAudio(dt);
      } else {
        botDeathT += dt;
        respawnB -= dt;
        if (respawnB <= 0 && state !== 'results') respawnBot();
      }
    }
    // 音效 listener
    if (G.Audio && G.Audio.updateListener) {
      try { G.Audio.updateListener(eyeOf(p), p.yaw, p.pitch); } catch (e) { /* ignore */ }
    }
    G.Engine.updateEffects(dt);
    updateHUD();
  }

  function handlePlayerEvents(events) {
    if (!events) return;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      switch (ev.type) {
        case 'fire': playerShoot(ev); break;
        case 'equip': audioCall('equip', ev.weaponId); break;
        case 'reloadStart':
          audioCall('reload', ev.weaponId, 'start');
          player.reloadStage = 0;
          break;
        case 'reloadEnd':
          audioCall('reload', ev.weaponId, 'end');
          break;
        case 'scopeIn': audioCall('scopeIn'); break;
        case 'scopeOut': audioCall('scopeOut'); break;
        case 'dryFire': audioCall('dryFire', ev.weaponId); break;
        case 'footstep': audioCall('footstep', ev.surface); break;
        case 'land': audioCall('land'); break;
        case 'jump': audioCall('jump'); break;
        case 'hurt': audioCall('hurt'); onPlayerHurt(ev.amount, ev.dir); break;
        case 'death': break;
        default: break;
      }
    }
    // 换弹阶段性音效
    if (player.reloading && player.reloadDur > 0) {
      var prog = player.reloadT / player.reloadDur;
      var stages = [0.12, 0.42, 0.72, 0.94];
      var names = ['magout', 'magin', 'bolt', 'end'];
      while (player.reloadStage < stages.length && prog >= stages[player.reloadStage]) {
        audioCall('reload', player.weaponId, names[player.reloadStage]);
        player.reloadStage++;
      }
    }
    // AWM 拉栓声
    if (events.length) {
      for (var k = 0; k < events.length; k++) {
        if (events[k].type === 'fire' && events[k].weaponId === 'awm') {
          (function () {
            setTimeout(function () { if (state === 'playing' || state === 'paused') audioCall('reload', 'awm', 'bolt'); }, 330);
          })();
        }
      }
    }
  }

  function updateBotVisual(dt) {
    if (!bot) return;
    var dx = bot.pos[0] - botLastPos[0], dz = bot.pos[2] - botLastPos[2];
    var moved = Math.sqrt(dx * dx + dz * dz);
    botMovePhase += moved * 4.2;
    bot.moving = moved > 0.012 && bot.alive;
    bot.movePhase = botMovePhase;
    if (typeof bot.crouch !== 'number') {
      bot.crouch = bot.crouching ? 1 : 0;
    }
    bot.deathT = bot.alive ? 0 : Math.min(1, botDeathT / 1.2);
    botLastPos[0] = bot.pos[0]; botLastPos[1] = bot.pos[1]; botLastPos[2] = bot.pos[2];
    bot.walkPhase = botMovePhase;
  }

  function updateBotAudio(dt) {
    if (!bot || !bot.alive) return;
    var moved = Math.sqrt(Math.pow(bot.pos[0] - (botLastPos ? 0 : 0), 2));
    // 用速度估算脚步
    var speed = bot.vel ? Math.sqrt(bot.vel[0] * bot.vel[0] + bot.vel[2] * bot.vel[2]) : 0;
    if (speed > 1.2 && bot.state !== 'dead') {
      botFootAccum += speed * dt;
      if (botFootAccum >= 1.9) {
        botFootAccum = 0;
        var eye = [bot.pos[0], bot.pos[1] + 1.2, bot.pos[2]];
        var hit = G.Engine.worldRaycast([bot.pos[0], bot.pos[1] + 0.4, bot.pos[2]], [0, -1, 0], 3);
        audioCall('footstep', hit && hit.hit ? surfaceFromMaterial(hit.material) : 'sand', eye);
      }
    } else {
      botFootAccum = Math.max(0, botFootAccum - dt * 0.5);
    }
    if (bot.reloading && !botPrevReloading) audioCall('reload', 'ak47', 'start', [bot.pos[0], bot.pos[1] + 1.2, bot.pos[2]]);
    if (!bot.reloading && botPrevReloading) audioCall('reload', 'ak47', 'end', [bot.pos[0], bot.pos[1] + 1.2, bot.pos[2]]);
    botPrevReloading = !!bot.reloading;
  }

  function makeBotCtx(dt) {
    var p = player;
    var pEye = eyeOf(p);
    var botEye = bot.eyePos ? bot.eyePos() : [bot.pos[0], bot.pos[1] + 1.65, bot.pos[2]];
    var dist = M.v3.dist(bot.pos, p.pos);
    return {
      dt: dt,
      time: realTime,
      map: G.MAP,
      physics: G.Physics,
      weapons: G.Weapons.defs,
      player: {
        pos: p.pos,
        vel: p.vel,
        eyePos: pEye,
        alive: p.alive,
        health: p.health,
        crouching: p.crouch > 0.5,
        scoped: p.scoped,
        weaponId: p.weaponId,
        reloading: p.reloading,
        visible: G.Engine.los(botEye, pEye),
        distance: dist,
        lastFireTime: lastPlayerShotAbs,
        spawnProtected: p.spawnProtection > 0
      },
      los: function (a, b) { return G.Engine.los(a, b); },
      moveActor: function (actor, dt2, wishDir, speed, opts2) {
        var w = wishDir;
        if (w && w.length === 2) w = [w[0], 0, w[1]];
        return G.Physics.moveActor(actor, dt2, w, speed, opts2);
      },
      botFire: function (dir, opts) { return botFire(dir, opts); },
      playSound: function (weaponId, pos) {
        soundThisFrame = true;
        audioCall('shot', weaponId, pos);
      },
      debug: debugVisible
    };
  }

  /* ---------------- 菜单镜头 ---------------- */
  function updateCinematic(dt) {
    cinematic.t += dt;
    var pairs = (G.MAP && G.MAP.duelSpawns) || [];
    var base = pairs.length ? pairs[0].player : { pos: [0, 0, 0], yaw: 0 };
    cinematic.eye[0] = base.pos[0];
    cinematic.eye[1] = base.pos[1] + 1.75;
    cinematic.eye[2] = base.pos[2];
    cinematic.yaw = base.yaw + Math.sin(cinematic.t * 0.16) * 0.35;
  }

  /* ---------------- 渲染 ---------------- */
  function render(dt) {
    var E = G.Engine;
    if (!E || !E.camera) return;
    if (state === 'menu') {
      updateCinematic(dt);
      E.setCamera(cinematic.eye, cinematic.yaw, -0.03, 90);
      E.beginFrame();
      E.drawMap();
      E.renderEffects();
      return;
    }
    var p = player;
    if (!p) return;
    var eye = eyeOf(p);
    var yaw = p.yaw + p.viewRecoilYaw;
    var pitch = p.pitch + p.viewRecoilPitch;
    var fov = 90;
    var def = p.weapon;
    if (def && def.scope) fov = M.lerp(90, def.zoomFov, p.scopeT);
    if (!p.alive) {
      var t = Math.min(1, p.deathT / 0.9);
      eye[1] = p.pos[1] + M.lerp(1.65, 0.35, t);
      pitch = p.pitch - t * 0.9;
      yaw = p.yaw + t * 0.3;
    } else {
      var right = M.rightFrom(p.yaw, [0, 0, 0]);
      eye[0] += right[0] * p.bobX;
      eye[2] += right[2] * p.bobX;
      eye[1] += p.bobY - p.viewDip;
      if (p.scoped) eye[1] += 0.04;
    }
    camera.eye[0] = eye[0]; camera.eye[1] = eye[1]; camera.eye[2] = eye[2];
    camera.yaw = yaw; camera.pitch = pitch;
    E.setCamera(eye, yaw, pitch, fov);
    E.beginFrame();
    E.drawMap();
    if (bot) {
      var drawBot = bot.alive || botDeathT < 3.2;
      if (drawBot) {
        E.drawActor({
          pos: bot.pos, yaw: bot.yaw, pitch: bot.pitch,
          crouch: typeof bot.crouch === 'number' ? bot.crouch : (bot.crouching ? 1 : 0),
          deathT: bot.alive ? 0 : Math.min(1, botDeathT / 1.2),
          movePhase: botMovePhase || 0, moving: !!bot.moving, alive: bot.alive
        });
        var gy = E.groundHeightAt(bot.pos[0], bot.pos[2], bot.pos[1] + 2);
        E.drawShadow(bot.pos[0], bot.pos[2], gy, 0.42, 1);
      }
    }
    if (p.alive) {
      var gy2 = E.groundHeightAt(p.pos[0], p.pos[2], p.pos[1] + 2);
      E.drawShadow(p.pos[0], p.pos[2], gy2, 0.4, 0.8);
    }
    E.renderEffects();
    if (p.alive && state !== 'results') {
      var vm = {
        weaponId: p.weaponId,
        scoped: p.scoped && p.scopeT > 0.75,
        equipT: p.equipT,
        reloadT: p.reloading ? p.reloadT / p.reloadDur : -1,
        kickPitch: p.recoilKickPitch / M.DEG * 0.8,
        kickYaw: p.recoilKickYaw / M.DEG * 0.8,
        kickBack: p.recoilKickBack,
        swayX: p.swayX, swayY: p.swayY,
        bobX: p.bobX * 90, bobY: p.bobY * 90,
        boltT: p.boltT,
        flashT: (p.lastShotTime >= 0 && p.lastShotTime < 0.085 && p.equipT > 0.95) ? 1 : 0
      };
      E.renderViewmodel(vm, dt);
    }
  }

  /* ---------------- 主循环入口 ---------------- */
  function tick(dt) {
    if (!dt || dt <= 0) dt = 1 / 60;
    if (state === 'menu') {
      passMenuFrame(dt);
    } else if (state === 'playing') {
      updatePlaying(dt);
    } else {
      if (hitT > 0) hitT = Math.max(0, hitT - dt);
      if (damageT > 0) damageT = Math.max(0, damageT - dt);
      updateHUD();
    }
    // FPS / 自动分辨率
    fpsAccum += dt; fpsFrames++;
    if (fpsAccum >= 0.5) {
      fpsShown = fpsFrames / fpsAccum;
      fpsAccum = 0; fpsFrames = 0;
      updateHUD();
      if (settings.scale === 'auto' && state === 'playing') {
        if (fpsShown < 48 && currentScale > 0.55) {
          currentScale = Math.max(0.55, currentScale - 0.06);
          G.Engine.setRenderScale(currentScale);
        } else if (fpsShown > 58 && currentScale < 0.9) {
          currentScale = Math.min(0.9, currentScale + 0.02);
          G.Engine.setRenderScale(currentScale);
        }
      }
    }
  }

  function frame(dt) {
    if (!dt || dt <= 0) dt = 1 / 60;
    now += dt;
    if (!manual) tick(dt);
    render(dt);
    if (testMode && !window.__QA_DONE__) {
      if (!frame._t) frame._t = 0;
      frame._t += dt;
      if (frame._t > 0.25) {
        frame._t = 0;
        document.title = 'GAME state=' + state + ' p=' + scoreP + ' b=' + scoreB +
          ' php=' + (player ? Math.round(player.health) : '-') +
          ' bhp=' + (bot ? Math.round(bot.health) + '/' + bot.state : '-') +
          ' err=' + (window.__GAME_ERROR__ ? 'YES' : 'no') +
          ' calls=' + (G.Engine ? G.Engine.stats.drawCalls : 0);
      }
    }
  }
  function passMenuFrame(dt) {
    if (G.Audio && G.Audio.updateListener) {
      try { G.Audio.updateListener([cinematic.eye[0], cinematic.eye[1], cinematic.eye[2]], cinematic.yaw, 0); } catch (e) { /* ignore */ }
    }
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    canvas = document.getElementById('game-canvas');
    cacheEls();
    loadingText = document.getElementById('loading-text');
    loadStorage();
    input.sens = settings.sens;
    G.Engine.setRenderScale(settings.scale === 'auto' ? 0.8 : parseFloat(settings.scale) || 0.8);
    currentScale = settings.scale === 'auto' ? 0.8 : (parseFloat(settings.scale) || 0.8);
    player = G.Player.create();
    bindEvents();
    applySettingsUI();
    if (el['armor-box']) el['armor-box'].style.display = 'none';
    if (el['scope-overlay']) el['scope-overlay'].classList.add('hidden');
    if (el.debug) el.debug.classList.remove('hidden');
    showMenu();
    showLoading(false);
    // 测试模式
    var q = null;
    try { q = new URLSearchParams(window.location.search); } catch (e) { q = null; }
    if (q) {
      if (q.get('debug') === '1') debugVisible = true;
      if (q.get('test') === '1') {
        testMode = true;
        freeze = q.get('freeze') !== '0';
        G.Test = makeTestApi();
        var diff = q.get('diff');
        if (!DIFF_LABEL[diff]) diff = 'normal';
        testPose = q.get('pose') === '1';
        setTimeout(function () {
          try { startMatch(diff); } catch (e) {
            window.__GAME_ERROR__ = 'test start: ' + (e && e.message ? e.message : e);
            G.showFatal(window.__GAME_ERROR__);
          }
        }, 60);
        var extraScript = q.get('script');
        if (extraScript) {
          var sc = document.createElement('script');
          sc.src = extraScript;
          sc.onerror = function () { window.__TEST_SCRIPT_ERROR__ = 'script load failed: ' + extraScript; };
          document.body.appendChild(sc);
        }
      } else if (q.get('debug') === '1') {
        debugVisible = true;
      }
    }
    return true;
  }
  function makeTestApi() {
    return {
      start: function (d) { startMatch(d || 'normal'); },
      setInput: function (o) {
        for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) input[k] = o[k]; }
      },
      clearInput: function () {
        input.forward = input.back = input.left = input.right = false;
        input.fire = false; input.jump = false; input.crouch = false; input.walk = false;
        input.reloadPressed = false; input.scopePressed = false; input.switchTo = null;
        input.mouseDX = 0; input.mouseDY = 0;
      },
      setFreeze: function (v) { freeze = !!v; },
      setManual: function (v) { manual = !!v; },
      step: function (dt) { tick(dt || 1 / 60); },
      isLocked: function () { return isLocked(); },
      getBotDebug: function () {
        try { return bot && typeof bot.getDebugInfo === 'function' ? bot.getDebugInfo() : null; } catch (e) { return null; }
      },
      getPlayer: function () { return player; },
      getBot: function () { return bot; },
      setPlayerInvuln: function (v) { if (player) player.spawnProtection = v ? 9999 : 0; },
      setBotFrozen: function (v) { botFrozen = !!v; },
      setBotProtected: function (v) { botProtect = v ? 9999 : 0; },
      getState: function () {
        return {
          state: state, difficulty: difficulty, scoreP: scoreP, scoreB: scoreB,
          player: player ? {
            pos: player.pos.slice(), health: player.health, alive: player.alive,
            weaponId: player.weaponId, ammo: player.ammoStates[player.weaponId].ammo,
            scoped: player.scoped, reloading: player.reloading
          } : null,
          bot: bot ? {
            pos: bot.pos.slice(), health: bot.health, alive: bot.alive,
            state: bot.state, weaponId: bot.weaponId, ammo: bot.ammo
          } : null,
          stats: JSON.parse(JSON.stringify(stats)),
          error: window.__GAME_ERROR__ || null
        };
      },
      teleportPlayer: function (pos, yaw) {
        G.Physics.teleport(player.actor, pos);
        player.pos = player.actor.pos;
        player.vel = player.actor.vel;
        player.yaw = yaw === undefined ? player.yaw : yaw;
        player.viewRecoilPitch = 0; player.viewRecoilYaw = 0;
      },
      setView: function (yaw, pitch) {
        if (yaw !== undefined) player.yaw = yaw;
        if (pitch !== undefined) player.pitch = M.clamp(pitch, -1.5, 1.5);
        player.viewRecoilPitch = 0;
        player.viewRecoilYaw = 0;
      },
      setBotPos: function (pos, yaw) {
        if (!bot) return;
        bot.pos[0] = pos[0]; bot.pos[1] = pos[1]; bot.pos[2] = pos[2];
        if (yaw !== undefined) bot.yaw = yaw;
        bot.vel = [0, 0, 0];
        botLastPos = [bot.pos[0], bot.pos[1], bot.pos[2]];
      },
      poseDuel: function (dist) {
        if (!player || !bot) return;
        dist = dist || 8;
        var pair = pickSpawnPair([0, 0, 0], true);
        var pos = pair.player.pos;
        G.Physics.teleport(player.actor, pos);
        player.yaw = pair.player.yaw;
        player.pitch = 0;
        player.viewRecoilPitch = 0; player.viewRecoilYaw = 0;
        var f = M.forwardFrom(player.yaw, 0, [0, 0, 0]);
        bot.pos[0] = pos[0] + f[0] * dist;
        bot.pos[2] = pos[2] + f[2] * dist;
        bot.pos[1] = G.Engine.groundHeightAt(bot.pos[0], bot.pos[2], 6);
        bot.yaw = M.wrapAngle(player.yaw + Math.PI);
        bot.pitch = 0;
        bot.vel = [0, 0, 0];
        botLastPos = [bot.pos[0], bot.pos[1], bot.pos[2]];
      },
      damageBot: function (n) {
        if (bot && bot.alive) { var r = bot.takeDamage(n || 40, 'body'); if (r.dead) onBotKilled(false); }
      },
      killBot: function () {
        if (bot && bot.alive) { var r = bot.takeDamage(1000, 'head'); if (r.dead) onBotKilled(true); }
      },
      damagePlayer: function (n) {
        var r = G.Player.takeDamage(player, n || 20, [0, 0, 1]);
        if (r.dead) onPlayerKilled();
        return r;
      },
      fire: function () { input.fire = true; },
      stopFire: function () { input.fire = false; },
      scope: function () { input.scopePressed = true; },
      switchTo: function (id) { input.switchTo = id; },
      reload: function () { input.reloadPressed = true; },
      renderScale: function () { return currentScale; }
    };
  }

  G.Game = {
    init: init,
    frame: frame,
    startMatch: startMatch,
    showMenu: showMenu,
    getState: function () { return state; },
    getPlayer: function () { return player; },
    getBot: function () { return bot; },
    isTest: function () { return testMode; }
  };
})();
