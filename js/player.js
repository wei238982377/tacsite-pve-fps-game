/* ============================================================
   AI GAME · 沙漠对决 — 玩家：移动 / 相机 / 武器状态机
   所有事件通过 update() 返回给 game.js 处理（音效/伤害/特效）。
   ============================================================ */
"use strict";
(function () {
  var G = window.GAME = window.GAME || {};
  var M = G.M;

  var WEAPON_IDS = ['deagle', 'awm', 'ak47'];

  /* ---------------- 移动手感参数（CS 风格：低速 + 惯性） ----------------
     原版本基础速度 5.7 m/s。现在约 36%（≈2.05 m/s），
     同时降低加速度、降低摩擦，让起步 / 急停更慢、更有“沉重感”。
     想整体调快/调慢只需要改这里的 baseSpeed；加速度/摩擦在下方地面移动中生效。 */
  var MOVE = {
    baseSpeed: 2.05,          // 原 5.7
    walkSpeed: 1.15,          // 原 2.7
    crouchSpeed: 1.25,        // 原 2.9
    scopedSpeedFactor: 0.42,  // 开镜移动更慢
    groundAccel: 9.0,         // 原 60：越小起步越“重”
    airAccel: 5.0,            // 原 18：空中控制更弱
    friction: 2.6,            // 原 6：越小停得越慢、惯性越明显
    lookBase: 0.0022          // 鼠标转向基础系数（再乘设置里的灵敏度）
  };

  function makeWeaponState(def) {
    return { ammo: def.mag, reserve: def.reserve };
  }

  function create() {
    var defs = G.Weapons.defs;
    var p = {
      pos: [0, 0, 0],
      vel: [0, 0, 0],
      health: 100,
      alive: true,
      yaw: 0,
      pitch: 0,
      viewRecoilPitch: 0,
      viewRecoilYaw: 0,
      recoilKickPitch: 0,
      recoilKickYaw: 0,
      recoilKickBack: 0,
      weaponId: 'ak47',
      weapon: null,
      ammoStates: {},
      reloading: false,
      reloadT: 0,
      reloadDur: 0,
      equipT: 1,
      equipDur: 0,
      scoped: false,
      scopeT: 0,
      boltT: 0,
      boltDur: 0,
      nextFire: 0,
      shotSpread: 0,
      shotCount: 0,
      lastShotTime: -10,
      firing: false,
      triggerPrev: false,
      moving: false,
      speed: 0,
      walkPhase: 0,
      bobX: 0,
      bobY: 0,
      swayX: 0,
      swayY: 0,
      viewDip: 0,
      footAccum: 0,
      wasOnGround: false,
      crouch: 0,
      scopeFov: 90,
      spawnProtection: 0,
      deathT: 0,
      hurtT: 0,
      events: [],
      actor: null,
      lastGroundMat: 'sand'
    };
    for (var i = 0; i < WEAPON_IDS.length; i++) {
      p.ammoStates[WEAPON_IDS[i]] = makeWeaponState(defs[WEAPON_IDS[i]]);
    }
    p.actor = G.Physics.createActor([0, 0, 0], { radius: 0.34, height: 1.8 });
    p.pos = p.actor.pos;
    p.vel = p.actor.vel;
    p.weapon = defs[p.weaponId];
    return p;
  }

  function selectWeapon(p, id, instant) {
    var defs = G.Weapons.defs;
    if (!defs[id]) return false;
    if (p.weaponId === id) return false;
    p.weaponId = id;
    p.weapon = defs[id];
    p.reloading = false;
    p.reloadT = 0;
    p.scoped = false;
    p.scopeT = 0;
    p.boltT = 0;
    p.shotSpread = 0;
    p.shotCount = 0;
    p.events.push({ type: 'equip', weaponId: id });
    if (instant) {
      p.equipT = 1;
    } else {
      p.equipT = 0;
      p.equipDur = defs[id].equipTime;
    }
    return true;
  }

  function reset(p, spawn) {
    p.health = 100;
    p.alive = true;
    p.deathT = 0;
    p.hurtT = 0;
    p.yaw = spawn.yaw || 0;
    p.pitch = 0;
    p.viewRecoilPitch = 0;
    p.viewRecoilYaw = 0;
    p.recoilKickPitch = 0;
    p.recoilKickYaw = 0;
    p.recoilKickBack = 0;
    p.reloading = false;
    p.reloadT = 0;
    p.scoped = false;
    p.scopeT = 0;
    p.boltT = 0;
    p.nextFire = 0;
    p.shotSpread = 0;
    p.shotCount = 0;
    p.lastShotTime = -10;
    p.firing = false;
    p.triggerPrev = false;
    p.footAccum = 0;
    p.viewDip = 0;
    p.crouch = 0;
    p.wasOnGround = false;
    p.actor.onGround = false;
    p.actor.crouch = 0;
    p.actor.height = 1.8;
    p.actor.eyeHeight = 1.65;
    var defs = G.Weapons.defs;
    for (var i = 0; i < WEAPON_IDS.length; i++) {
      var w = WEAPON_IDS[i];
      p.ammoStates[w].ammo = defs[w].mag;
      p.ammoStates[w].reserve = defs[w].reserve;
    }
    if (p.weaponId !== 'ak47') selectWeapon(p, 'ak47', true);
    p.weapon = defs[p.weaponId];
    p.equipT = 1;
    G.Physics.teleport(p.actor, spawn.pos);
    p.pos = p.actor.pos;
    p.vel = p.actor.vel;
    p.spawnProtection = 1.6;
    p.events.length = 0;
    p.eyeHeight = 1.65;
  }

  function eyePos(p, out) {
    out = out || [0, 0, 0];
    out[0] = p.pos[0];
    out[1] = p.pos[1] + (p.actor.eyeHeight || 1.65);
    out[2] = p.pos[2];
    return out;
  }

  function addViewKick(p, def, patternExtra) {
    p.recoilKickPitch += (def.recoil.up + patternExtra) * M.DEG;
    p.recoilKickYaw += (Math.random() * 2 - 1) * def.recoil.side * M.DEG;
    p.recoilKickBack += def.recoil.kick * 0.01;
    p.viewRecoilPitch += (def.recoil.up + patternExtra) * M.DEG;
    p.viewRecoilYaw += (Math.random() * 2 - 1) * def.recoil.side * M.DEG;
  }

  function startReload(p) {
    var def = p.weapon;
    var st = p.ammoStates[p.weaponId];
    if (p.reloading || !p.alive) return;
    if (st.ammo >= def.mag) return;
    if (st.reserve <= 0) {
      p.events.push({ type: 'dryFire', weaponId: p.weaponId });
      return;
    }
    p.reloading = true;
    p.reloadT = 0;
    p.reloadDur = def.reloadTime;
    p.events.push({ type: 'reloadStart', weaponId: p.weaponId, duration: def.reloadTime });
  }

  function finishReload(p) {
    var def = p.weapon;
    var st = p.ammoStates[p.weaponId];
    var need = def.mag - st.ammo;
    var take = Math.min(need, st.reserve);
    st.ammo += take;
    st.reserve -= take;
    p.reloading = false;
    p.reloadT = 0;
    p.events.push({ type: 'reloadEnd', weaponId: p.weaponId, loaded: take });
  }

  function canFire(p) {
    var def = p.weapon;
    var st = p.ammoStates[p.weaponId];
    if (!p.alive) return false;
    if (p.equipT < 1) return false;
    if (p.reloading) return false;
    if (p.boltT > 0) return false;
    if (p.nextFire > 0) return false;
    if (st.ammo <= 0) return false;
    return true;
  }

  function fire(p, world) {
    var def = p.weapon;
    var st = p.ammoStates[p.weaponId];
    st.ammo--;
    p.nextFire = 60 / def.rpm;
    p.lastShotTime = 0;
    p.firing = true;
    p.shotCount++;
    var patternExtra = 0;
    if (def.sprayPattern) {
      patternExtra = def.sprayPattern[Math.min(p.shotCount, def.sprayPattern.length - 1)] * 0.22;
    }

    // 关键顺序：先按“扣扳机瞬间”的视角生成弹道，再应用本发后坐力。
    // 这样子弹方向与当前准星/镜头完全一致（AWM 开镜第一发不会因为本发后坐力而抬高）。
    var viewPitch = p.pitch + p.viewRecoilPitch;
    var viewYaw = p.yaw + p.viewRecoilYaw;
    var dir = M.forwardFrom(viewYaw, viewPitch, [0, 0, 0]);

    var speed = Math.sqrt(p.vel[0] * p.vel[0] + p.vel[2] * p.vel[2]);
    var spread = G.Weapons.currentSpread(def, {
      crouch: p.actor.crouch > 0.5,
      speed: speed,
      air: !p.actor.onGround,
      shotSpread: p.shotSpread
    });
    // AWM：完全开镜时散布严格为 0（子弹 100% 落在准星中心，指哪打哪）；
    // 腰射保留大散布，移动/跳跃时更差。其它武器不允许开镜，不受此分支影响。
    if (def.scope) {
      if (p.scoped && p.scopeT >= 0.98) {
        spread = 0;
      } else {
        var hipFactor = p.scoped ? Math.max(0, 1 - p.scopeT) : 1;
        var movePenalty = speed * 3.0 + (p.actor.onGround ? 0 : 6.0);
        spread = (def.hipSpreadDeg + 8.0) * hipFactor + movePenalty + p.shotSpread;
      }
    }
    p.lastSpreadDeg = spread;

    // 再应用后坐力与连发扩散（作用于镜头和后续子弹）
    addViewKick(p, def, patternExtra);
    p.shotSpread = Math.min(def.spreadDeg.max, p.shotSpread + def.spreadDeg.perShot);

    if (def.boltTime > 0) {
      p.boltT = 0.0001;
      p.boltDur = def.boltTime;
    }
    var eye = eyePos(p);
    p.events.push({
      type: 'fire',
      weaponId: p.weaponId,
      origin: [eye[0], eye[1], eye[2]],
      dir: dir,
      spreadDeg: spread,
      ammoLeft: st.ammo
    });
    return true;
  }

  function takeDamage(p, amount, dir) {
    if (!p.alive || p.spawnProtection > 0) return { dead: false, applied: 0 };
    var dealt = Math.min(p.health, amount);
    p.health -= dealt;
    p.hurtT = 0.35;
    p.events.push({ type: 'hurt', amount: dealt, dir: dir ? [dir[0], dir[1], dir[2]] : null });
    if (p.health <= 0) {
      p.health = 0;
      p.alive = false;
      p.deathT = 0;
      p.reloading = false;
      p.scoped = false;
      p.scopeT = 0;
      p.events.push({ type: 'death' });
      return { dead: true, applied: dealt };
    }
    return { dead: false, applied: dealt };
  }

  function update(p, dt, input, world) {
    p.events.length = 0;
    p.hurtT = Math.max(0, p.hurtT - dt);
    p.spawnProtection = Math.max(0, p.spawnProtection - dt);
    p.lastShotTime += dt;
    if (!p.alive) {
      p.deathT += dt;
      p.viewDip = Math.min(1.2, p.viewDip + dt * 2.4);
      return p.events;
    }

    // 计时器
    if (p.nextFire > 0) p.nextFire = Math.max(0, p.nextFire - dt);
    if (p.boltT > 0) {
      p.boltT += dt / p.boltDur;
      if (p.boltT >= 1) p.boltT = 0;
    }
    if (p.reloading) {
      p.reloadT += dt;
      if (p.reloadT >= p.reloadDur) finishReload(p);
    }
    if (p.equipT < 1) {
      p.equipT = Math.min(1, p.equipT + dt / Math.max(0.01, p.equipDur));
    }
    // 后坐力恢复
    p.recoilKickPitch += (0 - p.recoilKickPitch) * Math.min(1, dt * 12);
    p.recoilKickYaw += (0 - p.recoilKickYaw) * Math.min(1, dt * 12);
    p.recoilKickBack += (0 - p.recoilKickBack) * Math.min(1, dt * 14);
    var recentFire = p.lastShotTime < 0.28;
    var recoverPitch = (recentFire ? p.weapon.recoil.recover * 0.16 : p.weapon.recoil.recover) * M.DEG * dt;
    var recoverYaw = (recentFire ? p.weapon.recoil.recover * 0.05 : p.weapon.recoil.recover * 0.6) * M.DEG * dt;
    if (p.viewRecoilPitch > 0) p.viewRecoilPitch = Math.max(0, p.viewRecoilPitch - recoverPitch);
    else if (p.viewRecoilPitch < 0) p.viewRecoilPitch = Math.min(0, p.viewRecoilPitch + recoverPitch);
    if (p.viewRecoilYaw > 0) p.viewRecoilYaw = Math.max(0, p.viewRecoilYaw - recoverYaw);
    else p.viewRecoilYaw = Math.min(0, p.viewRecoilYaw + recoverYaw);
    if (!recentFire) p.shotCount = 0;
    p.shotSpread = Math.max(0, p.shotSpread - p.weapon.spreadDeg.recover * dt);

    // 鼠标转向：灵敏度来自设置面板（settings.sens → input.sens），实时生效
    var userSens = (typeof input.sens === 'number' && isFinite(input.sens)) ? input.sens : 1.0;
    var sens = M.clamp(userSens, 0.1, 3.0) * MOVE.lookBase;
    var zoomSens = p.scoped ? 0.42 : 1;
    p.yaw -= (input.mouseDX || 0) * sens * zoomSens;
    p.pitch -= (input.mouseDY || 0) * sens * zoomSens;
    p.yaw = M.wrapAngle(p.yaw);
    p.pitch = M.clamp(p.pitch, -1.53, 1.53);
    p.swayX += ((input.mouseDX || 0) * -0.6 - p.swayX) * Math.min(1, dt * 8);
    p.swayY += ((input.mouseDY || 0) * -0.6 - p.swayY) * Math.min(1, dt * 8);

    // 武器切换
    if (input.switchTo && input.switchTo !== p.weaponId) {
      selectWeapon(p, input.switchTo, false);
    }
    // 换弹
    if (input.reloadPressed) startReload(p);
    // 开镜
    if (input.scopePressed && p.weapon.scope) {
      if (p.boltT <= 0 && p.equipT >= 1) {
        p.scoped = !p.scoped;
        p.events.push({ type: p.scoped ? 'scopeIn' : 'scopeOut' });
      }
    } else if (!p.weapon.scope) {
      p.scoped = false;
    }
    if (p.scoped) p.scopeT = Math.min(1, p.scopeT + dt / 0.22);
    else p.scopeT = Math.max(0, p.scopeT - dt / 0.16);

    // 移动（CS 风格低速 + 惯性；参数集中在 MOVE）
    var speed = MOVE.baseSpeed;
    if (input.walk) speed = MOVE.walkSpeed;
    if (input.crouch) speed = MOVE.crouchSpeed;
    if (p.scoped) speed *= MOVE.scopedSpeedFactor;
    if (p.actor.crouch > 0.5 && !input.crouch) speed = MOVE.crouchSpeed;
    var fwd = 0, strafe = 0;
    if (input.forward) fwd += 1;
    if (input.back) fwd -= 1;
    if (input.right) strafe += 1;
    if (input.left) strafe -= 1;
    var wish = [0, 0, 0];
    if (fwd !== 0 || strafe !== 0) {
      var sinY = Math.sin(p.yaw), cosY = Math.cos(p.yaw);
      wish[0] = -sinY * fwd + cosY * strafe;
      wish[2] = -cosY * fwd - sinY * strafe;
      var wl = Math.sqrt(wish[0] * wish[0] + wish[2] * wish[2]);
      wish[0] /= wl; wish[2] /= wl;
    }
    // 开镜时禁止跳
    var wantJump = input.jump && !p.scoped;
    var wasGround = p.actor.onGround;
    world.physics.moveActor(p.actor, dt, wish, speed, {
      jump: wantJump,
      crouch: !!input.crouch,
      walk: !!input.walk,
      accel: MOVE.groundAccel,
      airAccel: MOVE.airAccel,
      friction: MOVE.friction
    });
    p.pos = p.actor.pos;
    p.vel = p.actor.vel;
    var hspeed = Math.sqrt(p.vel[0] * p.vel[0] + p.vel[2] * p.vel[2]);
    p.speed = hspeed;
    p.moving = hspeed > 0.35;
    p.crouch = p.actor.crouch;
    p.eyeHeight = p.actor.eyeHeight;

    // 落地
    if (p.actor.onGround && !p.wasOnGround && p.vel[1] <= 0.1) {
      p.viewDip = Math.min(0.14, Math.abs(p.lastFallSpeed || 0) * 0.012 + 0.05);
      p.events.push({ type: 'land' });
    }
    p.wasOnGround = p.actor.onGround;
    p.lastFallSpeed = p.vel[1];
    p.viewDip += (0 - p.viewDip) * Math.min(1, dt * 9);
    if (p.viewDip < 0.001) p.viewDip = 0;

    // 走路视角晃动 + 脚步声（低速时步伐更沉、更慢）
    var bobAmp = p.moving && p.actor.onGround ? (input.walk ? 0.010 : 0.020) : 0;
    if (p.scoped) bobAmp *= 0.25;
    p.walkPhase += dt * (p.moving ? (input.walk ? Math.max(3.4, hspeed * 2.8) : Math.max(5.0, hspeed * 3.4)) : 0);
    p.bobX = Math.sin(p.walkPhase) * bobAmp;
    p.bobY = Math.abs(Math.cos(p.walkPhase)) * bobAmp * 1.2;
    if (p.moving && p.actor.onGround) {
      p.footAccum += hspeed * dt;
      var stride = input.walk ? 1.2 : 1.35;
      if (p.footAccum >= stride) {
        p.footAccum -= stride;
        var surface = 'sand';
        var hit = world.engine.worldRaycast([p.pos[0], p.pos[1] + 0.4, p.pos[2]], [0, -1, 0], 3);
        if (hit && hit.hit) {
          var map = { sand: 'sand', wall: 'concrete', brick: 'stone', crate: 'wood', metal: 'metal', concrete: 'concrete', stone: 'stone', tarp: 'sand', wood: 'wood', roof: 'wood' };
          surface = map[hit.material] || 'sand';
        }
        p.events.push({ type: 'footstep', surface: surface, loud: !input.walk });
      }
    } else {
      p.footAccum = 0;
    }
    if (wantJump && wasGround) p.events.push({ type: 'jump' });

    // 开火
    var wantFire = !!input.fire;
    var edge = wantFire && !p.triggerPrev;
    p.triggerPrev = wantFire;
    if (canFire(p)) {
      if (p.weapon.auto ? wantFire : edge) {
        fire(p, world);
      } else if (edge && p.ammoStates[p.weaponId].ammo <= 0) {
        p.events.push({ type: 'dryFire', weaponId: p.weaponId });
      }
    }
    if (p.reloading && p.weapon.auto === false && wantFire) { /* 换弹中按键无效 */ }
    // 开火中持续扩散恢复延迟
    p.firing = wantFire;

    if (p.health > 0 && p.health <= 30) p.lowHp = true; else p.lowHp = false;
    return p.events;
  }

  G.Player = {
    create: create,
    reset: reset,
    update: update,
    eyePos: eyePos,
    takeDamage: takeDamage,
    selectWeapon: selectWeapon,
    canFire: canFire,
    startReload: startReload
  };
})();
