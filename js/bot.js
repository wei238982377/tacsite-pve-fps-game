/*!
 * AI GAME / 沙漠对决 — AI 对手模块
 * GAME.Bot：三难度 CS2 风格 1v1 Bot（AK-47）
 *
 * 契约：fps/docs/interfaces.md 5.5
 *  - 纯逻辑模块：不访问 DOM / WebGL，不依赖其它模块（只通过 update(dt, ctx) 注入的数据工作）
 *  - 普通 script + IIFE 挂到 window.GAME.Bot，加载顺序无关
 *  - bot 本身就是物理 actor（radius/height/crouch/onGround/eyeHeight），移动统一走 ctx.moveActor
 *  - 感知只依赖 ctx.map / ctx.player / ctx.los / onHearShot，不做全知
 *
 * 结构：
 *   DIFFICULTIES  三难度集中参数（按文档 5.5 表格）
 *   Bot           状态机 patrol / engage / reposition / reload / retreat / dead
 *                   导航：waypoint 图 + A* + 路径缓存 + 单次平滑 + 卡墙脱困
 *                   瞄准：限速转向 + 每发高斯误差 + 移动/后坐误差 + 点射节奏 + 困难提前量
 *                   武器：自行管理 ammo / rpm / 换弹计时，扣扳机时回调 ctx.botFire(aimDir, opts)
 */
