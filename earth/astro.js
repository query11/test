// 天文计算：时间尺度、地球自转、太阳与月球位置、节气、日月食搜索。
// 纯函数，不依赖浏览器，页面和 Node 测试共用（tests/earth-astro.test.js）。
//
// 坐标约定
//   黄道坐标（J2000）：x 指向春分点，z 指向黄北极。场景里的世界坐标就是它，
//   只是换成 three.js 的 y 朝上：world = (x, z, -y)。
//   赤道坐标（J2000）：x 指向春分点，z 指向北天极，与黄道坐标绕 x 轴相差黄赤交角 ε。
//   地固坐标：x 指向经度 0°、纬度 0°，y 指向东经 90°，z 指向北极；绕赤道 z 轴转过
//   地球自转角 ERA 得到赤道坐标。
//
// 参考
//   地球自转角：IAU 2000 决议 B1.8，ERA = 2π(0.7790572732640 + 1.00273781191135448·Du)
//   格林尼治平恒星时：IAU 1982（Aoki 等）
//   太阳：《天文年历》低精度公式，约 0.01°
//   月球：Meeus《天文算法》第 47 章（ELP-2000/82 的主要周期项），约 10″
(function (root) {
  'use strict';

  const DEG = Math.PI / 180;
  const RAD = 180 / Math.PI;
  const J2000 = 2451545.0;
  const DAY_MS = 86400000;

  const R_EARTH_KM = 6371.0; // 平均半径；赤道 6378.137，极 6356.752
  const R_EQUATOR_KM = 6378.137;
  const FLATTENING = 1 / 298.257223563; // WGS-84 扁率
  const R_MOON_KM = 1737.4;
  const R_SUN_KM = 695700;
  const AU_KM = 149597870.7;
  const SIDEREAL_DAY_S = 86164.0905; // 恒星日 23h56m04.0905s
  const SYNODIC_MONTH_D = 29.530588853; // 朔望月
  const DELTA_T_S = 69.2; // ΔT = TT − UT1，2025 年前后

  const mod = (x, m) => ((x % m) + m) % m;
  const wrap180 = (d) => mod(d + 180, 360) - 180;
  const sind = (d) => Math.sin(d * DEG);
  const cosd = (d) => Math.cos(d * DEG);

  const jdFromMs = (ms) => ms / DAY_MS + 2440587.5;
  const msFromJd = (jd) => (jd - 2440587.5) * DAY_MS;
  const jdTT = (jdUT) => jdUT + DELTA_T_S / 86400;

  // 地球自转角（弧度），以 J2000 赤道坐标为准
  function earthRotationAngle(jdUT) {
    const du = jdUT - J2000;
    // 1.00273781191135448·Du = Du + 0.00273781191135448·Du，整天数转整圈，只留小数部分
    const f = 0.779057273264 + 0.00273781191135448 * du + mod(du, 1);
    return mod(f, 1) * 2 * Math.PI;
  }

  // 格林尼治平恒星时（度）
  function gmstDeg(jdUT) {
    const du = jdUT - J2000;
    const T = du / 36525;
    return mod(280.46061837 + 360.98564736629 * du + 0.000387933 * T * T - (T * T * T) / 38710000, 360);
  }

  // 平黄赤交角（度），IAU 1980
  function obliquityDeg(T) {
    return 23.439291111 - 0.0130041667 * T - 1.6389e-7 * T * T + 5.0361e-7 * T * T * T;
  }

  // 黄经总岁差（度），把当日分点的黄经归算到 J2000
  const precessionDeg = (T) => 1.396971 * T + 0.0003086 * T * T;

  // 太阳（地心视位置，当日真分点）：Meeus 第 25 章低精度法，约 0.01°
  function sun(jdUT) {
    const T = (jdTT(jdUT) - J2000) / 36525;
    const L0 = mod(280.46646 + 36000.76983 * T + 0.0003032 * T * T, 360); // 几何平黄经
    const M = mod(357.52911 + 35999.05029 * T - 0.0001537 * T * T, 360); // 平近点角
    const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T; // 地球轨道偏心率
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sind(M) + (0.019993 - 0.000101 * T) * sind(2 * M) + 0.000289 * sind(3 * M);
    const nu = M + C; // 真近点角
    const omega = 125.04 - 1934.136 * T; // 月球升交点黄经，用于章动
    const lambda = mod(L0 + C - 0.00569 - 0.00478 * sind(omega), 360); // 加光行差与章动
    const distAU = (1.000001018 * (1 - e * e)) / (1 + e * cosd(nu));
    const eps = obliquityDeg(T) + 0.00256 * cosd(omega);
    const ra = mod(Math.atan2(cosd(eps) * sind(lambda), cosd(lambda)) * RAD, 360);
    const dec = Math.asin(sind(eps) * sind(lambda)) * RAD;
    const eotMin = 4 * wrap180(L0 - 0.0057183 - ra); // 均时差 = 视太阳时 − 平太阳时
    return { lambda, lambdaJ2000: mod(lambda - precessionDeg(T), 360), distAU, ra, dec, eps, eotMin, meanAnomaly: M };
  }

  // 月球：Meeus 表 47.A / 47.B 的主要项（D, M, M′, F 的系数，Σl 与 Σr）
  const MOON_LR = [
    [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
    [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
    [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
    [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
    [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
    [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
    [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
    [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
    [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403],
    [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
    [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884], [0, 1, 2, 0, -2120, 5751],
    [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
    [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0],
    [3, 0, -1, 0, -892, 3258], [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
    [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354], [2, 1, -2, 0, 691, 0],
    [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
    [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0],
    [0, 0, 2, -2, -381, -4421], [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0],
    [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0], [0, 2, 1, 0, -323, 1165],
    [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752],
  ];
  const MOON_B = [
    [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
    [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
    [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
    [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
    [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
    [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
    [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107],
    [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833], [0, 0, 1, -3, 777], [4, 0, -2, 1, 671],
    [2, 0, 0, -3, 607], [2, 0, 2, -1, 596], [2, -1, 1, -1, 491], [2, 0, -2, 1, -451],
    [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421], [2, 1, -1, 1, -366],
    [2, 1, 0, 1, -351], [4, 0, 0, 1, 331], [2, -1, 1, 1, 315], [2, -2, 0, -1, 302],
    [0, 0, 1, 3, -283], [2, 1, 1, -1, -229], [1, 1, 0, -1, 223], [1, 1, 0, 1, 223],
    [0, 1, -2, -1, -220], [2, 1, -1, -1, -220], [1, 0, 1, 1, -185], [2, -1, -2, -1, 181],
    [0, 1, 2, 1, -177], [4, 0, -2, -1, 176], [4, -1, -1, -1, 166], [1, 0, 1, -1, -164],
    [4, 0, 1, -1, 132], [1, 0, -1, -1, -119], [4, -1, 0, -1, 115], [2, -2, 0, 1, 107],
  ];

  function moon(jdUT) {
    const T = (jdTT(jdUT) - J2000) / 36525;
    const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
    const Lp = mod(218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000, 360);
    const D = mod(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000, 360);
    const M = mod(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000, 360);
    const Mp = mod(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000, 360);
    const F = mod(93.272095 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000, 360);
    const A1 = mod(119.75 + 131.849 * T, 360);
    const A2 = mod(53.09 + 479264.29 * T, 360);
    const A3 = mod(313.45 + 481266.484 * T, 360);
    const E = 1 - 0.002516 * T - 0.0000074 * T2;
    let sl = 0, sr = 0, sb = 0;
    for (const [d, m, mp, f, l, r] of MOON_LR) {
      const arg = d * D + m * M + mp * Mp + f * F;
      const e = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
      sl += l * e * sind(arg);
      sr += r * e * cosd(arg);
    }
    for (const [d, m, mp, f, b] of MOON_B) {
      const e = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
      sb += b * e * sind(d * D + m * M + mp * Mp + f * F);
    }
    sl += 3958 * sind(A1) + 1962 * sind(Lp - F) + 318 * sind(A2);
    sb += -2235 * sind(Lp) + 382 * sind(A3) + 175 * sind(A1 - F) + 175 * sind(A1 + F) + 127 * sind(Lp - Mp) - 115 * sind(Lp + Mp);
    const lambda = mod(Lp + sl / 1e6, 360);
    const beta = sb / 1e6;
    const distKm = 385000.56 + sr / 1000;
    return { lambda, lambdaJ2000: mod(lambda - precessionDeg(T), 360), beta, distKm };
  }

  // 黄道球坐标 → 黄道直角坐标
  function eclVec(lonDeg, latDeg, r = 1) {
    const cl = cosd(latDeg);
    return [r * cl * cosd(lonDeg), r * cl * sind(lonDeg), r * sind(latDeg)];
  }

  // 黄道（J2000）→ 赤道（J2000）
  const EPS_J2000 = 23.4392911;
  function eclToEq(v, epsDeg = EPS_J2000) {
    const c = cosd(epsDeg), s = sind(epsDeg);
    return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
  }
  // 赤道（J2000）→ 地固坐标
  function eqToBody(v, era) {
    const c = Math.cos(era), s = Math.sin(era);
    return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
  }
  function latLon(v) {
    const r = Math.hypot(v[0], v[1], v[2]);
    return { lat: Math.asin(v[2] / r) * RAD, lon: wrap180(Math.atan2(v[1], v[0]) * RAD) };
  }

  // 某一时刻的日月几何（J2000 黄道直角坐标，单位：地球半径）
  function geometry(ms) {
    const jd = jdFromMs(ms);
    const s = sun(jd);
    const m = moon(jd);
    const sunDist = (s.distAU * AU_KM) / R_EARTH_KM;
    const sunDir = eclVec(s.lambdaJ2000, 0);
    const moonPos = eclVec(m.lambdaJ2000, m.beta, m.distKm / R_EARTH_KM);
    return { jd, sun: s, moon: m, sunDir, sunDist, moonPos, era: earthRotationAngle(jd) };
  }

  // 月相：日月黄经差（0 朔，180 望）、被照亮比例、月龄
  function moonPhase(ms) {
    const g = geometry(ms);
    const elong = mod(g.moon.lambda - g.sun.lambda, 360);
    const m = g.moonPos, s = g.sunDir;
    const r = Math.hypot(m[0], m[1], m[2]);
    // 月面相位角：太阳—月球—地球的夹角
    const toSun = [s[0] * g.sunDist - m[0], s[1] * g.sunDist - m[1], s[2] * g.sunDist - m[2]];
    const ts = Math.hypot(...toSun);
    const cosI = -(toSun[0] * m[0] + toSun[1] * m[1] + toSun[2] * m[2]) / (ts * r);
    const illum = (1 + cosI) / 2;
    return { elong, illum, age: (elong / 360) * SYNODIC_MONTH_D };
  }

  const PHASE_NAMES = ['新月', '蛾眉月', '上弦月', '盈凸月', '满月', '亏凸月', '下弦月', '残月'];
  function phaseName(elong) {
    if (elong < 6 || elong >= 354) return PHASE_NAMES[0];
    if (elong < 84) return PHASE_NAMES[1];
    if (elong < 96) return PHASE_NAMES[2];
    if (elong < 174) return PHASE_NAMES[3];
    if (elong < 186) return PHASE_NAMES[4];
    if (elong < 264) return PHASE_NAMES[5];
    if (elong < 276) return PHASE_NAMES[6];
    return PHASE_NAMES[7];
  }

  // 二十四节气：太阳视黄经每 15° 一个，春分为 0°
  const SOLAR_TERMS = [
    '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露',
    '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至', '小寒', '大寒', '立春', '雨水', '惊蛰',
  ];

  // 太阳视黄经到达 targetDeg 的时刻（从 ms 往后找），牛顿迭代
  function nextSunLongitude(ms, targetDeg) {
    let t = ms + (mod(targetDeg - sun(jdFromMs(ms)).lambda, 360) / 0.98564736) * DAY_MS;
    for (let i = 0; i < 6; i++) {
      const d = wrap180(targetDeg - sun(jdFromMs(t)).lambda);
      t += (d / 0.98564736) * DAY_MS;
      if (Math.abs(d) < 1e-6) break;
    }
    return t;
  }

  function solarTerm(ms) {
    const lambda = sun(jdFromMs(ms)).lambda;
    const i = Math.floor(lambda / 15) % 24;
    const next = (i + 1) % 24;
    return { name: SOLAR_TERMS[i], next: SOLAR_TERMS[next], nextMs: nextSunLongitude(ms, next * 15) };
  }

  // 日月黄经差到达 targetDeg（0 朔，180 望）的下一个时刻
  function nextSyzygy(ms, targetDeg) {
    const rate = 360 / SYNODIC_MONTH_D; // 度/日
    const e0 = mod(moon(jdFromMs(ms)).lambda - sun(jdFromMs(ms)).lambda, 360);
    let t = ms + (mod(targetDeg - e0, 360) / rate) * DAY_MS;
    for (let i = 0; i < 8; i++) {
      const jd = jdFromMs(t);
      const d = wrap180(targetDeg - (moon(jd).lambda - sun(jd).lambda));
      t += (d / rate) * DAY_MS;
      if (Math.abs(d) < 1e-6) break;
    }
    return t;
  }

  const R_MOON = R_MOON_KM / R_EARTH_KM;
  const R_SUN = R_SUN_KM / R_EARTH_KM;
  // 地影因大气而放大约 2%（丹戎规则的 1/50）
  const SHADOW_ENLARGE = 1.02;

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);

  // 月食几何：月心到地影轴的距离与本影、半影半径（地球半径为单位）
  function lunarShadow(ms) {
    const g = geometry(ms);
    const d = -dot(g.moonPos, g.sunDir); // 月球在地球背日方向上的距离
    const perp = [g.moonPos[0] + d * g.sunDir[0], g.moonPos[1] + d * g.sunDir[1], g.moonPos[2] + d * g.sunDir[2]];
    return {
      rho: len(perp),
      umbra: (1 - (d * (R_SUN - 1)) / g.sunDist) * SHADOW_ENLARGE,
      penumbra: (1 + (d * (R_SUN + 1)) / g.sunDist) * SHADOW_ENLARGE,
      geometry: g,
    };
  }

  // 日食几何：月影轴到地心的最近距离 γ，以及影轴与地面的交点
  function solarShadow(ms) {
    const g = geometry(ms);
    const sunPos = g.sunDir.map((x) => x * g.sunDist);
    const axis = [g.moonPos[0] - sunPos[0], g.moonPos[1] - sunPos[1], g.moonPos[2] - sunPos[2]];
    const al = len(axis);
    const a = axis.map((x) => x / al);
    const ma = dot(g.moonPos, a);
    const closest = [g.moonPos[0] - a[0] * ma, g.moonPos[1] - a[1] * ma, g.moonPos[2] - a[2] * ma];
    const gamma = len(closest);
    let point = closest, along = -ma;
    const disc = ma * ma - (dot(g.moonPos, g.moonPos) - 1);
    if (disc >= 0) {
      along = -ma - Math.sqrt(disc);
      point = [g.moonPos[0] + a[0] * along, g.moonPos[1] + a[1] * along, g.moonPos[2] + a[2] * along];
    }
    // 交点处的本影半径：正为全食，负为环食
    const umbraAtPoint = R_MOON - (along * (R_SUN - R_MOON)) / g.sunDist;
    const penumbraAtPoint = R_MOON + (along * (R_SUN + R_MOON)) / g.sunDist;
    return { gamma, point, umbraAtPoint, penumbraAtPoint, geometry: g };
  }

  function minimize(f, t0, t1, step) {
    let best = t0, bv = Infinity;
    for (let t = t0; t <= t1; t += step) {
      const v = f(t);
      if (v < bv) { bv = v; best = t; }
    }
    let a = best - step, b = best + step;
    for (let i = 0; i < 40; i++) {
      const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3;
      if (f(m1) < f(m2)) b = m2; else a = m1;
    }
    return (a + b) / 2;
  }

  // 从 ms 往后找下一次日食（kind = 'solar'）或月食（kind = 'lunar'）
  function nextEclipse(ms, kind) {
    let t = ms;
    for (let n = 0; n < 40; n++) {
      const syz = nextSyzygy(t, kind === 'solar' ? 0 : 180);
      t = syz + 2 * DAY_MS;
      const H = 3600000;
      if (kind === 'lunar') {
        const tm = minimize((x) => { const s = lunarShadow(x); return s.rho; }, syz - 6 * H, syz + 6 * H, 10 * 60000);
        const s = lunarShadow(tm);
        let type = null;
        if (s.rho < s.umbra - R_MOON) type = '月全食';
        else if (s.rho < s.umbra + R_MOON) type = '月偏食';
        else if (s.rho < s.penumbra + R_MOON) type = '半影月食';
        if (!type) continue;
        // 食分：本影食分 = (本影半径 + 月球半径 − 月心距) / 月球直径
        const magnitude = (s.umbra + R_MOON - s.rho) / (2 * R_MOON);
        if (s.rho > s.umbra + R_MOON && kind === 'lunar') {
          // 半影月食没有本影部分，给出半影食分
          return { kind, type, ms: tm, magnitude: (s.penumbra + R_MOON - s.rho) / (2 * R_MOON), shadow: s };
        }
        return { kind, type, ms: tm, magnitude, shadow: s };
      }
      const tm = minimize((x) => solarShadow(x).gamma, syz - 6 * H, syz + 6 * H, 10 * 60000);
      const s = solarShadow(tm);
      if (s.gamma > 1 + s.penumbraAtPoint) continue;
      let type = '日偏食';
      if (s.gamma < 0.9972) type = s.umbraAtPoint > 0 ? '日全食' : '日环食';
      const body = eqToBody(eclToEq(s.point), s.geometry.era);
      return { kind, type, ms: tm, gamma: s.gamma, where: latLon(body), shadow: s };
    }
    return null;
  }

  const Astro = {
    DEG, RAD, J2000, DAY_MS, R_EARTH_KM, R_EQUATOR_KM, FLATTENING, R_MOON_KM, R_SUN_KM, AU_KM,
    R_MOON, R_SUN, SIDEREAL_DAY_S, SYNODIC_MONTH_D, DELTA_T_S, EPS_J2000, SHADOW_ENLARGE, SOLAR_TERMS,
    mod, wrap180, jdFromMs, msFromJd, earthRotationAngle, gmstDeg, obliquityDeg, sun, moon,
    eclVec, eclToEq, eqToBody, latLon, geometry, moonPhase, phaseName, solarTerm, nextSunLongitude,
    nextSyzygy, lunarShadow, solarShadow, nextEclipse,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Astro;
  else root.Astro = Astro;
})(typeof globalThis !== 'undefined' ? globalThis : this);