(function () {
  'use strict';

  var GAME = window.GAME = window.GAME || {};

  /* ======================================================================
   * 常量与数学工具
   * ==================================================================== */

  var PI = Math.PI;
  var TAU = PI * 2;
  var DEG = PI / 180;

  var STAND_HEIGHT = 1.8;      // 站立高（米）
  var CROUCH_HEIGHT = 1.15;    // 下蹲高
  var STAND_EYE = 1.65;        // 站立眼高
  var CROUCH_EYE = 1.15;       // 下蹲眼高
  var ACTOR_RADIUS = 0.34;     // 碰撞半径

  // 未加载 weapons.js 时的兜底数据（与文档 5.2 ak47 保持一致）
  var AK_FALLBACK = {
    id: 'ak47', mag: 30, rpm: 600, reloadTime: 2.45, range: 90,
    damage: { body: 33, head: 110, legs: 26 }
  };

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function randRange(a, b) { return a + Math.random() * (b - a); }
  function randSym(a) { return (Math.random() * 2 - 1) * a; }
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function signOf(v) { return v < 0 ? -1 : 1; }

  // Box-Muller 高斯随机数：每发子弹的随机偏移
  var _gaussSpare = null;
  function gaussRand() {
    if (_gaussSpare !== null) { var s = _gaussSpare; _gaussSpare = null; return s; }
    var u = Math.random();
    if (u < 1e-12) u = 1e-12;
    var v = Math.random();
    var mag = Math.sqrt(-2 * Math.log(u));
    _gaussSpare = mag * Math.sin(TAU * v);
    return mag * Math.cos(TAU * v);
  }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isVec3(v) { return !!v && isNum(v[0]) && isNum(v[1]) && isNum(v[2]); }

  function angleWrap(a) {
    if (!isNum(a)) return 0;
    a = a % TAU;
    if (a > PI) a -= TAU;
    else if (a < -PI) a += TAU;
    return a;
  }
  function angleDelta(from, to) { return angleWrap(to - from); }

  function hypot2(x, z) { return Math.sqrt(x * x + z * z); }
  function distXZ(a, b) { return hypot2(a[0] - b[0], a[2] - b[2]); }
  function dist3(a, b) {
    var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  function copyArr3(a, fallback) {
    if (isVec3(a)) return [a[0], a[1], a[2]];
    if (fallback) return [fallback[0], fallback[1], fallback[2]];
    return [0, 0, 0];
  }

  // yaw 约定：yaw=0 面向 -Z；forward = [-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)]
  function yawTo(from, to) { return Math.atan2(-(to[0] - from[0]), -(to[2] - from[2])); }
  function pitchTo(from, to) {
    var dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    return Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
  }
  function dirFromAngles(yaw, pitch, out) {
    var cp = Math.cos(pitch);
    out[0] = -Math.sin(yaw) * cp;
    out[1] = Math.sin(pitch);
    out[2] = -Math.cos(yaw) * cp;
    return out;
  }
  function normalize2(x, z) {
    var l = hypot2(x, z);
    if (l < 1e-8) return [0, 0];
    return [x / l, z / l];
  }

  // 玩家 eyePos 可能是函数（对象方法）也可能是 [x,y,z]
  function readPlayerEye(player, fallbackH) {
    var e = player && player.eyePos;
    if (typeof e === 'function') {
      try { e = e.call(player); } catch (err) { e = null; }
    }
    if (isVec3(e)) return [e[0], e[1], e[2]];
    var p = player && player.pos;
    if (isVec3(p)) return [p[0], p[1] + fallbackH, p[2]];
    return null;
  }

  // ctx.los 安全包装：异常/缺失时不抛错。真正的游戏里 ctx.los 一定存在。
  function safeLos(ctx, a, b) {
    if (!isVec3(a) || !isVec3(b)) return false;
    try {
      if (ctx && typeof ctx.los === 'function') return !!ctx.los(a, b);
      var ph = ctx && ctx.physics;
      if (ph && typeof ph.segmentBlocked === 'function') return !ph.segmentBlocked(a, b);
    } catch (err) { /* ignore */ }
    return true;
  }

  /* ======================================================================
   * 三难度参数（文档 5.5 表格为核心，其余为手感微调）
   * 所有数值集中在这里，便于联调。
   * ==================================================================== */

  var DIFFICULTIES = {
    easy: {
      id: 'easy', label: '简单', enName: 'RECRUIT',
      // —— 文档 5.5 表格 ——
      reactionMin: 0.55, reactionMax: 0.75,   // 反应时间 s
      aimBaseError: 5.5,                      // 瞄准基础误差 deg
      aimMoveError: 3.0,                      // 移动中额外误差 deg
      turnSpeed: 120, pitchSpeed: 80,         // 转向速度 deg/s
      errorConverge: 0.8,                     // 误差收敛（1/s，越大越快）
      burstMin: 2, burstMax: 4,               // 每轮点射发数
      burstIntervalMin: 0.55, burstIntervalMax: 0.95, // 点射间隔 s
      headshotBias: 0.08,                     // 瞄准头部倾向
      strafeChance: 0.3,                      // 横移频率
      strafeIntervalMin: 0.85, strafeIntervalMax: 1.6,
      coverChance: 0.2,                       // 使用掩体概率
      crouchChance: 0.05,                     // 蹲射概率
      preAim: 0.0,                            // 预瞄常见角度（0~1）
      hearingRange: 14,                       // 听声范围 m
      viewRange: 28,                          // 视野范围 m
      retreatHealth: 20,                      // 低血量撤退阈值
      // —— 手感微调 ——
      combatMoveSpeed: 2.6,
      leadFactor: 0.0,                        // 提前量预测（简单不预判）
      dodgeChance: 0.15,                      // 每秒反转变向概率
      stopChance: 0.1,                        // 点射时急停概率
      crouchDurationMin: 0.8, crouchDurationMax: 1.6,
      settleFrom: 1.25,                       // 发现目标瞬间的误差倍率
      shotSpread: 1.2,                        // 连发散布 σ deg
      burstGrowth: 0.3,                       // 连发累计散布系数
      recoilKick: 0.85, recoilRecover: 1.1,   // 连发后坐误差累计/恢复
      aimWander: 20,                          // 持续性瞄准偏差漂移 deg/s
      aimSigmaFactor: 0.75,                   // 每发随机误差 σ 系数（相对 aimBaseError）
      fireAngleGate: 12,                      // 允许开火的最大瞄准偏差 deg
      reactionRefresh: 0.92,                  // 已警戒时再次发现目标的反应倍率
      hearError: 7.0,                         // 听声定位误差 m
      memoryDuration: 4.0,                    // 看到目标后的记忆时间
      searchDuration: 5.0,                    // 最后已知点搜索时间
      preAimRemember: 0,                      // 预瞄记忆时间
      preferredMin: 8, preferredMax: 30,      // 交战距离偏好
      pressAggression: 0,                     // 主动压迫
      fovDeg: 110
    },
    normal: {
      id: 'normal', label: '普通', enName: 'VETERAN',
      reactionMin: 0.30, reactionMax: 0.42,
      aimBaseError: 2.6,
      aimMoveError: 1.6,
      turnSpeed: 260, pitchSpeed: 180,
      errorConverge: 1.7,
      burstMin: 3, burstMax: 6,
      burstIntervalMin: 0.30, burstIntervalMax: 0.55,
      headshotBias: 0.22,
      strafeChance: 0.55,
      strafeIntervalMin: 0.5, strafeIntervalMax: 1.1,
      coverChance: 0.55,
      crouchChance: 0.15,
      preAim: 0.4,
      hearingRange: 22,
      viewRange: 40,
      retreatHealth: 30,
      combatMoveSpeed: 3.6,
      leadFactor: 0.35,                       // 偶尔做提前量预测
      dodgeChance: 0.6,
      stopChance: 0.55,
      crouchDurationMin: 0.7, crouchDurationMax: 1.4,
      settleFrom: 1.15,
      shotSpread: 0.6,
      burstGrowth: 0.15,
      recoilKick: 0.5, recoilRecover: 2.2,
      aimWander: 32,
      aimSigmaFactor: 0.68,
      fireAngleGate: 8,
      reactionRefresh: 0.92,
      hearError: 3.5,
      memoryDuration: 6.5,
      searchDuration: 8.0,
      preAimRemember: 3.5,
      preferredMin: 7, preferredMax: 27,
      pressAggression: 0.45,
      fovDeg: 110
    },
    hard: {
      id: 'hard', label: '困难', enName: 'EXPERT',
      reactionMin: 0.14, reactionMax: 0.22,
      aimBaseError: 1.0,
      aimMoveError: 0.7,
      turnSpeed: 420, pitchSpeed: 300,
      errorConverge: 3.2,
      burstMin: 4, burstMax: 8,
      burstIntervalMin: 0.16, burstIntervalMax: 0.30,
      headshotBias: 0.40,
      strafeChance: 0.85,
      strafeIntervalMin: 0.35, strafeIntervalMax: 0.75,
      coverChance: 0.8,
      crouchChance: 0.30,
      preAim: 1.0,
      hearingRange: 30,
      viewRange: 55,
      retreatHealth: 35,
      combatMoveSpeed: 4.6,
      leadFactor: 0.9,                        // 困难：按玩家速度做提前量预测
      dodgeChance: 1.6,
      stopChance: 0.95,
      crouchDurationMin: 0.6, crouchDurationMax: 1.2,
      settleFrom: 1.08,
      shotSpread: 0.32,
      burstGrowth: 0.07,
      recoilKick: 0.15, recoilRecover: 4.5,
      aimWander: 55,
      aimSigmaFactor: 0.80,
      fireAngleGate: 5,
      reactionRefresh: 0.92,
      hearError: 1.2,
      memoryDuration: 9.0,
      searchDuration: 10.0,
      preAimRemember: 8.0,
      preferredMin: 6, preferredMax: 22,
      pressAggression: 1.0,
      fovDeg: 110
    }
  };

  var DIFF_IDS = ['easy', 'normal', 'hard'];

  /* ======================================================================
   * Bot 构造
   * ==================================================================== */

  function Bot(difficultyId, opts) {
    opts = opts || {};
    var id = DIFF_IDS.indexOf(difficultyId) >= 0 ? difficultyId : 'normal';
    var D = DIFFICULTIES[id];

    this.difficulty = id;
    this._diff = D;
    this.name = (typeof opts.name === 'string' && opts.name) ? opts.name : 'BOT';

    // —— 契约字段（game / render 读取）——
    this.pos = isVec3(opts.pos) ? [opts.pos[0], opts.pos[1], opts.pos[2]] : [0, 0, 0];
    this.vel = [0, 0, 0];
    this.yaw = isNum(opts.yaw) ? opts.yaw : 0;
    this.pitch = 0;
    this.health = 100;
    this.alive = true;
    this.weaponId = 'ak47';
    this.ammo = AK_FALLBACK.mag;
    this.reserveAmmo = 9999;        // AI 后备弹无限（只影响 AI；HUD 不显示）
    this.reloading = false;
    this.reloadTimer = 0;
    this.state = 'idle';
    this.aimPoint = [this.pos[0], this.pos[1] + 1.2, this.pos[2] - 8];

    // —— 物理 actor 字段（作为 this 传给 ctx.moveActor）——
    this.height = STAND_HEIGHT;
    this.radius = ACTOR_RADIUS;
    this.crouch = 0;            // 与 GAME.Physics 一致：0~1 数值（平滑下蹲）
    this.onGround = true;
    this.eyeHeight = STAND_EYE;
    this._crouchWant = false;

    this._wdef = AK_FALLBACK;
    this._initInternal(opts);
  }

  /* ---------------------------------------------------------------- 内部状态 */

  Bot.prototype._initInternal = function (opts) {
    opts = opts || {};
    var now = 0;

    this._time = 0;
    this._spawnPos = isVec3(opts.pos) ? [opts.pos[0], opts.pos[1], opts.pos[2]] : [this.pos[0], this.pos[1], this.pos[2]];

    // 导航
    this._mapRef = null;
    this._graph = null;
    this._path = null;
    this._pathIdx = 0;
    this._pathGoal = -1;
    this._pathTime = -99;
    this._pathFailGoal = -1;
    this._pathFailUntil = 0;
    this._patrolGoal = null;
    this._patrolPauseUntil = 0;
    this._lastPatrolNode = -1;
    this._nearestCache = -1;
    this._nearestCacheTime = -99;

    // 感知 / 目标
    this._visibleNow = false;
    this._wasVisible = false;
    this._lastKnownPos = null;
    this._lastKnownTime = -99;
    this._lastKnownFromSound = false;
    this._alertLevel = 0;
    this._hearReactTimer = 0;
    this._lastHearTime = -99;
    this._hearEverCalled = false;
    this._playerFireSeen = null;
    this._searchLookUntil = 0;

    // 反应
    this._reacting = false;
    this._reactionTimer = 0;

    // 瞄准
    this._aimHigh = false;
    this._aimErrMag = 0;
    this._aimErrAng = 0;
    this._settle = 1;
    this._recoilErr = 0;
    this._desiredYaw = this.yaw;
    this._desiredPitch = 0;
    this._aimTargetPoint = null;

    // 开火
    this._fireNextTime = 0;
    this._burstLeft = 0;
    this._burstShotIndex = 0;
    this._burstPauseUntil = 0;
    this._stopUntil = 0;
    this._shots = 0;
    this._hits = 0;
    this._reloads = 0;
    this._reloadCoverTried = false;
    this._reloadCoverArrived = false;
    this._lastReloadTime = -99;

    // 移动 / 走位
    this._strafeDir = 0;
    this._strafeUntil = 0;
    this._crouchUntil = 0;
    this._crouchCheckAt = 0;
    this._speedNow = 0;
    this._wantJump = false;
    this._jumpCooldownUntil = 0;
    this._stuckTimer = 0;
    this._stuckCount = 0;
    this._stuckEscapeUntil = 0;
    this._stuckEscapeDir = [0, 0];

    // 撤退
    this._retreating = false;
    this._retreatStart = 0;
    this._retreatArrived = false;
    this._retreatCooldownUntil = 0;
    this._lastDamageTime = -99;
    this._coverTarget = null;

    // 巡逻视野
    this._scanPhase = Math.random() * TAU;
    this._preAimActive = false;
    this._preAimCheckTimer = 0;

    // 调试
    this._errorCount = 0;
    this._lastError = null;
    this._lastPlayerDist = 0;

    this._time = now;
  };

  /* ======================================================================
   * 契约方法
   * ==================================================================== */

  Bot.prototype.eyePos = function () {
    // 眼高由物理层维护（GAME.Physics 下蹲 1.65→1.15 平滑过渡，站立 1.65）。
    // 极端情况下用本模块的站立/下蹲意图兜底，保证永远返回合法值。
    var eh = this.eyeHeight;
    if (!isNum(eh) || eh < 1.0 || eh > 1.8) {
      eh = (isNum(this.crouch) ? this.crouch > 0.5 : !!this.crouch) ? CROUCH_EYE : STAND_EYE;
    }
    return [this.pos[0], this.pos[1] + eh, this.pos[2]];
  };

  Bot.prototype.reset = function (spawn, opts) {
    opts = opts || {};
    spawn = spawn || {};
    var p = spawn.pos || opts.pos || this._spawnPos || this.pos;
    p = copyArr3(p, [0, 0, 0]);

    this.pos = [p[0], p[1], p[2]];
    this._spawnPos = [p[0], p[1], p[2]];
    this.vel = [0, 0, 0];
    this.yaw = isNum(spawn.yaw) ? spawn.yaw : (isNum(opts.yaw) ? opts.yaw : 0);
    this.pitch = 0;
    this.health = isNum(opts.health) ? opts.health : 100;
    this.alive = true;
    this.weaponId = 'ak47';
    this._wdef = (opts.weapon && typeof opts.weapon === 'object') ? opts.weapon : this._wdef;
    this.ammo = (this._wdef && this._wdef.mag) || AK_FALLBACK.mag;
    this.reserveAmmo = 9999;
    this.reloading = false;
    this.reloadTimer = 0;
    this.state = 'patrol';
    this.crouch = 0;
    this._crouchWant = false;
    this.height = STAND_HEIGHT;
    this.radius = ACTOR_RADIUS;
    this.onGround = true;
    this.eyeHeight = STAND_EYE;
    this.aimPoint = [p[0], p[1] + 1.2, p[2] - 6];

    // 清内部状态（保留 waypoint 图缓存：同一张地图可以复用）
    this._time = 0;
    this._path = null;
    this._pathIdx = 0;
    this._pathGoal = -1;
    this._pathTime = -99;
    this._pathFailGoal = -1;
    this._pathFailUntil = 0;
    this._patrolGoal = null;
    this._patrolPauseUntil = 0;
    this._visibleNow = false;
    this._wasVisible = false;
    this._lastKnownPos = null;
    this._lastKnownTime = -99;
    this._lastKnownFromSound = false;
    this._alertLevel = 0;
    this._hearReactTimer = 0;
    this._lastHearTime = -99;
    this._playerFireSeen = null;
    this._searchLookUntil = 0;
    this._reacting = false;
    this._reactionTimer = 0;
    this._aimHigh = false;
    this._aimErrMag = 0;
    this._aimErrAng = 0;
    this._settle = 1;
    this._recoilErr = 0;
    this._desiredYaw = this.yaw;
    this._desiredPitch = 0;
    this._aimTargetPoint = null;
    this._fireNextTime = 0;
    this._burstLeft = 0;
    this._burstShotIndex = 0;
    this._burstPauseUntil = 0;
    this._stopUntil = 0;
    this._reloadCoverTried = false;
    this._reloadCoverArrived = false;
    this._lastReloadTime = -99;
    this._strafeDir = 0;
    this._strafeUntil = 0;
    this._crouchUntil = 0;
    this._crouchCheckAt = 0;
    this._speedNow = 0;
    this._wantJump = false;
    this._jumpCooldownUntil = 0;
    this._stuckTimer = 0;
    this._stuckEscapeUntil = 0;
    this._retreating = false;
    this._retreatArrived = false;
    this._retreatCooldownUntil = 0;
    this._lastDamageTime = -99;
    this._coverTarget = null;
    this._scanPhase = Math.random() * TAU;
    this._preAimActive = false;
    this._preAimCheckTimer = 0;
    this._lastPlayerDist = 0;
    this._lastError = null;
    this._errorCount = 0;
  };

  Bot.prototype.takeDamage = function (amount, zone) {
    var dmg = Number(amount);
    if (!isNum(dmg) || dmg < 0) dmg = 0;
    if (!this.alive) return { dead: true, health: 0 };

    this.health -= dmg;
    this._lastDamageTime = this._time;
    this._alertLevel = 2;

    // 受击抖动：头部受击更明显；简单难度更慌
    var flinch = (zone === 'head' ? 2.4 : 1.1) * (this._diff.id === 'easy' ? 1.5 : 1);
    this._aimErrMag = Math.min(this._aimErrMag + flinch, 26);
    this._settle = Math.max(this._settle, 1.2);

    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.state = 'dead';
      this.reloading = false;
      this.reloadTimer = 0;
      this._burstLeft = 0;
      this._retreating = false;
      return { dead: true, health: 0 };
    }
    return { dead: false, health: this.health };
  };

  Bot.prototype.onHearShot = function (pos) {
    if (!this.alive) return;
    if (!isVec3(pos)) return;
    this._hearEverCalled = true;
    var d = distXZ(this.pos, pos);
    if (!isNum(d) || d > this._diff.hearingRange) return;
    this._hear(copyArr3(pos, null), d, 1.0);
  };

  Bot.prototype.getDebugInfo = function () {
    return {
      difficulty: this.difficulty,
      state: this.state,
      pos: [this.pos[0], this.pos[1], this.pos[2]],
      vel: [this.vel[0], this.vel[1], this.vel[2]],
      yaw: this.yaw,
      pitch: this.pitch,
      health: this.health,
      ammo: this.ammo,
      reloading: this.reloading,
      reloadTimer: this.reloadTimer,
      alive: this.alive,
      visible: this._visibleNow,
      reacting: this._reacting,
      reactionTimer: this._reactionTimer,
      aimErrorDeg: this._aimErrMag,
      aimHigh: this._aimHigh,
      lastKnownPos: this._lastKnownPos
        ? [this._lastKnownPos[0], this._lastKnownPos[1], this._lastKnownPos[2]] : null,
      lastKnownAge: this._lastKnownPos ? (this._time - this._lastKnownTime) : -1,
      pathLen: this._path ? this._path.length : 0,
      pathIdx: this._pathIdx,
      stuckCount: this._stuckCount,
      stuckTimer: this._stuckTimer,
      retreating: this._retreating,
      coverTarget: this._coverTarget
        ? [this._coverTarget.p[0], this._coverTarget.p[1], this._coverTarget.p[2]] : null,
      moveSpeed: this._speedNow,
      shots: this._shots,
      hits: this._hits,
      reloads: this._reloads,
      errors: this._errorCount,
      lastError: this._lastError,
      time: this._time,
      playerDist: this._lastPlayerDist
    };
  };

  /* ======================================================================
   * 每帧主循环
   * ==================================================================== */

  Bot.prototype.update = function (dt, ctx) {
    if (!ctx) return;
    try {
      var d = Number(dt);
      if (!isNum(d) || d <= 0) d = 1 / 60;
      if (d > 0.1) d = 0.1; // 切后台/卡顿保护

      this._time += d;

      if (!this.alive) {
        this.state = 'dead';
        return;
      }

      var wdef = (ctx.weapons && ctx.weapons[this.weaponId]) || this._wdef || AK_FALLBACK;
      this._wdef = wdef;

      var map = ctx.map || null;
      if (map !== this._mapRef) {
        this._mapRef = map;
        this._graph = null;
        this._path = null;
        this._pathGoal = -1;
        this._patrolGoal = null;
      }

      this._ensureGraph(ctx);

      // 周期决策：普通/困难会“预瞄常见角度”
      this._preAimCheckTimer -= d;
      if (this._preAimCheckTimer <= 0) {
        this._preAimCheckTimer = 0.55;
        this._preAimActive = Math.random() < this._diff.preAim;
      }

      var eye = this.eyePos();
      var sen = this._sense(ctx, ctx.player, eye);
      this._onPerception(sen, d);

      var plan = this._think(d, ctx, sen);
      this._aim(d, ctx, sen, plan);
      this._weaponUpdate(d, ctx, sen, plan);
      this._move(d, ctx, plan);
    } catch (err) {
      this._errorCount++;
      this._lastError = 'update: ' + String((err && err.message) || err);
      if (this._errorCount <= 2 && typeof console !== 'undefined' && console && typeof console.error === 'function') {
        console.error('[GAME.Bot] update error:', err);
      }
    }
  };

  /* ======================================================================
   * 感知
   * ==================================================================== */

  Bot.prototype._sense = function (ctx, player, eye) {
    var D = this._diff;
    var sen = {
      player: player || null,
      alive: false,
      visible: false,
      dist: Infinity,
      dist2D: Infinity,
      ppos: null,
      pvel: [0, 0, 0],
      eyeP: null,
      chest: null,
      head: null,
      losChest: false,
      losHead: false,
      inFov: false,
      crouching: false,
      reloading: false,
      health: 100,
      spawnProtected: false
    };

    var pp = player && player.pos;
    if (!player || player.alive === false || !isVec3(pp)) {
      this._lastPlayerDist = 0;
      // 听声兜底：即使本帧玩家不可见，也允许通过 lastFireTime 变化感知枪声
      this._fallbackHearing(player);
      return sen;
    }

    var crouching = !!player.crouching;
    var eyeP = readPlayerEye(player, crouching ? CROUCH_EYE : STAND_EYE);
    if (!eyeP) eyeP = [pp[0], pp[1] + (crouching ? CROUCH_EYE : STAND_EYE), pp[2]];

    var chest = [pp[0], pp[1] + (crouching ? 0.82 : 1.12), pp[2]];
    var head = [eyeP[0], eyeP[1], eyeP[2]];

    sen.alive = true;
    sen.ppos = pp;
    sen.eyeP = eyeP;
    sen.chest = chest;
    sen.head = head;
    sen.crouching = crouching;
    sen.reloading = !!player.reloading;
    sen.health = isNum(player.health) ? player.health : 100;
    sen.spawnProtected = !!player.spawnProtected;
    if (isVec3(player.vel)) sen.pvel = player.vel;

    var dxc = chest[0] - eye[0], dzc = chest[2] - eye[2];
    var distChest = dist3(eye, chest);
    var distXZv = distXZ(this.pos, pp);
    sen.dist = distChest;
    sen.dist2D = distXZv;
    this._lastPlayerDist = Math.round(distXZv * 10) / 10;

    // 视野 FOV 110°：用水平朝向判断（第一人称 FPS 的常规做法）
    var lookX = -Math.sin(this.yaw), lookZ = -Math.cos(this.yaw);
    var dl = hypot2(dxc, dzc);
    sen.inFov = dl < 1e-4 || ((dxc * lookX + dzc * lookZ) / dl) >= Math.cos(D.fovDeg * 0.5 * DEG);

    if (sen.inFov && distXZv <= D.viewRange) {
      // 每帧最多 2 次 LOS（胸口 + 头部）
      sen.losChest = safeLos(ctx, eye, chest);
      if (sen.losChest) {
        sen.losHead = true;
      } else {
        sen.losHead = safeLos(ctx, eye, head);
      }
      sen.visible = sen.losChest || sen.losHead;
    }

    // 听声兜底（若 game 忘记调用 onHearShot，用 player.lastFireTime 变化近似，仍受听声范围限制）
    this._fallbackHearing(player);

    return sen;
  };

  Bot.prototype._fallbackHearing = function (player) {
    if (!player || player.alive === false) return;
    var lf = Number(player.lastFireTime);
    if (!isNum(lf)) return;
    if (!isNum(this._playerFireSeen)) {
      this._playerFireSeen = lf;
      return;
    }
    if (lf <= this._playerFireSeen + 1e-6) return;
    this._playerFireSeen = lf;
    if (this._time - this._lastHearTime < 0.12) return; // 已由 onHearShot 处理
    var pp = player.pos;
    if (!isVec3(pp)) return;
    var d = distXZ(this.pos, pp);
    if (d <= this._diff.hearingRange) this._hear([pp[0], pp[1], pp[2]], d, 0.75);
  };

  // 听到枪声：记下带误差的最后已知位置，并安排“转头警戒”的反应时间
  Bot.prototype._hear = function (pos, dist, errScale) {
    if (!this.alive) return;
    var D = this._diff;
    var now = this._time;
    var err = Math.max(0, 1 - dist / Math.max(1, D.hearingRange)) * D.hearError * (errScale || 1);
    var ang = Math.random() * TAU;
    var rad = Math.random() * err;
    var hp = [pos[0] + Math.cos(ang) * rad, pos[1], pos[2] + Math.sin(ang) * rad];

    this._lastKnownPos = hp;
    this._lastKnownTime = now;
    this._lastKnownFromSound = true;
    this._lastHearTime = now;
    this._searchLookUntil = 0;
    this._alertLevel = 2;

    if (!this._visibleNow) {
      var delay = randRange(D.reactionMin * 0.5, D.reactionMax * 0.9);
      if (delay > this._hearReactTimer) this._hearReactTimer = delay;
      this._path = null;
      this._pathGoal = -1;
    }
  };

  // 视觉状态机：首次发现（反应延迟/误差重置）、持续跟踪、丢失记忆
  Bot.prototype._onPerception = function (sen, d) {
    var D = this._diff;
    var now = this._time;

    if (sen.visible) {
      if (!this._visibleNow) {
        // 刚发现目标：反应延迟 + 瞄准误差重置 + 选择瞄头/瞄胸
        var alerted = (now - this._lastKnownTime) < 2.5 || this._alertLevel > 0;
        this._reactionTimer = randRange(D.reactionMin, D.reactionMax) * (alerted ? D.reactionRefresh : 1);
        this._reacting = this._reactionTimer > 0;
        this._aimHigh = Math.random() < D.headshotBias;
        this._settle = D.settleFrom;
        this._aimErrMag = D.aimBaseError * D.settleFrom * 0.3;
        this._aimErrAng = Math.random() * TAU;
        this._recoilErr = 0;
        this._burstLeft = 0;
        this._burstPauseUntil = now + randRange(0.05, 0.3);
        this._preAimActive = false;
      }
      this._lastKnownPos = [sen.ppos[0], sen.ppos[1], sen.ppos[2]];
      this._lastKnownTime = now;
      this._lastKnownFromSound = false;
      this._searchLookUntil = 0;
      this._alertLevel = 2;
      this._visibleNow = true;
    } else {
      this._visibleNow = false;
      this._alertLevel = Math.max(0, this._alertLevel - d * 0.15);
      // 记忆过期
      if (this._lastKnownPos && now - this._lastKnownTime > D.searchDuration) {
        this._lastKnownPos = null;
        this._searchLookUntil = 0;
      }
    }
  };

  /* ======================================================================
   * 决策状态机
   * ==================================================================== */

  Bot.prototype._think = function (d, ctx, sen) {
    var D = this._diff;
    var now = this._time;
    var wdef = this._wdef;
    var mag = (wdef && wdef.mag) || AK_FALLBACK.mag;

    var plan = {
      state: 'patrol',
      wish: [0, 0],
      speed: 0,
      jump: false,
      crouch: false,
      walk: false,
      arriveDist: 0.9
    };

    // —— 计时器 ——
    if (this._reacting) {
      this._reactionTimer -= d;
      if (this._reactionTimer <= 0) {
        this._reactionTimer = 0;
        this._reacting = false;
      }
    }
    if (this._hearReactTimer > 0) this._hearReactTimer = Math.max(0, this._hearReactTimer - d);

    // —— 换弹计时 ——
    if (this.reloading) {
      this.reloadTimer -= d;
      if (this.reloadTimer <= 0) {
        this.reloading = false;
        this.reloadTimer = 0;
        this.ammo = mag;
        this._reloads++;
      }
    }

    // —— 撤退判定 ——
    var underFire = (now - this._lastDamageTime) < 2.2;
    var lowHp = this.health <= D.retreatHealth;

    if (this._retreating) {
      var coverDist = this._coverTarget ? distXZ(this.pos, this._coverTarget.p) : Infinity;
      if (coverDist < 1.35) this._retreatArrived = true;
      if (this._retreatArrived && !this.reloading && (now - this._retreatStart) > 1.5) {
        this._retreating = false;
        this._retreatCooldownUntil = now + randRange(4.5, 8);
      }
      if (now - this._retreatStart > 14) {
        this._retreating = false;
        this._retreatCooldownUntil = now + randRange(4, 7);
      }
    } else if (lowHp && underFire && sen.dist2D > 5.5 && now > this._retreatCooldownUntil) {
      if (Math.random() < D.coverChance && this._pickCover(ctx, sen)) {
        this._retreating = true;
        this._retreatStart = now;
        this._retreatArrived = false;
        this._path = null;
        this._pathGoal = -1;
      } else {
        this._retreatCooldownUntil = now + randRange(1.2, 2.8);
      }
    }

    // —— 换弹决策 ——
    if (!this.reloading) {
      var empty = this.ammo <= 0;
      var tactical = !sen.visible && this.ammo > 0 && this.ammo < mag * 0.45 &&
        now > this._lastReloadTime + 1.5;
      var behindCover = this._retreating && this._retreatArrived && this.ammo < mag;
      if (empty || tactical || behindCover) this._startReload(wdef, now);
    }

    // —— 按优先级选行为 ——
    var state;

    if (this._retreating && this._coverTarget) {
      // 撤退：跑向 cover>0.5 的 waypoint，利用遮挡；到位后换弹
      state = 'retreat';
      if (!this._retreatArrived) {
        var reached = this._moveTo(ctx, this._coverTarget.p, 5.6, plan, false, false);
        this._retreatArrived = reached || distXZ(this.pos, this._coverTarget.p) < 1.35;
      }
      if (this._retreatArrived) {
        plan.wish[0] = 0;
        plan.wish[1] = 0;
        plan.speed = 0;
        plan.crouch = !this.reloading;
      }
    } else if (this.reloading) {
      state = 'reload';
      if (sen.visible) {
        // 边打边退换弹：优先找能挡视线的掩体，否则后撤 + 横移
        if (!this._reloadCoverTried && D.coverChance > 0.3 && this._pickCover(ctx, sen)) {
          this._reloadCoverTried = true;
          this._reloadCoverArrived = false;
          this._path = null;
          this._pathGoal = -1;
        }
        if (this._reloadCoverTried && this._coverTarget) {
          if (!this._reloadCoverArrived) {
            this._reloadCoverArrived = this._moveTo(ctx, this._coverTarget.p, 4.4, plan, false, false) ||
              distXZ(this.pos, this._coverTarget.p) < 1.35;
          }
          if (this._reloadCoverArrived) {
            plan.wish[0] = 0;
            plan.wish[1] = 0;
            plan.speed = 0;
            plan.crouch = true;
          }
        } else {
          this._backpedal(sen, plan, 3.6);
        }
      } else if (this._lastKnownPos) {
        this._moveTo(ctx, this._lastKnownPos, 3.6, plan, false, true);
      } else {
        this._patrolStep(ctx, plan, 2.8);
      }
    } else if (sen.visible) {
      state = 'engage';
      this._combatMove(d, ctx, sen, plan);
    } else if (this._hearReactTimer > 0 && this._lastKnownPos) {
      // 听到枪声后的警示停顿（转头看向声音方向），再决定去调查
      state = 'reposition';
      plan.wish[0] = 0;
      plan.wish[1] = 0;
      plan.speed = 0;
    } else if (this._lastKnownPos) {
      // 去最后已知位置调查（不是全知）；到达后原地搜索一小段时间，再恢复巡逻
      state = 'reposition';
      if (distXZ(this.pos, this._lastKnownPos) < 1.8) {
        plan.wish[0] = 0;
        plan.wish[1] = 0;
        plan.speed = 0;
        if (!this._searchLookUntil) this._searchLookUntil = now + randRange(1.6, 3.2);
        if (now > this._searchLookUntil) {
          this._lastKnownPos = null;
          this._searchLookUntil = 0;
        }
      } else {
        this._searchLookUntil = 0;
        this._moveTo(ctx, this._lastKnownPos, 4.6, plan, false, true);
      }
    } else if (ctx.map && this._graph && this._graph.nodes.length) {
      state = 'patrol';
      this._patrolStep(ctx, plan, 4.6);
    } else {
      state = 'patrol';
      if (ctx.map) this._patrolStep(ctx, plan, 4.2);
      else state = 'idle';
    }

    // —— 卡墙脱困：临时侧向/后方移动 + 偶尔跳跃 ——
    if (now < this._stuckEscapeUntil) {
      plan.wish[0] = this._stuckEscapeDir[0];
      plan.wish[1] = this._stuckEscapeDir[1];
      plan.speed = Math.max(plan.speed, 3.0);
      plan.crouch = false;
    }
    if (this._wantJump && this.onGround) {
      plan.jump = true;
      this._wantJump = false;
    }

    // 蹲下时速度上限（文档：下蹲 2.9 m/s）
    if (plan.crouch) plan.speed = Math.min(plan.speed, 2.9);

    plan.state = state;
    this.state = state;
    return plan;
  };

  /* ---------------------------------------------------------------- 交战走位 */

  Bot.prototype._combatMove = function (d, ctx, sen, plan) {
    var D = this._diff;
    var now = this._time;
    var pp = sen.ppos;

    // 横移 / 站桩
    var strafe = this._updateStrafe(d, D);
    var wishX = 0, wishZ = 0, speed = 0;
    if (strafe !== 0) {
      var rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw); // right = [cos yaw, 0, -sin yaw]
      wishX = rx * strafe;
      wishZ = rz * strafe;
      speed = D.combatMoveSpeed;
    }

    // 距离管理：太远压上，太近后撤；困难在玩家残血/换弹时主动压迫
    var dx = pp[0] - this.pos[0], dz = pp[2] - this.pos[2];
    var dl = hypot2(dx, dz) || 1;
    var press = 0;
    var aggressive = (sen.health <= 40) || sen.reloading;
    if (sen.dist2D > D.preferredMax) press = 0.85;
    else if (sen.dist2D < D.preferredMin) press = -0.8;
    if (aggressive && D.pressAggression > 0 && sen.dist2D > D.preferredMin) {
      press = Math.max(press, 0.9 * D.pressAggression);
    }
    if (press !== 0) {
      wishX += (dx / dl) * press;
      wishZ += (dz / dl) * press;
      speed = Math.max(speed, press > 0 ? 4.2 : 3.2);
    }

    // 急停射击（困难常用）
    if (now < this._stopUntil) {
      wishX = 0;
      wishZ = 0;
      speed = 0;
    }

    var wl = hypot2(wishX, wishZ);
    if (wl > 1) { wishX /= wl; wishZ /= wl; wl = 1; }
    if (wl < 0.05) {
      plan.wish[0] = 0;
      plan.wish[1] = 0;
      plan.speed = 0;
    } else {
      plan.wish[0] = wishX;
      plan.wish[1] = wishZ;
      plan.speed = speed;
    }

    // 蹲射
    plan.crouch = this._updateCrouch(d, D, now);

    // 玩家贴脸时困难会蹲压枪
    if (!plan.crouch && D.pressAggression > 0 && sen.dist2D < 6 && Math.random() < 0.15 * d * 10) {
      plan.crouch = true;
    }
  };

  Bot.prototype._updateStrafe = function (d, D) {
    var now = this._time;
    if (now >= this._strafeUntil) {
      this._strafeUntil = now + randRange(D.strafeIntervalMin, D.strafeIntervalMax);
      this._strafeDir = Math.random() < D.strafeChance ? (Math.random() < 0.5 ? -1 : 1) : 0;
    }
    if (this._strafeDir !== 0 && Math.random() < D.dodgeChance * d) {
      this._strafeDir = -this._strafeDir;
    }
    return this._strafeDir;
  };

  Bot.prototype._updateCrouch = function (d, D, now) {
    if (now < this._crouchUntil) return true;
    if (now >= this._crouchCheckAt) {
      this._crouchCheckAt = now + randRange(1.2, 2.4);
      if (Math.random() < D.crouchChance) {
        this._crouchUntil = now + randRange(D.crouchDurationMin, D.crouchDurationMax);
        return true;
      }
    }
    return false;
  };

  // 换弹时后撤（保持面向敌人）
  Bot.prototype._backpedal = function (sen, plan, speed) {
    var pp = sen.ppos;
    var dx = this.pos[0] - pp[0], dz = this.pos[2] - pp[2];
    var dl = hypot2(dx, dz);
    if (dl < 0.3) { plan.wish[0] = 0; plan.wish[1] = 0; plan.speed = 0; return; }
    var strafe = this._strafeDir;
    var rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    var wx = dx / dl + rx * strafe * 0.6;
    var wz = dz / dl + rz * strafe * 0.6;
    var wl = hypot2(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    plan.wish[0] = wx;
    plan.wish[1] = wz;
    plan.speed = speed;
  };

  /* ---------------------------------------------------------------- 巡逻 */

  Bot.prototype._patrolStep = function (ctx, plan, speed) {
    var now = this._time;
    if (!this._patrolGoal) this._pickPatrolGoal(ctx);
    if (now < this._patrolPauseUntil) {
      plan.wish[0] = 0;
      plan.wish[1] = 0;
      plan.speed = 0;
      return;
    }
    if (!this._patrolGoal) {
      plan.wish[0] = 0;
      plan.wish[1] = 0;
      plan.speed = 0;
      return;
    }
    var reached = this._moveTo(ctx, this._patrolGoal, speed, plan, false, false);
    if (reached) {
      this._patrolGoal = null;
      this._patrolPauseUntil = now + randRange(0.25, 1.1);
    }
  };

  Bot.prototype._pickPatrolGoal = function (ctx) {
    var g = this._graph;
    this._patrolPauseUntil = 0;
    this._scanPhase = Math.random() * TAU;
    if (g && g.nodes.length) {
      var nodes = g.nodes;
      var n = nodes.length;
      var best = -1;
      var pr, d;
      for (var tries = 0; tries < 10; tries++) {
        pr = Math.floor(Math.random() * n);
        if (pr === this._lastPatrolNode && n > 2) continue;
        d = hypot2(nodes[pr].x - this.pos[0], nodes[pr].z - this.pos[2]);
        if (d < 5) continue;
        best = pr;
        break;
      }
      if (best < 0) best = Math.floor(Math.random() * n);
      this._lastPatrolNode = best;
      this._patrolGoal = [nodes[best].x, nodes[best].y, nodes[best].z];
      this._path = null;
      this._pathGoal = -1;
      return;
    }
    // 无路点：在 bounds 内随机游走
    var b = this._mapRef && this._mapRef.bounds;
    if (b && isVec3(b.min) && isVec3(b.max)) {
      this._patrolGoal = [
        randRange(b.min[0] + 3, b.max[0] - 3),
        this.pos[1],
        randRange(b.min[2] + 3, b.max[2] - 3)
      ];
    } else {
      this._patrolGoal = null;
    }
    this._path = null;
    this._pathGoal = -1;
  };

  /* ======================================================================
   * 瞄准
   * ==================================================================== */

  Bot.prototype._aim = function (d, ctx, sen, plan) {
    var D = this._diff;
    var now = this._time;
    var eyePos = this.eyePos();
    var wantYaw, wantPitch;
    var combatAim = false;

    if (sen.visible && sen.ppos) {
      combatAim = true;
      // 提前量：困难会按玩家速度预测（补偿自身转向/开火延迟；hitscan 不做飞行时间预判）
      var ppos = sen.ppos, pvel = sen.pvel;
      var yawNow = yawTo(eyePos, sen.chest);
      var lag = Math.abs(angleDelta(this.yaw, yawNow)) / (Math.max(60, D.turnSpeed) * DEG);
      var leadFactor = isNum(D.leadFactor) ? D.leadFactor : 0;
      var leadTime = leadFactor * clamp(lag * 1.4, 0, 0.2);
      var px = ppos[0] + (isNum(pvel[0]) ? pvel[0] * leadTime : 0);
      var pz = ppos[2] + (isNum(pvel[2]) ? pvel[2] * leadTime : 0);
      var aimPt = this._aimHigh
        ? [px, sen.head[1] - 0.08, pz]   // 瞄“头部下沿/颈线”，不是精确球心
        : [px, sen.chest[1], pz];

      wantYaw = yawTo(eyePos, aimPt);
      wantPitch = pitchTo(eyePos, aimPt);
      this._aimTargetPoint = aimPt;

      // 持续性瞄准偏差（很小，主要影响转向观感；命中精度由每发高斯随机决定）
      this._updateAimError(d, D, sen);
      var aimErrApply = this._aimErrMag * (this._aimHigh ? 0.85 : 1);
      wantYaw += Math.cos(this._aimErrAng) * aimErrApply * DEG;
      wantPitch += Math.sin(this._aimErrAng) * aimErrApply * 0.55 * DEG;
    } else if (this._lastKnownPos &&
      (this._retreating || this._hearReactTimer > 0 || plan.state === 'reposition')) {
      // 警戒/调查：看向最后已知位置
      var lk = this._lastKnownPos;
      var look = [lk[0], lk[1] + 1.2, lk[2]];
      wantYaw = yawTo(eyePos, look);
      wantPitch = pitchTo(eyePos, look);
      this._aimTargetPoint = look;
      // 调查时缓慢左右搜索
      wantYaw += Math.sin(now * 1.1 + this._scanPhase) * (plan.speed > 0.5 ? 0.1 : 0.42);
    } else {
      // 巡逻：沿路径前方，叠加左右扫视；困难会预瞄最后已知/拐角方向
      var baseYaw, lookPt;
      var g = this._graph;
      if (g && this._path && this._pathIdx < this._path.length) {
        var node = g.nodes[this._path[this._pathIdx]];
        var lookNode = node;
        if (D.preAim > 0 && this._pathIdx + 1 < this._path.length) {
          var nn = g.nodes[this._path[this._pathIdx + 1]];
          var dCur = hypot2(node.x - this.pos[0], node.z - this.pos[2]);
          if (dCur < 7) lookNode = nn; // 拐角预瞄
        }
        lookPt = [lookNode.x, lookNode.y + 1.2, lookNode.z];
      } else if (this._patrolGoal) {
        lookPt = [this._patrolGoal[0], this._patrolGoal[1] + 1.2, this._patrolGoal[2]];
      } else {
        lookPt = [eyePos[0] - Math.sin(this.yaw) * 8, eyePos[1] - 0.2, eyePos[2] - Math.cos(this.yaw) * 8];
      }

      var usePreAim = D.preAim > 0 && this._preAimActive && this._lastKnownPos &&
        (now - this._lastKnownTime) < D.preAimRemember;
      if (usePreAim) {
        var lk2 = this._lastKnownPos;
        lookPt = [lk2[0], lk2[1] + 1.15, lk2[2]];
        baseYaw = yawTo(eyePos, lookPt);
        wantYaw = baseYaw + Math.sin(now * 0.9 + this._scanPhase) * 0.12;
      } else {
        baseYaw = yawTo(eyePos, lookPt);
        var scanAmp = 0.55 - D.preAim * 0.38;
        wantYaw = baseYaw + Math.sin(now * 0.85 + this._scanPhase) * scanAmp;
      }
      wantPitch = -0.02 + Math.sin(now * 0.6 + this._scanPhase) * 0.015;
      this._aimTargetPoint = lookPt;
    }

    // 转向速度限制（不允许瞬锁）
    var rateFactor = combatAim ? 1.0 : 0.65;
    var maxYawStep = D.turnSpeed * DEG * d * rateFactor;
    var dy = angleDelta(this.yaw, wantYaw);
    if (Math.abs(dy) <= maxYawStep) this.yaw = wantYaw;
    else this.yaw += signOf(dy) * maxYawStep;

    var maxPitchStep = D.pitchSpeed * DEG * d * rateFactor;
    var dp = wantPitch - this.pitch;
    if (Math.abs(dp) <= maxPitchStep) this.pitch = wantPitch;
    else this.pitch += signOf(dp) * maxPitchStep;

    this.yaw = angleWrap(this.yaw);
    this.pitch = clamp(this.pitch, -1.25, 1.25);
    if (!isNum(this.yaw)) this.yaw = 0;
    if (!isNum(this.pitch)) this.pitch = 0;
    this._desiredYaw = isNum(wantYaw) ? wantYaw : this.yaw;
    this._desiredPitch = isNum(wantPitch) ? wantPitch : this.pitch;

    // 调试/渲染用瞄准点：从当前实际朝向出发
    var f = dirFromAngles(this.yaw, this.pitch, [0, 0, 0]);
    var apDist = 12;
    if (sen.visible && isNum(sen.dist)) apDist = clamp(sen.dist, 2, 30);
    this.aimPoint = [
      eyePos[0] + f[0] * apDist,
      eyePos[1] + f[1] * apDist,
      eyePos[2] + f[2] * apDist
    ];
  };

  Bot.prototype._updateAimError = function (d, D, sen) {
    var botSpd = hypot2(this.vel[0], this.vel[2]);
    var playerSpd = hypot2(sen.pvel[0], sen.pvel[2]);
    var moveErr = D.aimMoveError * clamp((botSpd * 0.72 + playerSpd * 0.35) / 5.7, 0, 1.35);
    if (this._reacting) moveErr *= 1.4;

    // 持续性瞄准偏差（会随转向/移动缓慢漂移；真正的命中精度由每发高斯随机决定）
    var targetMag = (D.aimBaseError * 0.30 + moveErr * 0.45 + this._recoilErr * 0.5) * this._settle;

    // 误差幅度 & 初始稳定倍率收敛（难度越高越快）
    this._settle += (1 - this._settle) * Math.min(1, D.errorConverge * d * 1.6);
    this._aimErrMag += (targetMag - this._aimErrMag) * Math.min(1, D.errorConverge * d * 2.2);
    this._aimErrMag = clamp(
      this._aimErrMag,
      0.01,
      D.aimBaseError * 1.0 + moveErr + this._recoilErr + 0.5
    );

    // 误差方向缓慢漂移（模拟准星微抖）
    this._aimErrAng += randSym(D.aimWander * DEG * d);
    if (!isNum(this._aimErrAng)) this._aimErrAng = 0;

    // 连发后坐误差恢复
    this._recoilErr *= Math.exp(-D.recoilRecover * d);
    if (this._recoilErr < 0.01) this._recoilErr = 0;
  };

  /* ======================================================================
   * 开火 / 换弹
   * ==================================================================== */

  Bot.prototype._startReload = function (wdef, now) {
    var mag = (wdef && wdef.mag) || AK_FALLBACK.mag;
    if (this.reloading || this.ammo >= mag) return;
    this.reloading = true;
    this.reloadTimer = (wdef && wdef.reloadTime) || AK_FALLBACK.reloadTime;
    this._lastReloadTime = now;
    this._burstLeft = 0;
    this._burstPauseUntil = now;
    this._reloadCoverTried = false;
    this._reloadCoverArrived = false;
  };

  Bot.prototype._weaponUpdate = function (d, ctx, sen, plan) {
    var D = this._diff;
    var now = this._time;
    var wdef = this._wdef || AK_FALLBACK;

    if (this.state !== 'engage') return;
    if (this._reacting || this.reloading || this.ammo <= 0) return;
    if (!sen.visible) return;
    var p = sen.player;
    if (!p || p.alive === false || sen.spawnProtected) return;

    // 瞄准门限：转得差不多了才开枪（不允许甩枪瞬锁）
    var onTarget = Math.abs(angleDelta(this.yaw, this._desiredYaw)) <= D.fireAngleGate * DEG &&
      Math.abs(this.pitch - this._desiredPitch) <= (D.fireAngleGate + 4) * DEG;
    if (!onTarget) return;

    // 不隔墙开枪
    if (!(sen.losChest || sen.losHead)) return;
    if (sen.dist2D > ((wdef.range || AK_FALLBACK.range) * 0.95)) return;
    if (now < this._fireNextTime) return;

    if (this._burstLeft <= 0) {
      if (now < this._burstPauseUntil) return;
      this._burstLeft = randInt(D.burstMin, D.burstMax);
      this._burstShotIndex = 0;
      // 新一轮点射需要重新稳定
      this._aimErrMag = Math.min(this._aimErrMag + D.aimBaseError * 0.12, D.aimBaseError * 2);
      this._settle = Math.max(this._settle, 1.06);

      // 急停：困难几乎必停，简单几乎不停
      if (Math.random() < D.stopChance) {
        var rate = Math.max(2, (wdef.rpm || AK_FALLBACK.rpm) / 60);
        var burstDur = this._burstLeft / rate;
        this._stopUntil = now + clamp(burstDur, 0.12, 0.45);
      }
    }

    this._fireOneShot(ctx, sen, wdef);
    this._burstShotIndex++;
    this._burstLeft--;
    this._fireNextTime = now + 60 / clamp(wdef.rpm || AK_FALLBACK.rpm, 30, 1500);

    if (this._burstLeft <= 0) {
      this._burstLeft = 0;
      this._burstPauseUntil = now + randRange(D.burstIntervalMin, D.burstIntervalMax);
    }
    if (this.ammo <= 0) this._startReload(wdef, now);
  };

  Bot.prototype._fireOneShot = function (ctx, sen, wdef) {
    var D = this._diff;
    var botSpd = hypot2(this.vel[0], this.vel[2]);
    var playerSpd = hypot2(sen.pvel[0], sen.pvel[2]);

    // 每发随机误差 σ（deg）：基础精度 + 移动 + 连发散布 + 后坐，正交叠加
    var baseSigma = D.aimBaseError * (isNum(D.aimSigmaFactor) ? D.aimSigmaFactor : 0.7);
    var moveSigma = D.aimMoveError * 0.55 * clamp((botSpd * 0.72 + playerSpd * 0.35) / 5.7, 0, 1.35);
    var burstSigma = D.shotSpread * (1 + this._burstShotIndex * D.burstGrowth);
    var recoilSigma = this._recoilErr * 0.55;
    var sigma = Math.sqrt(
      baseSigma * baseSigma + moveSigma * moveSigma +
      burstSigma * burstSigma + recoilSigma * recoilSigma
    );
    if (this._crouchWant) sigma *= 0.85;
    if (!isNum(sigma) || sigma < 0) sigma = 0;

    // 后坐误差进入瞄准误差池（困难恢复快）
    this._recoilErr = Math.min(9, this._recoilErr + D.recoilKick);

    var yaw = this.yaw + gaussRand() * sigma * DEG;
    var pitch = this.pitch + gaussRand() * sigma * 0.8 * DEG;
    if (!isNum(yaw)) yaw = this.yaw;
    if (!isNum(pitch)) pitch = this.pitch;
    var dir = dirFromAngles(yaw, pitch, [0, 0, 0]);

    this.ammo = Math.max(0, this.ammo - 1);
    this._shots++;

    var result = null;
    try {
      if (typeof ctx.botFire === 'function') {
        result = ctx.botFire(dir, {
          bot: this,
          weaponId: this.weaponId,
          headshot: this._aimHigh,
          distance: sen.dist2D,
          spreadDeg: Math.round(sigma * 100) / 100,
          difficulty: this.difficulty
        });
      }
    } catch (err) {
      this._lastError = 'botFire: ' + String((err && err.message) || err);
    }
    if (result && result.hit) this._hits++;
  };

  /* ======================================================================
   * 移动（统一走 ctx.moveActor）
   * ==================================================================== */

  Bot.prototype._move = function (d, ctx, plan) {
    var wish = plan.wish || [0, 0];
    var speed = plan.speed || 0;
    var prevX = this.pos[0], prevY = this.pos[1], prevZ = this.pos[2];

    if (speed < 0) speed = 0;
    if (!isNum(wish[0]) || !isNum(wish[1])) { wish = [0, 0]; speed = 0; }

    // 下蹲意图交给 moveActor（GAME.Physics 用平滑数值 crouch，并维护 height/eyeHeight）
    this._crouchWant = !!plan.crouch;
    this._speedNow = speed;

    var opts = { jump: !!plan.jump, crouch: !!plan.crouch, walk: !!plan.walk };

    if (typeof ctx.moveActor === 'function') {
      try {
        // wishDir 3 元组 [x,0,z]：兼容 engine.js（读 [0]/[2]）与 game.js 的 2 元组适配
        var ret = ctx.moveActor(this, d, [wish[0], 0, wish[1]], speed, opts);
        // 兼容 moveActor 返回新状态对象（正常实现是原地修改 this）
        if (ret && ret !== this && ret.pos && isVec3(ret.pos)) {
          this.pos = [ret.pos[0], ret.pos[1], ret.pos[2]];
          if (isVec3(ret.vel)) this.vel = [ret.vel[0], ret.vel[1], ret.vel[2]];
        }
      } catch (err) {
        this._lastError = 'moveActor: ' + String((err && err.message) || err);
        this._fallbackMove(d, wish, speed);
      }
    } else {
      this._fallbackMove(d, wish, speed);
    }

    // NaN / 非法状态兜底
    if (!isVec3(this.pos)) this.pos = [prevX, prevY, prevZ];
    if (!isVec3(this.vel)) this.vel = [0, 0, 0];
    if (!isNum(this.yaw)) this.yaw = 0;
    if (!isNum(this.pitch)) this.pitch = 0;
    if (this.pos[1] < -12) this.pos[1] = -12;

    // crouch / eyeHeight 由物理层维护（平滑数值）；缺失时按意图兜底
    if (!isNum(this.crouch)) this.crouch = this._crouchWant ? 1 : 0;
    if (!isNum(this.eyeHeight) || this.eyeHeight < 1.0 || this.eyeHeight > 1.8) {
      this.eyeHeight = this._crouchWant ? CROUCH_EYE : STAND_EYE;
    }
    if (!isNum(this.height) || this.height < 0.9 || this.height > 1.9) {
      this.height = this._crouchWant ? CROUCH_HEIGHT : STAND_HEIGHT;
    }

    // 卡墙 / 卡角落检测：想走但几乎没位移
    var moved = hypot2(this.pos[0] - prevX, this.pos[2] - prevZ);
    if (speed > 0.6) {
      if (moved < Math.max(0.0015, speed * d * 0.12)) this._stuckTimer += d;
      else this._stuckTimer = Math.max(0, this._stuckTimer - d * 2.5);
    } else {
      this._stuckTimer = Math.max(0, this._stuckTimer - d * 2.5);
    }
    if (this._stuckTimer > 0.5) this._onStuck(ctx);
  };

  Bot.prototype._fallbackMove = function (d, wish, speed) {
    var n = normalize2(wish[0], wish[1]);
    // 简单加速
    var accel = this.onGround ? 60 : 14;
    var tvx = n[0] * speed, tvz = n[1] * speed;
    var vx = this.vel[0], vz = this.vel[2];
    var dvx = tvx - vx, dvz = tvz - vz;
    var dl = hypot2(dvx, dvz);
    var maxDv = accel * d;
    if (dl > maxDv && dl > 1e-6) {
      vx += (dvx / dl) * maxDv;
      vz += (dvz / dl) * maxDv;
    } else {
      vx = tvx;
      vz = tvz;
    }
    this.vel[0] = vx;
    this.vel[1] = 0;
    this.vel[2] = vz;
    this.pos[0] += vx * d;
    this.pos[2] += vz * d;
    this.onGround = true;
    var b = this._mapRef && this._mapRef.bounds;
    if (b && isVec3(b.min) && isVec3(b.max)) {
      this.pos[0] = clamp(this.pos[0], b.min[0] + 0.5, b.max[0] - 0.5);
      this.pos[2] = clamp(this.pos[2], b.min[2] + 0.5, b.max[2] - 0.5);
    }
  };

  // 卡住：随机侧向/后方脱困，强制重算路径，必要时跳一下
  Bot.prototype._onStuck = function (ctx) {
    this._stuckTimer = 0;
    this._stuckCount++;
    this._path = null;
    this._pathGoal = -1;
    this._patrolGoal = null;
    this._patrolPauseUntil = 0;

    var side = Math.random() < 0.5 ? 1 : -1;
    var escapeYaw = this.yaw + side * (PI * 0.5) + randSym(0.6);
    if (Math.random() < 0.25) escapeYaw += PI; // 有时直接后退
    this._stuckEscapeDir = [-Math.sin(escapeYaw), -Math.cos(escapeYaw)];
    this._stuckEscapeUntil = this._time + randRange(0.45, 0.9);

    if (this.onGround && this._time > this._jumpCooldownUntil) {
      this._wantJump = true;
      this._jumpCooldownUntil = this._time + randRange(1.2, 2.2);
    }
  };

  /* ======================================================================
   * 导航（waypoint 图 + A* + 缓存）
   * ==================================================================== */

  Bot.prototype._segmentClear = function (ctx, a, b) {
    var ph = ctx && ctx.physics;
    if (ph && typeof ph.segmentBlocked === 'function') {
      try { return !ph.segmentBlocked(a, b); } catch (err) { return true; }
    }
    return true;
  };

  Bot.prototype._ensureGraph = function (ctx) {
    var map = ctx && ctx.map;
    if (!map) { this._graph = null; return null; }
    if (this._graph && this._graph.mapRef === map) return this._graph;

    var wps = map.waypoints;
    var nodes = [];
    var nodeOfRaw = [];
    var i, j;

    if (wps && wps.length) {
      for (i = 0; i < wps.length; i++) {
        var wp = wps[i];
        nodeOfRaw[i] = -1;
        if (!wp || !isVec3(wp.p)) continue;
        nodeOfRaw[i] = nodes.length;
        nodes.push({
          x: wp.p[0],
          y: isNum(wp.p[1]) ? wp.p[1] : 0,
          z: wp.p[2],
          cover: isNum(wp.cover) ? clamp(wp.cover, 0, 1) : 0.3,
          lane: wp.lane || '',
          id: wp.id != null ? wp.id : i,
          neighbors: []
        });
      }

      // 建边（links 按文档对称，这里再兜底补反向）
      for (i = 0; i < wps.length; i++) {
        var ni = nodeOfRaw[i];
        if (ni < 0) continue;
        var links = wps[i].links;
        if (!links || !links.length) continue;
        for (j = 0; j < links.length; j++) {
          var raw = links[j];
          if (!isNum(raw)) continue;
          var nj = (raw >= 0 && raw < nodeOfRaw.length) ? nodeOfRaw[raw] : -1;
          if (nj < 0 || nj === ni) continue;
          addEdge(nodes, ni, nj);
        }
      }

      // 孤立点兜底：连最近的 2 个点（不做遮挡检查，避免图断裂）
      for (i = 0; i < nodes.length; i++) {
        if (nodes[i].neighbors.length) continue;
        var near = nearestNodes(nodes, i, 2);
        for (j = 0; j < near.length; j++) addEdge(nodes, i, near[j].index);
      }

      // 连通性修复：不同连通分量之间找最近且通畅的一对点连接
      repairConnectivity(ctx, nodes, this);
    }

    this._graph = { mapRef: map, nodes: nodes };
    return this._graph;
  };

  function edgeDist(nodes, a, b) {
    return hypot2(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
  }

  function hasEdge(nodes, a, b) {
    var nb = nodes[a].neighbors;
    for (var i = 0; i < nb.length; i++) if (nb[i].i === b) return true;
    return false;
  }

  function addEdge(nodes, a, b) {
    if (a === b || a < 0 || b < 0) return;
    if (hasEdge(nodes, a, b)) return;
    var d = edgeDist(nodes, a, b);
    nodes[a].neighbors.push({ i: b, d: d });
    nodes[b].neighbors.push({ i: a, d: d });
  }

  function nearestNodes(nodes, index, count) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      if (i === index) continue;
      out.push({ index: i, d: edgeDist(nodes, index, i) });
    }
    out.sort(function (a, b) { return a.d - b.d; });
    return out.slice(0, count);
  }

  function computeComponents(nodes) {
    var comp = [];
    var n = nodes.length;
    for (var i = 0; i < n; i++) comp[i] = -1;
    var cid = 0;
    for (i = 0; i < n; i++) {
      if (comp[i] >= 0) continue;
      var stack = [i];
      comp[i] = cid;
      while (stack.length) {
        var cur = stack.pop();
        var nbs = nodes[cur].neighbors;
        for (var k = 0; k < nbs.length; k++) {
          var nb = nbs[k].i;
          if (comp[nb] >= 0) continue;
          comp[nb] = cid;
          stack.push(nb);
        }
      }
      cid++;
    }
    return { comp: comp, count: cid };
  }

  function repairConnectivity(ctx, nodes, bot) {
    var n = nodes.length;
    if (n < 2) return;
    var guard = 0;
    while (guard++ < n + 4) {
      var res = computeComponents(nodes);
      if (res.count <= 1) return;
      var comp = res.comp;
      var bestClear = null;
      var bestAny = null;
      for (var i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
          if (comp[i] === comp[j]) continue;
          var d = edgeDist(nodes, i, j);
          if (bestAny && d >= bestAny.d) continue;
          if (!bestAny) bestAny = { i: i, j: j, d: d };
          if (bestClear && d >= bestClear.d) continue;
          var clear = false;
          try {
            clear = bot._segmentClear(ctx,
              [nodes[i].x, nodes[i].y + 0.9, nodes[i].z],
              [nodes[j].x, nodes[j].y + 0.9, nodes[j].z]);
          } catch (err) { clear = false; }
          if (clear && (!bestClear || d < bestClear.d)) bestClear = { i: i, j: j, d: d };
        }
      }
      // 优先通畅的连线；实在找不到就强连（移动端有卡墙脱困兜底）
      var best = bestClear || bestAny;
      if (!best) return;
      addEdge(nodes, best.i, best.j);
    }
  }

  Bot.prototype._nearestNode = function (pos) {
    var g = this._graph;
    if (!g || !g.nodes.length) return -1;
    var now = this._time;
    // 轻微的最近点缓存（0.25s），避免每帧全量扫描；A* 只在重算时跑
    if (this._nearestCache >= 0 && now - this._nearestCacheTime < 0.25) {
      var cached = g.nodes[this._nearestCache];
      if (cached && hypot2(cached.x - pos[0], cached.z - pos[2]) < 6) return this._nearestCache;
    }
    var best = -1, bestD = Infinity;
    var nodes = g.nodes;
    for (var i = 0; i < nodes.length; i++) {
      var dx = nodes[i].x - pos[0], dz = nodes[i].z - pos[2];
      var d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    this._nearestCache = best;
    this._nearestCacheTime = now;
    return best;
  };

  Bot.prototype._astar = function (start, goal) {
    var g = this._graph;
    if (!g || start < 0 || goal < 0) return null;
    var nodes = g.nodes;
    var n = nodes.length;
    if (start === goal) return [goal];

    var gScore = new Array(n);
    var fScore = new Array(n);
    var came = new Array(n);
    var closed = new Array(n);
    var inOpen = new Array(n);
    for (var i = 0; i < n; i++) {
      gScore[i] = Infinity;
      fScore[i] = Infinity;
      came[i] = -1;
      closed[i] = false;
      inOpen[i] = false;
    }
    function h(a, b) {
      return hypot2(nodes[a].x - nodes[b].x, nodes[a].z - nodes[b].z);
    }
    var open = [start];
    inOpen[start] = true;
    gScore[start] = 0;
    fScore[start] = h(start, goal);
    var guard = 0;
    while (open.length && guard++ < n * 10) {
      var bi = 0;
      for (i = 1; i < open.length; i++) if (fScore[open[i]] < fScore[open[bi]]) bi = i;
      var cur = open[bi];
      open.splice(bi, 1);
      inOpen[cur] = false;
      if (cur === goal) {
        var path = [cur];
        while (came[cur] >= 0) { cur = came[cur]; path.push(cur); }
        path.reverse();
        return path;
      }
      closed[cur] = true;
      var nbs = nodes[cur].neighbors;
      for (i = 0; i < nbs.length; i++) {
        var nb = nbs[i];
        if (closed[nb.i]) continue;
        var tentative = gScore[cur] + nb.d;
        if (tentative < gScore[nb.i]) {
          came[nb.i] = cur;
          gScore[nb.i] = tentative;
          fScore[nb.i] = tentative + h(nb.i, goal);
          if (!inOpen[nb.i]) { open.push(nb.i); inOpen[nb.i] = true; }
        }
      }
    }
    return null;
  };

  Bot.prototype._findPath = function (ctx, goalNode) {
    var g = this._graph;
    if (!g || goalNode < 0) return null;
    var startNode = this._nearestNode(this.pos);
    if (startNode < 0) return null;
    var raw = this._astar(startNode, goalNode);
    if (!raw || !raw.length) return null;

    // 单次“拉绳”平滑：能从当前点直接看到更远的节点就跳过中间点
    var out = [];
    var prevPos = [this.pos[0], this.pos[1] + 0.9, this.pos[2]];
    var begin = 0;
    if (raw.length > 2) {
      var n1 = g.nodes[raw[1]];
      if (this._segmentClear(ctx, prevPos, [n1.x, n1.y + 0.9, n1.z])) begin = 1;
    }
    for (var i = begin; i < raw.length; i++) {
      if (i < raw.length - 1) {
        var next = g.nodes[raw[i + 1]];
        if (this._segmentClear(ctx, prevPos, [next.x, next.y + 0.9, next.z])) continue;
      }
      out.push(raw[i]);
      var nd = g.nodes[raw[i]];
      prevPos = [nd.x, nd.y + 0.9, nd.z];
    }
    if (!out.length) out.push(raw[raw.length - 1]);
    return out;
  };

  // 沿缓存路径移动；返回 true 表示已到达
  Bot.prototype._moveTo = function (ctx, goalPos, speed, plan, forceRepath, movingGoal) {
    var g = this._graph;
    var now = this._time;
    var arriveDist = isNum(plan.arriveDist) ? plan.arriveDist : 0.9;
    var goalDist = 0;

    if (!goalPos) {
      plan.wish[0] = 0;
      plan.wish[1] = 0;
      return true;
    }

    goalDist = hypot2(goalPos[0] - this.pos[0], goalPos[2] - this.pos[2]);
    if (goalDist < arriveDist) {
      plan.wish[0] = 0;
      plan.wish[1] = 0;
      plan.speed = 0;
      return true;
    }

    if (!g || !g.nodes.length) {
      plan.wish[0] = (goalPos[0] - this.pos[0]) / goalDist;
      plan.wish[1] = (goalPos[2] - this.pos[2]) / goalDist;
      plan.speed = speed;
      return false;
    }

    var goalNode = this._nearestNode(goalPos);

    // 寻路失败冷却：避免 A* 每帧重试
    if (!forceRepath && this._pathFailGoal === goalNode && now < this._pathFailUntil) {
      plan.wish[0] = (goalPos[0] - this.pos[0]) / goalDist;
      plan.wish[1] = (goalPos[2] - this.pos[2]) / goalDist;
      plan.speed = speed;
      return false;
    }

    var need = forceRepath || !this._path || this._path.length === 0 || this._pathGoal !== goalNode ||
      this._pathIdx >= this._path.length ||
      (movingGoal && now - this._pathTime > 1.0);

    if (need) {
      var path = this._findPath(ctx, goalNode);
      this._path = path || [];
      this._pathGoal = goalNode;
      this._pathIdx = 0;
      this._pathTime = now;
      if (!path) {
        this._pathFailGoal = goalNode;
        this._pathFailUntil = now + 1.0;
        plan.wish[0] = (goalPos[0] - this.pos[0]) / goalDist;
        plan.wish[1] = (goalPos[2] - this.pos[2]) / goalDist;
        plan.speed = speed;
        return false;
      }
    }

    var guard = 0;
    while (this._pathIdx < this._path.length && guard++ < 200) {
      var node = g.nodes[this._path[this._pathIdx]];
      if (!node) { this._pathIdx++; continue; }
      var dx = node.x - this.pos[0], dz = node.z - this.pos[2];
      var dl = hypot2(dx, dz);
      if (dl < 0.85) { this._pathIdx++; continue; }
      plan.wish[0] = dx / dl;
      plan.wish[1] = dz / dl;
      plan.speed = speed;
      return false;
    }

    plan.wish[0] = 0;
    plan.wish[1] = 0;
    plan.speed = 0;
    return true;
  };

  /* ---------------------------------------------------------------- 掩体 */

  // 找 cover>0.5 且能挡住玩家视线的 waypoint（最多 8 次 LOS）
  Bot.prototype._pickCover = function (ctx, sen) {
    var g = this._graph;
    if (!g || !g.nodes.length) return false;
    var nodes = g.nodes;
    var ppos = sen && sen.ppos;
    var candidates = [];
    var i;

    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.cover < 0.55) continue;
      var db = hypot2(n.x - this.pos[0], n.z - this.pos[2]);
      if (db < 2.5 || db > 20) continue;
      if (ppos) {
        var dp = hypot2(n.x - ppos[0], n.z - ppos[2]);
        if (dp < 5.5) continue; // 不要往敌人脸上跑
      }
      candidates.push({ idx: i, p: [n.x, n.y, n.z], cover: n.cover, dist: db });
    }
    if (!candidates.length) return false;

    candidates.sort(function (a, b) {
      return (b.cover * 3 - b.dist * 0.08) - (a.cover * 3 - a.dist * 0.08);
    });

    var fallback = null;
    var checked = 0;
    var pe = null;
    if (ppos && sen) {
      pe = (sen.eyeP && isVec3(sen.eyeP)) ? sen.eyeP : [ppos[0], ppos[1] + STAND_EYE, ppos[2]];
    }

    for (i = 0; i < candidates.length && checked < 8; i++) {
      var c = candidates[i];
      checked++;
      if (!fallback) fallback = c;
      if (!pe) { this._coverTarget = c; return true; }
      var coverEye = [c.p[0], c.p[1] + 1.2, c.p[2]];
      if (!safeLos(ctx, pe, coverEye)) {
        this._coverTarget = c;
        return true;
      }
    }
    if (fallback) {
      this._coverTarget = fallback;
      return true;
    }
    return false;
  };

  /* ======================================================================
   * 对外导出
   * ==================================================================== */

  function create(difficultyId, opts) {
    return new Bot(difficultyId, opts);
  }

  GAME.Bot = {
    VERSION: '1.0.0',
    DIFFICULTIES: DIFFICULTIES,
    DIFF_IDS: DIFF_IDS,
    create: create
  };
})();
