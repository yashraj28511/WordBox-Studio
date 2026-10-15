import { convertCaption } from "./spelling.js";

(function(){
"use strict";

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const lerp  = (a,b,t) => a + (b-a)*t;
const smooth = t => t*t*(3-2*t);

/* =====================================================================
   STATE
   ===================================================================== */
const state = {
  captions: [],
  segments: [],
  videoFile: null,
  mode: "video",
  orphans: [],
  style: {
    preset: "box",
    videoBgColor: "#000000",
    stageAspect: "auto",
    projW: 1080, projH: 1920,
    fontFamily: "Inter", fontWeight: 800, fontSize: 64,
    uppercase: true, textColor: "#ffffff", boxColor: "#2563eb",
    accentColor: "#ffd400", strokeColor: "#000000", strokeWidth: 0,
    lineSpacing: 1.25, maxWidthPct: 80, yPct: 82,
    padXr: 0.16, padYr: 0.10, corner: 12,
    padTr: 0.10, padRr: 0.16, padBr: 0.10, padLr: 0.16, padLink: true,
    boxFit: "font", presetShadow: true,
    maxWords: 0, wordsMode: 0, maxLines: 0, revealMode: 2,
    boxMode: 0, animIn: "pop",
    shadowType: "none", shadowDirection: 135, shadowDistance: 12, shadowOpacity: 70,
    shadowBlur: 12, shadowColor: "#000000", shadowFade: "out",
    shadowLayer: "above", shadowScope: "all", shadowBox: false, keepWordsTogether: true,
    popTime: 0.14, popFrom: 70, moveDist: 60, stagger: 0.03,
    animOut: false, outTime: 0.10, timingMode: 0,
    emBold: true, emItalic: false,
    emTextColor: "#000000", emBoxColor: "#ffd400"
  }
};

let video, overlay, octx;
let VW = 0, VH = 0, SW = 0, SH = 0, SCALE = 1;
let duration = 0, dirty = true, lastDrawTime = -1;
let pendingMode = "video";
let PRJ_KEEP_FONT_SIZE = false;

/* =====================================================================
   TEXT + EMPHASIS
   ===================================================================== */
function normEmph(text){
  const raw = String(text).split(/\s+/); const out = []; let on = false;
  for (const tk of raw){
    if (tk === "") continue;
    const lead = tk.charAt(0) === "*";
    const trail = tk.length > 1 && tk.charAt(tk.length-1) === "*";
    const core = tk.replace(/^\*+|\*+$/g, "");
    if (core === ""){ on = !on; continue; }
    if (lead) on = true;
    out.push(on ? "*" + core + "*" : core);
    if (trail) on = false;
  }
  return out.join(" ");
}
function parseEmph(tokens){
  const words = [], em = [];
  for (const tk of tokens){
    const e = tk.length >= 3 && tk.charAt(0) === "*" && tk.charAt(tk.length-1) === "*";
    words.push(e ? tk.slice(1,-1) : tk);
    em.push(e);
  }
  return { words, em };
}
function splitWords(text, upper){
  let t = normEmph(text);
  if (upper) t = t.toUpperCase();
  return t.split(/\s+/).filter(w => w !== "");
}
function stripEmph(t){ return parseEmph(splitWords(t, false)).words.join(" "); }
function bareKey(w){
  const k = String(w).toLowerCase().replace(/^[\s.,!?;:"'()\[\]\-*]+|[\s.,!?;:"'()\[\]\-*]+$/g, "");
  return k === "" ? String(w).toLowerCase() : k;
}
function bareWord(w){
  return w.toLowerCase().replace(/^[.,!?;:"'()\[\]\-]+|[.,!?;:"'()\[\]\-]+$/g, "");
}

/* =====================================================================
   SRT / VTT PARSING
   ===================================================================== */
function toSec(h,m,s,ms){ return parseInt(h,10)*3600 + parseInt(m,10)*60 + parseInt(s,10) + parseFloat("0."+ms); }
function cleanText(t){ return t.replace(/<[^>]*>/g,"").replace(/\{[^}]*\}/g,"").replace(/\s+/g," ").trim(); }
function splitPlain(t){ t = t.trim(); return t === "" ? [] : t.split(/\s+/); }

function inlineWordTimes(raw, st, en){
  if (!/<(?:\d+:)?\d+:\d+[.,]\d+>/.test(raw)) return null;
  const re = /<(?:(\d+):)?(\d+):(\d+)[.,](\d+)>/g;
  const segs = []; let last = 0, curT = st, m;
  while ((m = re.exec(raw)) !== null){
    segs.push({ t: curT, s: raw.substring(last, m.index) });
    curT = toSec(m[1] || "0", m[2], m[3], m[4]);
    last = m.index + m[0].length;
  }
  segs.push({ t: curT, s: raw.substring(last) });
  const words = [], wt = [];
  for (let i = 0; i < segs.length; i++){
    const ws = splitPlain(cleanText(segs[i].s));
    if (ws.length === 0) continue;
    const t0 = segs[i].t;
    let t1 = (i+1 < segs.length) ? segs[i+1].t : en;
    if (t1 < t0) t1 = t0;
    let tot = 0; for (const w of ws) tot += Math.max(1, w.length);
    let acc = 0;
    for (const w of ws){
      const wl = Math.max(1, w.length);
      words.push(w);
      wt.push({ s: t0 + (t1-t0)*acc/tot, e: t0 + (t1-t0)*(acc+wl)/tot });
      acc += wl;
    }
  }
  return words.length ? { text: words.join(" "), wt } : null;
}

function groupWordLevel(out){
  const n = out.length; let single = 0;
  for (const c of out) if (c.text.indexOf(" ") < 0 && !c.wt) single++;
  if (n < 6 || single / n < 0.8) return out;
  const res = []; let cur = null;
  function finish(c){
    let lo = Infinity, hi = -Infinity;
    for (const w of c.wt){ lo = Math.min(lo, w.s); hi = Math.max(hi, w.e); }
    res.push({ start: lo, end: hi, text: c.words.join(" "), wt: c.wt });
  }
  for (let i = 0; i < n; i++){
    const c = out[i];
    const brk = !cur || (c.start - cur.end >= 0.45) || cur.words.length >= 12 ||
                /[.!?\u0964]["')\]]*$/.test(cur.words[cur.words.length-1]);
    if (brk){ if (cur) finish(cur); cur = { words: [], wt: [], end: c.end }; }
    cur.words.push(c.text);
    cur.wt.push({ s: c.start, e: Math.max(c.end, c.start + 0.02) });
    cur.end = Math.max(cur.end, c.end);
  }
  if (cur) finish(cur);
  return res;
}

function parseSRT(str){
  const lines = str.replace(/\r\n/g,"\n").replace(/\r/g,"\n").split("\n");
  const re = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/;
  const out = []; let i = 0;
  while (i < lines.length){
    const m = re.exec(lines[i]);
    if (m){
      const st = toSec(m[1],m[2],m[3],m[4]);
      const en = toSec(m[5],m[6],m[7],m[8]);
      const parts = []; i++;
      while (i < lines.length && lines[i].trim() !== "" && !re.test(lines[i])){ parts.push(lines[i]); i++; }
      const rawTxt = parts.join(" ");
      const iw = inlineWordTimes(rawTxt, st, en);
      const txt = cleanText(rawTxt);
      if (iw && en > st) out.push({ start: st, end: en, text: iw.text, wt: iw.wt });
      else if (txt !== "" && en > st) out.push({ start: st, end: en, text: txt });
    } else i++;
  }
  return out.length ? groupWordLevel(out) : out;
}
function looksLikeSRT(s){ return /-->/.test(s); }

/* =====================================================================
   WORD TIMING MODEL
   ===================================================================== */
function wordsOf(text){
  const tx = normEmph(text);
  return tx === "" ? [] : parseEmph(tx.split(" ")).words;
}
function pickB(x, i){ return (typeof x === "number") ? x : x[i]; }
function lcsMatch(a, b){
  const m = new Array(b.length).fill(-1);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]){ m[p] = p; p++; }
  let ea = a.length, eb = b.length;
  while (ea > p && eb > p && a[ea-1] === b[eb-1]){ ea--; eb--; m[eb] = ea; }
  const na = ea - p, nb = eb - p;
  if (na <= 0 || nb <= 0) return m;
  const dp = [];
  for (let i = 0; i <= na; i++) dp.push(new Array(nb+1).fill(0));
  for (let i = na-1; i >= 0; i--)
    for (let j = nb-1; j >= 0; j--)
      dp[i][j] = (a[p+i] === b[p+j]) ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
  let i = 0, j = 0;
  while (i < na && j < nb){
    if (a[p+i] === b[p+j]){ m[p+j] = p+i; i++; j++; }
    else if (dp[i+1][j] >= dp[i][j+1]) i++;
    else j++;
  }
  return m;
}
function fillNulls(arr, words, loDef, hiDef, mode){
  const n = arr.length; let i = 0;
  while (i < n){
    if (arr[i]){ i++; continue; }
    let j = i;
    while (j < n && !arr[j]) j++;
    let lo = pickB(loDef, i);
    let hi = pickB(hiDef, j-1);
    if (i > 0 && arr[i-1]) lo = arr[i-1].e;
    if (j < n && arr[j]) hi = arr[j].s;
    const cnt = j - i;
    if (hi < lo + 0.06 * cnt) hi = lo + 0.06 * cnt;
    let wsum = 0;
    for (let k = i; k < j; k++) wsum += (mode === 0 ? Math.max(1, String(words[k]).length) : 1);
    let acc = 0;
    for (let k = i; k < j; k++){
      const wk = (mode === 0 ? Math.max(1, String(words[k]).length) : 1);
      arr[k] = { s: lo + (hi-lo)*acc/wsum, e: lo + (hi-lo)*(acc+wk)/wsum, est: true };
      acc += wk;
    }
    i = j;
  }
}
function estimateWt(words, start, end, mode){
  const arr = new Array(words.length).fill(null);
  fillNulls(arr, words, start, end, mode);
  return arr;
}
function finishWt(w, clean, start, end, mode){
  const out = w.map(x => x ? { s: x.s, e: x.e } : null);
  if (out.some(x => !x)) fillNulls(out, clean, start, end, mode);
  return out;
}
function alignWt(oldW, oldWt, newW, start, end, mode){
  if (!oldWt || oldWt.length !== oldW.length) return null;
  const ka = oldW.map(bareKey), kb = newW.map(bareKey);
  let same = ka.length === kb.length;
  if (same) for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]){ same = false; break; }
  if (same) return oldWt.map(x => ({ s: x.s, e: x.e }));
  const m = lcsMatch(ka, kb);
  const out = new Array(kb.length).fill(null);
  for (let i = 0; i < kb.length; i++) if (m[i] >= 0 && oldWt[m[i]]) out[i] = { s: oldWt[m[i]].s, e: oldWt[m[i]].e };
  fillNulls(out, newW, start, end, mode);
  return out;
}
function entryWt(en, clean, mode){
  if (!en.wt || clean.length === 0) return null;
  let w;
  if (en.srcText) w = alignWt(wordsOf(en.srcText), en.wt, clean, en.start, en.end, mode);
  else w = (en.wt.length === clean.length) ? en.wt.map(x => ({ s: x.s, e: x.e })) : null;
  if (!w) return null;
  return finishWt(w, clean, en.start, en.end, mode);
}

/* =====================================================================
   reconcileCaptionText
   ===================================================================== */
const MAX_MOVE_DIST = 6;
function cpW(x){
  const o = { s: x.s, e: x.e };
  if (x.est) o.est = true;
  if (x.fresh) o.fresh = true;
  return o;
}
function windowDist(s, e, a, b){ if (e < a) return a - e; if (s > b) return s - b; return 0; }
function refitCaption(c){
  if (!c.wt || !c.wt.length) return;
  let lo = Infinity, hi = -Infinity;
  for (const x of c.wt){ if (x.s < lo) lo = x.s; if (x.e > hi) hi = x.e; }
  c.start = lo; c.end = hi;
}
function adoptOrphansElsewhere(src, fresh){
  if (!fresh.length) return;
  for (const c2 of state.captions){
    if (c2 === src || !c2.wt) continue;
    const w2 = wordsOf(c2.text);
    if (w2.length !== c2.wt.length) continue;
    let changed = false;
    for (let i = 0; i < w2.length; i++){
      const cur = c2.wt[i];
      if (!cur || !cur.fresh) continue;
      const key = bareKey(w2[i]);
      let best = -1, bd = Infinity;
      for (let o = 0; o < fresh.length; o++){
        const og = fresh[o];
        if (og.key !== key) continue;
        const d = windowDist(og.s, og.e, c2.start, c2.end);
        if (d <= MAX_MOVE_DIST && d < bd){ bd = d; best = o; }
      }
      if (best >= 0){
        const og = fresh[best];
        c2.wt[i] = { s: og.s, e: og.e };
        const pi = state.orphans.indexOf(og);
        if (pi >= 0) state.orphans.splice(pi, 1);
        fresh.splice(best, 1);
        changed = true;
      }
    }
    if (changed) refitCaption(c2);
    if (!fresh.length) break;
  }
}
function reconcileCaptionText(c, newText){
  const mode = state.style.timingMode;
  const oldClean = wordsOf(c.text);
  const newClean = wordsOf(newText);
  if (!c.wt || oldClean.length !== c.wt.length || c.wt.some(x => !x)){
    c.text = newText; c.srcText = newText; c.wt = null; return;
  }
  const ka = oldClean.map(bareKey);
  const kb = newClean.map(bareKey);
  const m = lcsMatch(ka, kb);
  const out = new Array(kb.length).fill(null);
  const usedOld = new Array(ka.length).fill(false);
  for (let i = 0; i < kb.length; i++){
    if (m[i] >= 0 && c.wt[m[i]]){ out[i] = cpW(c.wt[m[i]]); usedOld[m[i]] = true; }
  }
  const fresh = [];
  for (let i = 0; i < ka.length; i++){
    if (!usedOld[i] && c.wt[i] && !c.wt[i].est){
      const og = { key: ka[i], s: c.wt[i].s, e: c.wt[i].e };
      state.orphans.push(og); fresh.push(og);
    }
  }
  for (let i = 0; i < kb.length; i++){
    if (out[i]) continue;
    let prevE = -Infinity, nextS = Infinity;
    for (let p = i - 1; p >= 0; p--) if (out[p]) { prevE = out[p].e; break; }
    for (let q = i + 1; q < kb.length; q++) if (out[q]) { nextS = out[q].s; break; }
    if (prevE === -Infinity) prevE = c.start - 5;
    if (nextS === Infinity)  nextS = c.end + 5;
    let best = -1, bestScore = Infinity;
    for (let o = 0; o < state.orphans.length; o++){
      const og = state.orphans[o];
      if (og.key !== kb[i]) continue;
      const dist = windowDist(og.s, og.e, c.start, c.end);
      if (dist > MAX_MOVE_DIST) continue;
      let score = dist * 0.001;
      if (og.s < prevE) score += (prevE - og.s);
      if (og.e > nextS) score += (og.e - nextS);
      if (score < bestScore){ bestScore = score; best = o; }
    }
    if (best >= 0){
      const og = state.orphans[best];
      out[i] = { s: og.s, e: og.e };
      state.orphans.splice(best, 1);
      const fi = fresh.indexOf(og);
      if (fi >= 0) fresh.splice(fi, 1);
    }
  }
  const isNew = out.map(x => !x);
  fillNulls(out, newClean, c.start, c.end, mode);
  for (let i = 0; i < out.length; i++) if (isNew[i]){ out[i].est = true; out[i].fresh = true; }
  c.wt = out; c.text = newText; c.srcText = newText;
  refitCaption(c);
  adoptOrphansElsewhere(c, fresh.filter(og => state.orphans.indexOf(og) >= 0));
  if (state.orphans.length > 500) state.orphans.splice(0, state.orphans.length - 500);
}

/* =====================================================================
   FORMAT
   ===================================================================== */
function pad2(n){ return (n<10?"0":"") + n; }
function fmtTime(t){
  t = Math.max(0, t);
  const cs = Math.round(t * 100);
  const m = Math.floor(cs / 6000);
  const rest = cs - m * 6000;
  return m + ":" + pad2(Math.floor(rest/100)) + "." + pad2(rest % 100);
}
function fmtClock(t){
  t = Math.max(0, t);
  const m = Math.floor(t/60), s = Math.floor(t%60);
  return m + ":" + pad2(s) + "." + pad2(Math.floor((t%1)*100));
}
function parseTimeStr(str){
  str = String(str).trim();
  if (!str) return NaN;
  if (str.indexOf(":") < 0) return parseFloat(str);
  const parts = str.split(":"); let sec = 0;
  for (const p of parts){ const v = parseFloat(p); if (isNaN(v)) return NaN; sec = sec*60 + v; }
  return sec;
}
function srtTime(t){
  const cs = Math.round(Math.max(0,t)*1000);
  const h = Math.floor(cs/3600000);
  const m = Math.floor(cs/60000)%60;
  const s = Math.floor(cs/1000)%60;
  const ms = cs % 1000;
  return pad2(h)+":"+pad2(m)+":"+pad2(s)+","+String(ms).padStart(3,"0");
}

/* =====================================================================
   SEGMENT BUILDING
   ===================================================================== */
function wordWeights(words, mode){ return words.map(w => mode === 0 ? Math.max(1, w.length) : 1); }
function makeSegment(start, end, words, em, wt, st){
  let realWt = wt;
  if (!realWt || realWt.length !== words.length){
    const w = wordWeights(words, st.timingMode);
    let sum = 0; for (const x of w) sum += x;
    let acc = 0;
    realWt = words.map((_, i) => {
      const s = start + (end-start) * acc / sum;
      acc += w[i];
      const e = start + (end-start) * acc / sum;
      return { s, e };
    });
  }
  return { start, end, words, em, wt: realWt };
}
/* Word timestamps from Whisper (and hand-edited captions) routinely overlap
   neighbouring words by a few ms, share a start time, or arrive out of order.
   Rendered as-is, two word boxes are alive in the same frame and "flash" together.
   This builds a clean, strictly sequential copy for rendering only; the editable
   captions (and SRT/VTT/JSON exports) are never modified. */
const MIN_WORD_DUR = 0.03;
function sanitizeWt(wt, start, end){
  const n = wt.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { s: wt[i].s, e: wt[i].e };
  // 1) starts never go backwards
  for (let i = 1; i < n; i++) if (out[i].s < out[i-1].s) out[i].s = out[i-1].s;
  // 2) a word ends no later than the next one starts (same number => no overlap, no gap)
  for (let i = 0; i < n - 1; i++) if (out[i].e > out[i+1].s) out[i].e = out[i+1].s;
  // 3) keep every word visible for at least a few frames; push followers if needed
  let prevE = -Infinity;
  for (let i = 0; i < n; i++){
    const w = out[i];
    if (w.s < prevE) w.s = prevE;
    if (w.e < w.s + MIN_WORD_DUR) w.e = w.s + MIN_WORD_DUR;
    prevE = w.e;
  }
  // 4) let the last word finish its out-animation inside the caption window
  if (n && isFinite(end) && out[n-1].e > end && end > out[n-1].s) out[n-1].e = end;
  return out;
}
/* Two captions must never be on screen together (they share one position). */
function separateSegments(segs){
  const order = segs.slice().sort((a, b) => a.start - b.start);
  for (let i = 0; i < order.length - 1; i++){
    const a = order[i], b = order[i+1];
    if (a.end > b.start && b.start > a.start){
      a.end = b.start;
      for (const w of a.wt){
        if (w.e > a.end) w.e = a.end;
        if (w.s > a.end) w.s = a.end;
      }
    }
  }
  return segs;
}
function buildSegments(captions, st){
  const segs = [];
  for (const cap of captions){
    const tokens = splitWords(cap.text, st.uppercase);
    const pe = parseEmph(tokens);
    if (pe.words.length === 0) continue;
    const clean = pe.words;
    const wt = sanitizeWt(
      entryWt({ start: cap.start, end: cap.end, wt: cap.wt, srcText: cap.srcText }, clean, st.timingMode)
        || estimateWt(clean, cap.start, cap.end, st.timingMode),
      cap.start, cap.end);
    const N = st.maxWords;
    if (st.keepWordsTogether){
      const measureCanvas = document.createElement("canvas");
      const mctx = measureCanvas.getContext("2d");
      const fs = st.fontSize, maxW = (SW || VW || 1080) * st.maxWidthPct / 100;
      const pad = fs * (padRatio(st, "L") + padRatio(st, "R")), gap = fs * 0.10;
      const widths = clean.map((word, i) => { mctx.font = fontStr(st, fs, pe.em[i]); return mctx.measureText(word).width + pad; });
      const groups = []; let group = [], groupW = 0;
      for (let i = 0; i < clean.length; i++){
        const limitHit = N > 0 && st.wordsMode === 0 && group.length >= N;
        const widthHit = group.length > 0 && groupW + gap + widths[i] > maxW;
        if (limitHit || widthHit){ groups.push(group); group = []; groupW = 0; }
        group.push(i); groupW += widths[i] + (group.length > 1 ? gap : 0);
      }
      if (group.length) groups.push(group);
      if (groups.length > 1){
        for (const ids of groups){
          const cw = ids.map(i => wt[i]);
          segs.push({ start: Math.min(...cw.map(x => x.s)), end: Math.max(...cw.map(x => x.e)),
            words: ids.map(i => clean[i]), em: ids.map(i => pe.em[i]), wt: cw });
        }
        continue;
      }
    }
    if (!(N > 0) || st.wordsMode !== 0 || clean.length <= N){
      segs.push(makeSegment(cap.start, cap.end, clean, pe.em, wt, st));
      continue;
    }
    const k = Math.ceil(clean.length / N);
    const base = Math.floor(clean.length / k), extra = clean.length % k;
    let i0 = 0;
    for (let c = 0; c < k; c++){
      const i1 = i0 + base + (c < extra ? 1 : 0);
      const cw = wt.slice(i0, i1);
      const cs = Math.min(...cw.map(x => x.s));
      const ce = Math.max(...cw.map(x => x.e));
      segs.push({ start: cs, end: ce, words: clean.slice(i0, i1), em: pe.em.slice(i0, i1), wt: cw });
      i0 = i1;
    }
  }
  return separateSegments(segs);
}

/* =====================================================================
   ANIMATION
   ===================================================================== */
function animTracks(st){
  const p = st.popFrom, d = st.fontSize * st.moveDist / 100;
  const t = { sx:null, sy:null, dx:null, dy:null, rot:null, alpha:null, ox:0.5 };
  switch (st.animIn){
    case "none": return t;
    case "pop":      t.sx = t.sy = [[0,p],[1,100]]; break;
    case "bounce":   t.sx = t.sy = [[0,p],[0.6,112],[1,100]]; break;
    case "elastic":  t.sx = t.sy = [[0,p],[0.3,120],[0.55,92],[0.78,104],[1,100]]; break;
    case "fade":     t.alpha = [[0,0],[1,100]]; break;
    case "slideUp":  t.dy = [[0,d],[1,0]];  t.alpha = [[0,0],[0.6,100]]; break;
    case "slideDown":t.dy = [[0,-d],[1,0]]; t.alpha = [[0,0],[0.6,100]]; break;
    case "slideL":   t.dx = [[0,-d],[1,0]]; t.alpha = [[0,0],[0.6,100]]; break;
    case "slideR":   t.dx = [[0,d],[1,0]];  t.alpha = [[0,0],[0.6,100]]; break;
    case "drop":     t.dy = [[0,-d*1.6],[0.55,d*0.15],[0.8,-d*0.05],[1,0]]; t.alpha = [[0,0],[0.3,100]]; break;
    case "wipeLR":   t.sx = [[0,0],[1,100]]; t.ox = 0; break;
    case "wipeRL":   t.sx = [[0,0],[1,100]]; t.ox = 1; break;
    case "stretchH": t.sx = [[0,0],[1,100]]; break;
    case "stretchV": t.sy = [[0,0],[1,100]]; break;
    case "spin":     t.rot = [[0,-180],[1,0]]; t.sx = t.sy = [[0,0],[1,100]]; break;
    case "zoomOut":  t.sx = t.sy = [[0,170],[1,100]]; t.alpha = [[0,0],[0.6,100]]; break;
  }
  return t;
}
function kf(keys, p){
  if (!keys) return null;
  if (p <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++){
    if (p <= keys[i][0]){
      const [t0,v0] = keys[i-1], [t1,v1] = keys[i];
      const u = (t1-t0) === 0 ? 1 : smooth(clamp((p-t0)/(t1-t0), 0, 1));
      return v0 + (v1-v0)*u;
    }
  }
  return keys[keys.length-1][1];
}

/* =====================================================================
   CANVAS RENDER
   ===================================================================== */
function fontStr(st, size, em){
  const w = (em && st.emBold) ? 900 : st.fontWeight;
  const i = (em && st.emItalic) ? "italic " : "";
  return i + w + " " + size + "px \"" + st.fontFamily + "\", system-ui, sans-serif";
}
function roundRect(ctx, x, y, w, h, r){
  r = Math.max(0, Math.min(r, w/2, h/2));
  ctx.beginPath();
  if (ctx.roundRect){ ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y,   x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x,   y+h, r);
  ctx.arcTo(x,   y+h, x,   y,   r);
  ctx.arcTo(x,   y,   x+w, y,   r);
  ctx.closePath();
}
function drawCaptions(ctx, W, H, t, st, segs, scale){
  ctx.save();
  CUR_SCALE = scale || 1;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = "alphabetic";
  // Safety net: even if two segments overlap, draw only the most recently started one.
  let active = null;
  for (const seg of segs){
    if (t < seg.start || t >= seg.end) continue;
    if (!active || seg.start >= active.start) active = seg;
  }
  if (active) drawSegment(ctx, W, H, t, st, active);
  ctx.restore();
}

/* =====================================================================
   PRESETS  — original + reference-inspired additions
   ===================================================================== */
const PRESETS = [
  /* -------- core styles -------- */
  { id:"box", name:"Word Box", prev:'background:#2563eb;color:#fff;border-radius:4px;padding:2px 8px;font-weight:800',
    apply:{ fontFamily:"Inter", fontWeight:800, uppercase:true, textColor:"#ffffff", boxColor:"#2563eb",
            accentColor:"#ffd400", strokeColor:"#000000", strokeWidth:0,
            corner:12, padXr:0.16, padYr:0.10, boxMode:0, animIn:"pop", revealMode:2 } },
  { id:"pill", name:"Line Pill", prev:'background:#2563eb;color:#fff;border-radius:999px;padding:2px 10px;font-weight:700',
    apply:{ fontFamily:"Poppins", fontWeight:700, uppercase:false, textColor:"#ffffff", boxColor:"#2563eb",
            accentColor:"#ffd400", strokeColor:"#000000", strokeWidth:0,
            corner:60, padXr:0.22, padYr:0.12, animIn:"slideUp", revealMode:1 } },
  { id:"karaoke", name:"Karaoke", prev:'color:#ffd400;font-weight:800;text-shadow:0 2px 4px rgba(0,0,0,.85)',
    apply:{ fontFamily:"Inter", fontWeight:800, uppercase:true, textColor:"#ffffff", accentColor:"#ffd400",
            boxColor:"#000000", strokeColor:"#000000", strokeWidth:8,
            corner:0, padXr:0, padYr:0, animIn:"none", revealMode:0 } },
  { id:"highlight", name:"Marker", prev:'background:#ffd400;color:#111;padding:1px 6px;font-weight:800;border-radius:2px',
    apply:{ fontFamily:"Montserrat", fontWeight:800, uppercase:true, textColor:"#ffffff", accentColor:"#ffd400",
            boxColor:"#000000", strokeColor:"#000000", strokeWidth:10, emTextColor:"#111111",
            corner:3, padXr:0.10, padYr:0.04, animIn:"none", revealMode:1 } },
  { id:"outline", name:"Outline", prev:'color:#fff;font-weight:900;-webkit-text-stroke:1.6px #000',
    apply:{ fontFamily:"Montserrat", fontWeight:900, uppercase:true, textColor:"#ffffff", accentColor:"#ffd400",
            boxColor:"#000000", strokeColor:"#000000", strokeWidth:12,
            corner:0, padXr:0, padYr:0, animIn:"none", revealMode:0 } },
  { id:"shadow", name:"Shadow", prev:'color:#fff;font-weight:800;text-shadow:0 3px 5px rgba(0,0,0,.95)',
    apply:{ fontFamily:"Inter", fontWeight:800, uppercase:false, textColor:"#ffffff", accentColor:"#5b8cff",
            strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0, padYr:0, animIn:"fade", revealMode:1 } },
  { id:"neon", name:"Neon", prev:'color:#fff;font-weight:700;text-shadow:0 0 6px #00e5ff,0 0 14px #00e5ff',
    apply:{ fontFamily:"Poppins", fontWeight:700, uppercase:true, textColor:"#ffffff", accentColor:"#00e5ff",
            boxColor:"#7c3aed", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0, padYr:0, animIn:"fade", revealMode:0 } },
  { id:"bounce", name:"Bounce", prev:'color:#fff;font-weight:900;-webkit-text-stroke:1.6px #000',
    apply:{ fontFamily:"Luckiest Guy", fontWeight:900, uppercase:true, textColor:"#ffffff", accentColor:"#ff2d92",
            strokeColor:"#000000", strokeWidth:14,
            corner:0, padXr:0, padYr:0, animIn:"bounce", revealMode:1 } },
  { id:"typewriter", name:"Type", prev:'color:#7ef7a0;font-family:monospace;font-weight:700',
    apply:{ fontFamily:"Courier New", fontWeight:700, uppercase:false, textColor:"#7ef7a0", accentColor:"#ffffff",
            strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0, padYr:0, animIn:"none", revealMode:1 } },
  { id:"block", name:"Lower 3rd", prev:'background:rgba(15,23,42,.9);color:#fff;padding:2px 8px;font-weight:700',
    apply:{ fontFamily:"Inter", fontWeight:700, uppercase:false, textColor:"#ffffff", boxColor:"#0f172a",
            accentColor:"#5b8cff", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0.12, padYr:0.08, animIn:"slideL", revealMode:1 } },
  { id:"tiktok", name:"TikTok", prev:'color:#fff;font-weight:900;-webkit-text-stroke:1.8px #000;text-shadow:2px 2px 0 #ff2d92',
    apply:{ fontFamily:"Archivo Black", fontWeight:900, uppercase:true, textColor:"#ffffff", accentColor:"#ff2d92",
            boxColor:"#000000", strokeColor:"#000000", strokeWidth:18,
            corner:0, padXr:0, padYr:0, animIn:"pop", revealMode:0 } },
  { id:"gradient", name:"Gradient", prev:'color:#fff;font-weight:900',
    apply:{ fontFamily:"Anton", fontWeight:900, uppercase:true, textColor:"#ffffff", accentColor:"#ffd400",
            strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0, padYr:0, animIn:"fade", revealMode:0 } },
  { id:"comic", name:"Comic", prev:'color:#ffd400;font-weight:900;-webkit-text-stroke:1.6px #000',
    apply:{ fontFamily:"Bangers", fontWeight:900, uppercase:true, textColor:"#ffffff", accentColor:"#ffd400",
            strokeColor:"#000000", strokeWidth:16,
            corner:0, padXr:0, padYr:0, animIn:"pop", revealMode:1 } },
  { id:"cinematic", name:"Film", prev:'color:#e5e5e5;font-weight:600;font-family:serif;letter-spacing:3px',
    apply:{ fontFamily:"Georgia", fontWeight:600, uppercase:true, textColor:"#e5e5e5", accentColor:"#a3a3a3",
            boxColor:"#171717", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0, padYr:0, animIn:"fade", revealMode:0 } },
  { id:"rebel", name:"Rebel", prev:'color:#fff;font-weight:900;-webkit-text-stroke:1.5px #000;font-family:Impact',
    apply:{ fontFamily:"Impact", fontWeight:900, uppercase:true, textColor:"#ffffff", accentColor:"#ef4444",
            boxColor:"#000000", strokeColor:"#000000", strokeWidth:22,
            corner:0, padXr:0, padYr:0, animIn:"pop", revealMode:1 } },
  { id:"y2k", name:"Y2K", prev:'color:#fff;font-weight:800;text-shadow:1px 1px 0 #ff00ff,-1px -1px 0 #00ffff',
    apply:{ fontFamily:"Impact", fontWeight:800, uppercase:true, textColor:"#ffffff", accentColor:"#ff00ff",
            boxColor:"#000000", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0, padYr:0, animIn:"pop", revealMode:0 } },
  { id:"chalk", name:"Chalk", prev:'color:#fff;font-weight:700;font-family:cursive',
    apply:{ fontFamily:"Caveat", fontWeight:700, uppercase:false, textColor:"#ffffff", accentColor:"#a3e635",
            boxColor:"#1f2937", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0, padYr:0, animIn:"fade", revealMode:1 } },

  /* ============================================================
     NEW — reference-inspired styles (from the two images)
     ============================================================ */

  /* Corner bracket frame (TYPOGRAPHY / TITLES GRAPHICS ANIMATION) */
  { id:"cornerFrame", name:"Corners",
    prev:'color:#fff;font-weight:800;border:2px solid #ffd400;padding:2px 8px',
    apply:{ fontFamily:"Montserrat", fontWeight:800, uppercase:true, textColor:"#ffffff",
            accentColor:"#ffd400", boxColor:"#000000", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0.12, padYr:0.06, animIn:"fade", revealMode:0 } },

  /* Vertical bars flanking the line (ISABELLA NELSON) */
  { id:"sideBars", name:"Side Bars",
    prev:'color:#fff;font-weight:800;padding:2px 10px;border-left:4px solid #ef4444;border-right:4px solid #ef4444',
    apply:{ fontFamily:"Inter", fontWeight:800, uppercase:true, textColor:"#ffffff",
            accentColor:"#ef4444", boxColor:"#000000", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0.10, padYr:0.05, animIn:"fade", revealMode:1 } },

  /* Slanted parallelogram box (AVA SCOTT / LILY EDWARDS) */
  { id:"slantBox", name:"Slant",
    prev:'background:#dc2626;color:#fff;font-style:italic;font-weight:900;padding:2px 10px',
    apply:{ fontFamily:"Montserrat", fontWeight:900, uppercase:true, textColor:"#ffffff",
            accentColor:"#dc2626", boxColor:"#dc2626", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0.16, padYr:0.08, animIn:"slideL", revealMode:0 } },

  /* Yellow accent strip behind active word (NEVER / LOOK BACK) */
  { id:"accentStrip", name:"Strip",
    prev:'background:#fbbf24;color:#111;font-weight:900;padding:1px 8px',
    apply:{ fontFamily:"Montserrat", fontWeight:900, uppercase:true, textColor:"#ffffff",
            accentColor:"#fbbf24", boxColor:"#111111", emTextColor:"#111111",
            strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0.10, padYr:0.04, animIn:"none", revealMode:2 } },

  /* Hollow / outline text (DO IT) */
  { id:"outlineText", name:"Hollow",
    prev:'color:transparent;-webkit-text-stroke:1.6px #fff;font-weight:900;letter-spacing:2px',
    apply:{ fontFamily:"Montserrat", fontWeight:900, uppercase:true, textColor:"#ffffff",
            accentColor:"#ffd400", boxColor:"#000000", strokeColor:"#ffffff", strokeWidth:22,
            corner:0, padXr:0, padYr:0, animIn:"fade", revealMode:0 } },

  /* Split-tone: first word one color, rest another (EMILY JOHNSON, LUCAS EVANS) */
  { id:"splitTone", name:"Split Tone",
    prev:'color:#fff;font-weight:900',
    apply:{ fontFamily:"Montserrat", fontWeight:900, uppercase:true, textColor:"#ffffff",
            accentColor:"#ef4444", boxColor:"#000000", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0, padYr:0, animIn:"none", revealMode:0 } },

  /* Small badge under active word (ANIMATION / TITLES) */
  { id:"badgeBelow", name:"Badge",
    prev:'color:#fff;font-weight:900;border-bottom:3px solid #fbbf24',
    apply:{ fontFamily:"Inter", fontWeight:900, uppercase:true, textColor:"#ffffff",
            accentColor:"#fbbf24", boxColor:"#111111", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0.04, padYr:0.02, animIn:"fade", revealMode:0 } },

  /* Slash divider (FOLLOW YOUR / HEART) */
  { id:"slashSplit", name:"Slash",
    prev:'color:#fff;font-weight:900;font-style:italic',
    apply:{ fontFamily:"Montserrat", fontWeight:900, uppercase:true, textColor:"#ffffff",
            accentColor:"#fbbf24", boxColor:"#000000", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0, padYr:0, animIn:"fade", revealMode:0 } },

  /* Horizontal rule above text (IMAGINATION / rules the world) */
  { id:"horizLine", name:"Rule",
    prev:'color:#fff;font-weight:800;border-top:2px solid #fff;padding-top:3px',
    apply:{ fontFamily:"Inter", fontWeight:800, uppercase:false, textColor:"#ffffff",
            accentColor:"#ffffff", boxColor:"#111111", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0.04, padYr:0.03, animIn:"fade", revealMode:0 } },

  /* Double outline box (TITLE / ANIMATION) */
  { id:"doubleFrame", name:"Double",
    prev:'color:#fff;font-weight:900;border:2px solid #fbbf24;outline:2px solid #fbbf24;outline-offset:2px;padding:2px 8px',
    apply:{ fontFamily:"Montserrat", fontWeight:900, uppercase:true, textColor:"#ffffff",
            accentColor:"#fbbf24", boxColor:"#111111", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0.12, padYr:0.06, animIn:"pop", revealMode:0 } },

  /* Thick left accent bar (NEVER STOP / DREAMING) */
  { id:"leftBar", name:"Left Bar",
    prev:'color:#fff;font-weight:900;border-left:6px solid #fbbf24;padding-left:8px',
    apply:{ fontFamily:"Montserrat", fontWeight:900, uppercase:true, textColor:"#ffffff",
            accentColor:"#fbbf24", boxColor:"#111111", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0.04, padYr:0.03, animIn:"slideL", revealMode:0 } },

  /* Colored underline accent (LAURA THOMAS) */
  { id:"underlineAcc", name:"Underline",
    prev:'color:#fff;font-weight:900;border-bottom:4px solid #ef4444;padding-bottom:2px',
    apply:{ fontFamily:"Montserrat", fontWeight:900, uppercase:true, textColor:"#ffffff",
            accentColor:"#ef4444", boxColor:"#111111", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0.04, padYr:0.02, animIn:"slideUp", revealMode:0 } },

  /* Small caps header strip on top (SYSTEMS ANALYST / SCIENTIST) */
  { id:"stripeHeader", name:"Header",
    prev:'color:#fff;font-weight:900;border-top:2px solid #ef4444;padding-top:4px',
    apply:{ fontFamily:"Inter", fontWeight:900, uppercase:true, textColor:"#ffffff",
            accentColor:"#ef4444", boxColor:"#111111", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0.06, padYr:0.03, animIn:"fade", revealMode:0 } },

  /* Neon corner brackets (glowing) */
  { id:"neonFrame", name:"Neon Frame",
    prev:'color:#fff;font-weight:900;text-shadow:0 0 6px #fbbf24',
    apply:{ fontFamily:"Montserrat", fontWeight:900, uppercase:true, textColor:"#ffffff",
            accentColor:"#fbbf24", boxColor:"#111111", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0.10, padYr:0.06, animIn:"fade", revealMode:0 } },

  /* Vintage cinema bar (analog / vinyl) */
  { id:"cinemaBar", name:"Cinema",
    prev:'background:#1a1a1a;color:#fbbf24;font-weight:800;letter-spacing:3px;padding:2px 10px',
    apply:{ fontFamily:"Georgia", fontWeight:800, uppercase:true, textColor:"#fbbf24",
            accentColor:"#fbbf24", boxColor:"#1a1a1a", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0.16, padYr:0.08, animIn:"fade", revealMode:0 } },

  /* Big red bar (DAVID WILSON) */
  { id:"redBar", name:"Red Bar",
    prev:'background:#dc2626;color:#fff;font-weight:900;padding:2px 12px',
    apply:{ fontFamily:"Inter", fontWeight:900, uppercase:true, textColor:"#ffffff",
            accentColor:"#ffffff", boxColor:"#dc2626", strokeColor:"#000000", strokeWidth:0,
            corner:2, padXr:0.20, padYr:0.09, animIn:"slideUp", revealMode:0 } },

  /* White bar with red text (JENNIFER HALL) */
  { id:"whiteBar", name:"White Bar",
    prev:'background:#fff;color:#dc2626;font-weight:900;padding:2px 12px',
    apply:{ fontFamily:"Inter", fontWeight:900, uppercase:true, textColor:"#dc2626",
            accentColor:"#dc2626", boxColor:"#ffffff", strokeColor:"#000000", strokeWidth:0,
            corner:2, padXr:0.18, padYr:0.09, animIn:"pop", revealMode:0 } },

  /* Stacked two-color name (ETHAN / PEREZ) */
  { id:"stacked", name:"Stacked",
    prev:'color:#ef4444;font-weight:900',
    apply:{ fontFamily:"Montserrat", fontWeight:900, uppercase:true, textColor:"#ffffff",
            accentColor:"#ef4444", boxColor:"#111111", strokeColor:"#000000", strokeWidth:0,
            corner:0, padXr:0, padYr:0, animIn:"none", revealMode:0 } }
];

/* =====================================================================
   RENDERERS
   ===================================================================== */
const RENDERERS = {
  box: renderBox, pill: renderPill, karaoke: renderKaraoke, highlight: renderHighlight,
  outline: renderOutline, shadow: renderShadow, neon: renderNeon, bounce: renderBounce,
  typewriter: renderTypewriter, block: renderBlock, tiktok: renderTiktok,
  gradient: renderGradient, cinematic: renderCinematic, rebel: renderRebel,
  y2k: renderY2k, chalk: renderChalk,
  /* new */
  cornerFrame: renderCornerFrame, sideBars: renderSideBars, slantBox: renderSlantBox,
  accentStrip: renderAccentStrip, outlineText: renderOutlineText, splitTone: renderSplitTone,
  badgeBelow: renderBadgeBelow, slashSplit: renderSlashSplit, horizLine: renderHorizLine,
  doubleFrame: renderDoubleFrame, leftBar: renderLeftBar, underlineAcc: renderUnderlineAcc,
  stripeHeader: renderStripeHeader, neonFrame: renderNeonFrame, cinemaBar: renderCinemaBar,
  redBar: renderRedBar, whiteBar: renderWhiteBar, stacked: renderStacked
};

/* Padding is stored per side; older projects and the presets only carry padXr / padYr,
   so fall back to those whenever a side has not been set. */
function padRatio(st, side){
  const v = st["pad" + side + "r"];
  if (typeof v === "number") return v;
  return (side === "L" || side === "R") ? (st.padXr || 0) : (st.padYr || 0);
}
/* Several presets paint their own drop shadow or offset copy. This switch turns those
   off so the caption can use the Text shadow controls instead (or no shadow at all). */
function presetShadowOn(st){ return st.presetShadow !== false; }
function setPresetShadow(ctx, st, color, blur, ox, oy){
  if (!presetShadowOn(st)){
    ctx.shadowColor = "rgba(0,0,0,0)"; ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    return;
  }
  ctx.shadowColor = color;
  ctx.shadowBlur = blur || 0;
  ctx.shadowOffsetX = ox || 0;
  ctx.shadowOffsetY = oy || 0;
}
function presetOffset(st, v){ return presetShadowOn(st) ? v : 0; }

function strokeW(st, fs){ return fs * (st.strokeWidth || 0) / 100; }
function accentOf(st){ return st.accentColor || "#ffd400"; }
function strokeOf(st){ return st.strokeColor || "#000000"; }

function fillStroked(ctx, text, x, y, fill, stroke, lw){
  if (lw > 0.1 && stroke){
    ctx.lineJoin = "round"; ctx.miterLimit = 2;
    ctx.lineWidth = lw; ctx.strokeStyle = stroke;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}
function wordXform(ctx, r, boxTop, boxH, scale, dx, dy, rot, draw){
  if (scale === 1 && !dx && !dy && !rot){ draw(); return; }
  const cx = r.x + r.w / 2, cy = boxTop + boxH / 2;
  ctx.save();
  if (dx || dy) ctx.translate(dx || 0, dy || 0);
  ctx.translate(cx, cy);
  if (rot) ctx.rotate(rot * Math.PI / 180);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  draw();
  ctx.restore();
}
function revealed(seg, i, t, mode){
  const w = seg.wt[i];
  if (mode === 0) return true;
  if (mode === 1) return t >= w.s;
  return t >= w.s && t < w.e;
}
function activeWordIndex(seg, t){
  for (let i = 0; i < seg.words.length; i++){
    const w = seg.wt[i];
    if (t >= w.s && t < w.e) return i;
  }
  return -1;
}

/* ---------- shared layout ---------- */
function layoutSegment(ctx, W, H, st, seg){
  const fs = st.fontSize;
  const padL = fs * padRatio(st, "L");
  const padR = fs * padRatio(st, "R");
  const padT = fs * padRatio(st, "T");
  const padB = fs * padRatio(st, "B");
  // padX / padY stay as the "text inset" and "average vertical pad" the renderers expect.
  const padX = padL;
  const padY = (padT + padB) / 2;
  const gap  = fs * 0.10;
  const lineH = fs * st.lineSpacing;
  const maxW = W * st.maxWidthPct / 100;
  const baseY = H * st.yPct / 100;
  const n = seg.words.length;
  if (!n) return null;
  const textW = new Array(n);
  for (let i = 0; i < n; i++){
    ctx.font = fontStr(st, fs, seg.em[i]);
    textW[i] = ctx.measureText(seg.words[i]).width;
  }
  ctx.font = fontStr(st, fs, false);
  let asc, desc;
  if (st.boxFit === "text"){
    // Measure the words actually on screen, so an ALL-CAPS line gets an evenly
    // balanced box instead of carrying the font's unused descender space.
    let a = 0, d = 0;
    for (let i = 0; i < n; i++){
      ctx.font = fontStr(st, fs, seg.em[i]);
      const m = ctx.measureText(seg.words[i]);
      a = Math.max(a, m.actualBoundingBoxAscent  || fs * 0.72);
      d = Math.max(d, m.actualBoundingBoxDescent || 0);
    }
    ctx.font = fontStr(st, fs, false);
    asc = a || fs * 0.72;
    desc = d;
  } else {
    const mm = ctx.measureText("Hxg");
    asc  = mm.actualBoundingBoxAscent  || fs * 0.75;
    desc = mm.actualBoundingBoxDescent || fs * 0.25;
  }
  const boxH = asc + desc + padT + padB;
  const boxTopOff = asc + padT;
  const widths = new Array(n);
  for (let i = 0; i < n; i++) widths[i] = textW[i] + padL + padR;
  const lineW = idx => {
    let s = 0;
    for (const i of idx) s += widths[i];
    return s + gap * Math.max(0, idx.length - 1);
  };
  const all = Array.from({length:n}, (_,i) => i);
  const cap = (st.maxWords > 0 && st.wordsMode === 1) ? st.maxWords : 0;
  let lines;
  if (st.maxLines === 1){ lines = [all]; }
  else {
    const greedy = []; let cur = [];
    for (let i = 0; i < n; i++){
      if (cur.length && ((cap && cur.length >= cap) || lineW(cur.concat([i])) > maxW)){
        greedy.push(cur); cur = [i];
      } else cur.push(i);
    }
    if (cur.length) greedy.push(cur);
    if (st.maxLines === 2 && greedy.length > 2){
      let best = 1, bw = Infinity;
      for (let s = 1; s < n; s++){
        const m = Math.max(lineW(all.slice(0,s)), lineW(all.slice(s)));
        if (m < bw){ bw = m; best = s; }
      }
      lines = [all.slice(0,best), all.slice(best)];
    } else lines = greedy;
  }
  const nL = lines.length;
  const lineData = [];
  for (let L2 = 0; L2 < nL; L2++){
    const idxs = lines[L2];
    const total = lineW(idxs);
    const x0 = (W - total) / 2;
    let x = x0;
    const baseline = baseY - (nL - 1 - L2) * lineH;
    const boxTop = baseline - boxTopOff;
    const rects = [];
    for (const k of idxs){ const w = widths[k]; rects.push({ x, w }); x += w + gap; }
    lineData.push({ idxs, total, x0, rects, baseline, boxTop });
  }
  return { fs, padX, padY, padL, padR, padT, padB, gap, lineH, maxW, baseY, n, textW, asc, desc,
           boxH, boxTopOff, widths, lines: lineData, nL };
}

/* ---------- text shadow (its own layer, usable with every caption preset) ----------
   The shadow can sit either behind the caption box (classic) or above it, so an
   animated box slides in *behind* the shadow while the letters stay crisp on top. */
let CUR_SCALE = 1;
let SHADOW_LAYER_CANVAS = null;

function shadowGeom(st){
  if (!st.shadowType || st.shadowType === "none" || !(st.shadowOpacity > 0)) return null;
  const radians = (st.shadowDirection || 0) * Math.PI / 180;
  const k = (st.fontSize || 64) / 64;
  const distance = Math.max(0, st.shadowDistance || 0) * k;
  const hex = (st.shadowColor || "#000000").replace("#", "");
  return {
    dx: Math.cos(radians) * distance,
    dy: Math.sin(radians) * distance,
    distance,
    blur: Math.max(0, st.shadowBlur || 0) * k,
    alpha: st.shadowOpacity / 100,
    r: parseInt(hex.slice(0,2),16) || 0,
    g: parseInt(hex.slice(2,4),16) || 0,
    b: parseInt(hex.slice(4,6),16) || 0
  };
}
function shadowWords(t, st, seg, L){
  const act = activeWordIndex(seg, t);
  const activeOnly = st.shadowScope === "active";
  const picks = [];
  for (const line of L.lines){
    for (let k = 0; k < line.idxs.length; k++){
      const i = line.idxs[k];
      if (activeOnly){ if (i !== act) continue; }
      else if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      picks.push({ i, r: line.rects[k], baseline: line.baseline, boxTop: line.boxTop });
    }
  }
  return picks;
}
function fadeAt(st, p){
  if (st.shadowFade === "out")  return 1 - p;
  if (st.shadowFade === "in")   return p;
  if (st.shadowFade === "both") return Math.min(p, 1-p) * 2;
  return 1;
}
function paintTextShadow(ctx, t, st, seg, L, sh){
  for (const w of shadowWords(t, st, seg, L)){
    ctx.save();
    ctx.font = fontStr(st, L.fs, seg.em[w.i]);
    const drawAt = (ox, oy, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = `rgb(${sh.r},${sh.g},${sh.b})`;
      ctx.fillText(seg.words[w.i], w.r.x + L.padX + ox, w.baseline + oy);
    };
    if (st.shadowType === "drop"){
      ctx.shadowColor = `rgba(${sh.r},${sh.g},${sh.b},${sh.alpha})`;
      ctx.shadowBlur = sh.blur;
      ctx.shadowOffsetX = sh.dx; ctx.shadowOffsetY = sh.dy;
      drawAt(0, 0, 1);
    } else {
      ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      const steps = Math.max(1, Math.min(80, Math.ceil(sh.distance)));
      for (let step = steps; step >= 1; step--){
        const p = step / steps;
        drawAt(sh.dx * p, sh.dy * p, sh.alpha * (st.shadowFade === "none" ? 1 : Math.max(0, fadeAt(st, p))));
      }
    }
    ctx.restore();
  }
}
/* Optional: the caption box drops a shadow of its own. Always painted behind the box. */
function paintBoxShadow(ctx, t, st, seg, L, sh){
  const seen = Object.create(null);
  for (const w of shadowWords(t, st, seg, L)){
    const key = w.r.x.toFixed(2) + "|" + w.boxTop.toFixed(2);
    if (seen[key]) continue;
    seen[key] = 1;
    ctx.save();
    const paint = (ox, oy, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = `rgb(${sh.r},${sh.g},${sh.b})`;
      roundRect(ctx, w.r.x + ox, w.boxTop + oy, w.r.w, L.boxH, st.corner);
      ctx.fill();
    };
    if (st.shadowType === "drop"){
      ctx.shadowColor = `rgba(${sh.r},${sh.g},${sh.b},${sh.alpha})`;
      ctx.shadowBlur = sh.blur;
      ctx.shadowOffsetX = sh.dx; ctx.shadowOffsetY = sh.dy;
      paint(0, 0, 1);
    } else {
      const steps = Math.max(1, Math.min(80, Math.ceil(sh.distance)));
      for (let step = steps; step >= 1; step--){
        const p = step / steps;
        paint(sh.dx * p, sh.dy * p, sh.alpha * (st.shadowFade === "none" ? 1 : Math.max(0, fadeAt(st, p))));
      }
    }
    ctx.restore();
  }
}
/* Cut the letter shapes back out of the shadow layer, so a shadow drawn above the
   box never muddies the text it belongs to. */
function punchGlyphs(ctx, t, st, seg, L){
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  ctx.lineJoin = "round"; ctx.miterLimit = 2;
  const lw = strokeW(st, L.fs);
  for (const w of shadowWords(t, st, seg, L)){
    ctx.font = fontStr(st, L.fs, seg.em[w.i]);
    const x = w.r.x + L.padX, y = w.baseline;
    if (lw > 0.1){ ctx.lineWidth = lw; ctx.strokeText(seg.words[w.i], x, y); }
    ctx.fillText(seg.words[w.i], x, y);
  }
  ctx.restore();
}
function shadowScratch(ctx){
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  if (!SHADOW_LAYER_CANVAS) SHADOW_LAYER_CANVAS = document.createElement("canvas");
  const c = SHADOW_LAYER_CANVAS;
  if (c.width !== cw || c.height !== ch){ c.width = cw; c.height = ch; }
  const lx = c.getContext("2d");
  lx.setTransform(1, 0, 0, 1, 0, 0);
  lx.clearRect(0, 0, cw, ch);
  lx.setTransform(CUR_SCALE, 0, 0, CUR_SCALE, 0, 0);
  lx.textBaseline = "alphabetic";
  return { canvas: c, ctx: lx };
}

function drawSegment(ctx, W, H, t, st, seg){
  const L = layoutSegment(ctx, W, H, st, seg);
  if (!L) return;
  const sh = shadowGeom(st);
  const above = sh && st.shadowLayer !== "behind";
  if (sh && st.shadowBox) paintBoxShadow(ctx, t, st, seg, L, sh);
  if (sh && !above) paintTextShadow(ctx, t, st, seg, L, sh);
  (RENDERERS[st.preset] || RENDERERS.box)(ctx, W, H, t, st, seg, L);
  if (above){
    // Paint the shadow on its own layer, cut the letters out of it, then lay it over
    // the finished caption: the box (animated or not) ends up behind the shadow.
    const lay = shadowScratch(ctx);
    paintTextShadow(lay.ctx, t, st, seg, L, sh);
    punchGlyphs(lay.ctx, t, st, seg, L);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(lay.canvas, 0, 0);
    ctx.restore();
  }
}

/* =====================================================================
   CORE RENDERERS
   ===================================================================== */
function renderBox(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const tracks = animTracks(st);
  const doOut = st.animOut && st.animIn !== "none";
  // boxMode 0 = a single box that follows the spoken word. Pick that one word up-front
  // (latest start wins) so two boxes can never be drawn in the same frame.
  let solo = -1;
  if (st.boxMode === 0){
    let best = -Infinity;
    for (let i = 0; i < seg.words.length; i++){
      const w = seg.wt[i];
      if (t >= w.s && t < w.e && w.s >= best){ best = w.s; solo = i; }
    }
  }
  for (const line of L.lines){
    const idxs = line.idxs, rects = line.rects, baseline = line.baseline, boxTop = line.boxTop;
    if (st.boxMode === 3){
      let wi = -1;
      for (let k = 0; k < idxs.length; k++) if (t >= seg.wt[idxs[k]].s) wi = k;
      if (wi < 0) continue;
      const curIdx = idxs[wi];
      const wStart = seg.wt[curIdx].s, wEnd = seg.wt[curIdx].e;
      const gd = Math.max(0.01, Math.min(st.popTime, (wEnd - wStart) * 0.9));
      let rx, rw;
      if (wi > 0 && t < wStart + gd){
        const u = smooth(clamp((t - wStart) / gd, 0, 1));
        rx = lerp(rects[wi-1].x, rects[wi].x, u);
        rw = lerp(rects[wi-1].w, rects[wi].w, u);
      } else { rx = rects[wi].x; rw = rects[wi].w; }
      const firstStart = seg.wt[idxs[0]].s, lastEnd = seg.wt[idxs[idxs.length-1]].e;
      if (t < firstStart || t >= lastEnd) continue;
      const win = Math.max(0.04, lastEnd - firstStart);
      const inDur  = Math.max(0.01, Math.min(st.popTime, doOut ? win*0.5 : win));
      const outDur = Math.max(0.01, Math.min(st.outTime, win*0.5));
      let sx=100, sy=100, dx=0, dy=0, rot=0, alpha=100;
      const apply = pp => {
        if (tracks.sx) sx = kf(tracks.sx, pp);
        if (tracks.sy) sy = kf(tracks.sy, pp);
        if (tracks.dx) dx = kf(tracks.dx, pp);
        if (tracks.dy) dy = kf(tracks.dy, pp);
        if (tracks.rot) rot = kf(tracks.rot, pp);
        if (tracks.alpha) alpha = kf(tracks.alpha, pp);
      };
      apply(clamp((t - firstStart) / inDur, 0, 1));
      if (doOut && t > lastEnd - outDur) apply(1 - clamp((t - (lastEnd - outDur)) / outDur, 0, 1));
      const em = seg.em[curIdx];
      const bcol = (em && st.emBoxColor) ? st.emBoxColor : st.boxColor;
      const ox = rx + rw * tracks.ox, oy = boxTop + boxH / 2;
      ctx.save();
      ctx.globalAlpha = alpha / 100;
      ctx.translate(dx, dy);
      ctx.translate(ox, oy);
      if (rot) ctx.rotate(rot * Math.PI / 180);
      ctx.scale(sx/100, sy/100);
      ctx.translate(-ox, -oy);
      roundRect(ctx, rx, boxTop, rw, boxH, st.corner);
      ctx.fillStyle = bcol; ctx.fill();
      ctx.restore();
      for (let k = 0; k < idxs.length; k++){
        const i = idxs[k];
        ctx.font = fontStr(st, fs, seg.em[i]);
        ctx.fillStyle = (seg.em[i] && st.emTextColor) ? st.emTextColor : st.textColor;
        ctx.fillText(seg.words[i], rects[k].x + padX, baseline);
      }
      continue;
    }
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k];
      const wi = seg.wt[i];
      if (st.boxMode === 0 && i !== solo) continue;
      let tIn, tOut;
      if (st.boxMode === 0){ tIn = wi.s; tOut = wi.e; }
      else if (st.boxMode === 1){ tIn = wi.s; tOut = seg.end; }
      else { tIn = Math.min(seg.start + st.stagger * i, seg.end - 0.02); tOut = seg.end; }
      if (t < tIn || t >= tOut) continue;
      const win = Math.max(0.04, tOut - tIn);
      const inDur  = Math.max(0.01, Math.min(st.popTime, doOut ? win*0.5 : win));
      const outDur = Math.max(0.01, Math.min(st.outTime, win*0.5));
      let sx=100, sy=100, dx=0, dy=0, rot=0, alpha=100;
      const apply = pp => {
        if (tracks.sx) sx = kf(tracks.sx, pp);
        if (tracks.sy) sy = kf(tracks.sy, pp);
        if (tracks.dx) dx = kf(tracks.dx, pp);
        if (tracks.dy) dy = kf(tracks.dy, pp);
        if (tracks.rot) rot = kf(tracks.rot, pp);
        if (tracks.alpha) alpha = kf(tracks.alpha, pp);
      };
      apply(clamp((t - tIn) / inDur, 0, 1));
      if (doOut && t > tOut - outDur) apply(1 - clamp((t - (tOut - outDur)) / outDur, 0, 1));
      const r  = rects[k];
      const em = seg.em[i];
      const bcol = (em && st.emBoxColor) ? st.emBoxColor : st.boxColor;
      const ox = r.x + r.w * tracks.ox, oy = boxTop + boxH / 2;
      ctx.save();
      ctx.globalAlpha = alpha / 100;
      ctx.translate(dx, dy);
      ctx.translate(ox, oy);
      if (rot) ctx.rotate(rot * Math.PI / 180);
      ctx.scale(sx/100, sy/100);
      ctx.translate(-ox, -oy);
      roundRect(ctx, r.x, boxTop, r.w, boxH, st.corner);
      ctx.fillStyle = bcol; ctx.fill();
      ctx.restore();
    }
    for (let k = 0; k < idxs.length; k++){
      const i  = idxs[k];
      const em = seg.em[i];
      const tcol = (em && st.emTextColor) ? st.emTextColor : st.textColor;
      ctx.font = fontStr(st, fs, em);
      ctx.fillStyle = tcol;
      ctx.fillText(seg.words[i], rects[k].x + padX, baseline);
    }
  }
}
function renderPill(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const tracks = animTracks(st);
  const doOut = st.animOut && st.animIn !== "none";
  const act = activeWordIndex(seg, t);
  const win = Math.max(0.04, seg.end - seg.start);
  const inDur  = Math.max(0.01, Math.min(st.popTime, doOut ? win*0.5 : win));
  const outDur = Math.max(0.01, Math.min(st.outTime, win*0.5));
  const sw = strokeW(st, fs);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop, x0, total } = line;
    let sx=100, sy=100, dx=0, dy=0, rot=0, alpha=100;
    const apply = pp => {
      if (tracks.sx) sx = kf(tracks.sx, pp);
      if (tracks.sy) sy = kf(tracks.sy, pp);
      if (tracks.dx) dx = kf(tracks.dx, pp);
      if (tracks.dy) dy = kf(tracks.dy, pp);
      if (tracks.rot) rot = kf(tracks.rot, pp);
      if (tracks.alpha) alpha = kf(tracks.alpha, pp);
    };
    apply(clamp((t - seg.start) / inDur, 0, 1));
    if (doOut && t > seg.end - outDur) apply(1 - clamp((t - (seg.end - outDur)) / outDur, 0, 1));
    const cx = x0 + total / 2, cy = boxTop + boxH / 2;
    const bx = x0 - padX * 0.6, bw = total + padX * 1.2;
    ctx.save();
    ctx.globalAlpha = alpha / 100;
    ctx.translate(dx, dy);
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(rot * Math.PI / 180);
    ctx.scale(sx/100, sy/100);
    ctx.translate(-cx, -cy);
    roundRect(ctx, bx, boxTop, bw, boxH, Math.min(st.corner, boxH / 2));
    ctx.fillStyle = st.boxColor; ctx.fill();
    ctx.restore();
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const r = rects[k];
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, seg.em[i]);
      const col = isAct ? accentOf(st) : st.textColor;
      wordXform(ctx, r, boxTop, boxH, isAct ? 1.07 : 1, 0, 0, 0, () => {
        fillStroked(ctx, seg.words[i], r.x + padX, baseline, col, strokeOf(st), sw);
      });
    }
  }
}
function renderKaraoke(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  const sw = strokeW(st, fs);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k], w = seg.wt[i];
      let col, alpha;
      if (t < w.s){ col = st.textColor; alpha = 0.32; }
      else if (t < w.e){ col = accentOf(st); alpha = 1; }
      else { col = st.textColor; alpha = 1; }
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = fontStr(st, fs, seg.em[i]);
      const sc = (i === act) ? 1.10 : 1;
      wordXform(ctx, r, boxTop, boxH, sc, 0, 0, 0, () => {
        fillStroked(ctx, seg.words[i], r.x + padX, baseline, col, strokeOf(st), sw);
      });
      ctx.restore();
    }
  }
}
function renderHighlight(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  const sw = strokeW(st, fs);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      if (isAct){
        const mh = boxH * 0.94, my = boxTop + boxH * 0.03;
        roundRect(ctx, r.x + padX * 0.25, my, r.w - padX * 0.5, mh, Math.min(st.corner, 8));
        ctx.fillStyle = accentOf(st); ctx.fill();
      }
      ctx.font = fontStr(st, fs, seg.em[i]);
      const col = isAct ? st.emTextColor : st.textColor;
      fillStroked(ctx, seg.words[i], r.x + padX, baseline, col,
                  isAct ? null : strokeOf(st), isAct ? 0 : sw);
    }
  }
}
function renderOutline(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  const sw = Math.max(0.5, strokeW(st, fs));
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, seg.em[i]);
      const col = isAct ? accentOf(st) : st.textColor;
      wordXform(ctx, r, boxTop, boxH, isAct ? 1.08 : 1, 0, 0, 0, () => {
        fillStroked(ctx, seg.words[i], r.x + padX, baseline, col, strokeOf(st), sw * 2);
      });
    }
  }
}
function renderShadow(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.save();
      ctx.font = fontStr(st, fs, seg.em[i]);
      setPresetShadow(ctx, st, "rgba(0,0,0,0.85)", fs * 0.18, 0, fs * 0.05);
      ctx.fillStyle = isAct ? accentOf(st) : st.textColor;
      wordXform(ctx, r, boxTop, boxH, isAct ? 1.08 : 1, 0, 0, 0, () => {
        ctx.fillText(seg.words[i], r.x + padX, baseline);
      });
      ctx.restore();
    }
  }
}
function renderNeon(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      const glow = isAct ? accentOf(st) : st.boxColor;
      ctx.save();
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.lineJoin = "round";
      setPresetShadow(ctx, st, glow, fs * 0.60, 0, 0);
      ctx.fillStyle = isAct ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
      ctx.fillText(seg.words[i], r.x + padX, baseline);
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#ffffff";
      ctx.globalAlpha = isAct ? 1 : 0.88;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
      ctx.restore();
    }
  }
}
function renderBounce(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const sw = strokeW(st, fs);
  const dur = Math.max(0.08, st.popTime * 2);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      const ws = seg.wt[i].s;
      if (t < ws) continue;
      const p = clamp((t - ws) / dur, 0, 1);
      const sc = p < 0.6 ? lerp(0.15, 1.18, smooth(p / 0.6)) : lerp(1.18, 1, smooth((p - 0.6) / 0.4));
      const rot = (i % 2 ? 1 : -1) * (1 - p) * 9;
      ctx.font = fontStr(st, fs, seg.em[i]);
      const col = seg.em[i] ? accentOf(st) : st.textColor;
      wordXform(ctx, r, boxTop, boxH, sc, 0, 0, rot, () => {
        fillStroked(ctx, seg.words[i], r.x + padX, baseline, col, strokeOf(st), sw);
      });
    }
  }
}
function renderTypewriter(ctx, W, H, t, st, seg, L){
  const { fs, padX } = L;
  let last = null;
  for (const line of L.lines){
    const { idxs, rects, baseline } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (t < seg.wt[i].s) continue;
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = seg.em[i] ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
      last = { r, baseline };
    }
  }
  if (last && Math.floor(t * 2.5) % 2 === 0){
    ctx.fillStyle = accentOf(st);
    ctx.fillRect(last.r.x + last.r.w - padX + fs * 0.05,
                 last.baseline - fs * 0.76, fs * 0.46, fs * 0.88);
  }
}
function renderBlock(ctx, W, H, t, st, seg, L){
  const { fs, padX, gap, boxH, widths, maxW } = L;
  const act = activeWordIndex(seg, t);
  const barW = Math.min(maxW, W * 0.92);
  const barX = (W - barW) / 2;
  for (const line of L.lines){
    const { idxs, baseline, boxTop } = line;
    let x = barX + fs * 0.14 + padX * 1.4;
    const rects = [];
    for (const i of idxs){ rects.push({ x, w: widths[i] }); x += widths[i] + gap; }
    ctx.save();
    ctx.globalAlpha = 0.86;
    ctx.fillStyle = st.boxColor;
    ctx.fillRect(barX, boxTop, barW, boxH);
    ctx.restore();
    ctx.fillStyle = accentOf(st);
    ctx.fillRect(barX, boxTop, Math.max(3, fs * 0.10), boxH);
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = (i === act) ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}
function renderTiktok(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  const lw = Math.max(1, strokeW(st, fs));
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      const off = presetOffset(st, fs * 0.085);
      ctx.font = fontStr(st, fs, seg.em[i]);
      wordXform(ctx, r, boxTop, boxH, isAct ? 1.12 : 1, 0, 0, 0, () => {
        ctx.fillStyle = isAct ? "#ffffff" : accentOf(st);
        ctx.fillText(seg.words[i], r.x + padX + off, baseline + off);
        ctx.lineJoin = "round"; ctx.miterLimit = 2;
        ctx.lineWidth = lw * 2; ctx.strokeStyle = strokeOf(st);
        ctx.strokeText(seg.words[i], r.x + padX, baseline);
        ctx.fillStyle = isAct ? accentOf(st) : st.textColor;
        ctx.fillText(seg.words[i], r.x + padX, baseline);
      });
    }
  }
}
function renderGradient(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    const g = ctx.createLinearGradient(0, boxTop, 0, boxTop + boxH);
    g.addColorStop(0, st.textColor); g.addColorStop(1, accentOf(st));
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.save();
      ctx.font = fontStr(st, fs, seg.em[i]);
      setPresetShadow(ctx, st, "rgba(0,0,0,.55)", fs * 0.22, 0, fs * 0.04);
      ctx.fillStyle = isAct ? accentOf(st) : g;
      wordXform(ctx, r, boxTop, boxH, isAct ? 1.08 : 1, 0, 0, 0, () => {
        ctx.fillText(seg.words[i], r.x + padX, baseline);
      });
      ctx.restore();
    }
  }
}
function renderCinematic(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.save();
      ctx.font = fontStr(st, fs, seg.em[i]);
      setPresetShadow(ctx, st, "rgba(0,0,0,.6)", fs * 0.25, 0, 0);
      ctx.fillStyle = isAct ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
      ctx.restore();
    }
  }
}
function renderRebel(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  const lw = Math.max(1, strokeW(st, fs));
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      const off = presetOffset(st, fs * 0.06);
      ctx.font = fontStr(st, fs, seg.em[i]);
      wordXform(ctx, r, boxTop, boxH, isAct ? 1.10 : 1, 0, 0, 0, () => {
        ctx.fillStyle = strokeOf(st);
        ctx.fillText(seg.words[i], r.x + padX + off, baseline + off);
        ctx.lineJoin = "round"; ctx.miterLimit = 2;
        ctx.lineWidth = lw; ctx.strokeStyle = strokeOf(st);
        ctx.strokeText(seg.words[i], r.x + padX, baseline);
        ctx.fillStyle = isAct ? accentOf(st) : st.textColor;
        ctx.fillText(seg.words[i], r.x + padX, baseline);
      });
    }
  }
}
function renderY2k(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, seg.em[i]);
      const y2kOff = presetOffset(st, Math.max(1.5, fs * 0.022));
      if (y2kOff){
        ctx.fillStyle = "#ff00ff";
        ctx.fillText(seg.words[i], r.x + padX + y2kOff, baseline + y2kOff);
        ctx.fillStyle = "#00ffff";
        ctx.fillText(seg.words[i], r.x + padX - y2kOff, baseline - y2kOff);
      }
      ctx.fillStyle = isAct ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}
function renderChalk(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.save();
      ctx.font = fontStr(st, fs, seg.em[i]);
      setPresetShadow(ctx, st, "rgba(255,255,255,.4)", fs * 0.15, 0, 0);
      ctx.fillStyle = isAct ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
      ctx.restore();
    }
  }
}

/* =====================================================================
   NEW RENDERERS — reference-inspired
   ===================================================================== */

/* Corner bracket frame — L-shaped corners around the whole line */
function renderCornerFrame(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  const sw = Math.max(2, fs * 0.06);
  for (const line of L.lines){
    const { idxs, rects, x0, total, boxTop, baseline } = line;
    const pad = fs * 0.28;
    const cLen = fs * 0.42;
    const bx = x0 - padX - pad;
    const by = boxTop - pad;
    const bw = total + padX * 2 + pad * 2;
    const bh = boxH + pad * 2;
    ctx.strokeStyle = accentOf(st);
    ctx.lineWidth = sw;
    ctx.lineCap = "square";
    ctx.beginPath();
    ctx.moveTo(bx, by + cLen);         ctx.lineTo(bx, by);         ctx.lineTo(bx + cLen, by);
    ctx.moveTo(bx + bw - cLen, by);    ctx.lineTo(bx + bw, by);    ctx.lineTo(bx + bw, by + cLen);
    ctx.moveTo(bx + bw, by + bh - cLen); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw - cLen, by + bh);
    ctx.moveTo(bx + cLen, by + bh);    ctx.lineTo(bx, by + bh);    ctx.lineTo(bx, by + bh - cLen);
    ctx.stroke();
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = (i === act) ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Vertical bars flanking the entire line */
function renderSideBars(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  const barW = Math.max(3, fs * 0.10);
  for (const line of L.lines){
    const { idxs, rects, x0, total, boxTop, baseline } = line;
    ctx.fillStyle = accentOf(st);
    ctx.fillRect(x0 - padX * 0.6 - barW, boxTop, barW, boxH);
    ctx.fillRect(x0 + total + padX * 0.6, boxTop, barW, boxH);
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = (i === act) ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Slanted parallelogram behind the whole line */
function renderSlantBox(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, x0, total, boxTop, baseline } = line;
    const skew = boxH * 0.28;
    const bx = x0 - padX * 0.7;
    const bw = total + padX * 1.4;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(bx + skew, boxTop);
    ctx.lineTo(bx + bw, boxTop);
    ctx.lineTo(bx + bw - skew, boxTop + boxH);
    ctx.lineTo(bx, boxTop + boxH);
    ctx.closePath();
    ctx.fillStyle = st.boxColor;
    ctx.fill();
    ctx.restore();
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      ctx.font = fontStr(st, fs, true); // italic
      const isAct = (i === act);
      ctx.fillStyle = isAct ? "#ffffff" : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Yellow strip behind active word only */
function renderAccentStrip(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      if (isAct){
        ctx.fillStyle = accentOf(st);
        ctx.fillRect(r.x + padX * 0.3, boxTop + boxH * 0.08,
                     r.w - padX * 0.6, boxH * 0.84);
      }
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = isAct ? st.emTextColor : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Hollow outline text */
function renderOutlineText(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  const lw = Math.max(1.5, fs * 0.05);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.lineJoin = "round"; ctx.miterLimit = 2;
      if (isAct){
        ctx.lineWidth = lw;
        ctx.strokeStyle = accentOf(st);
        ctx.strokeText(seg.words[i], r.x + padX, baseline);
      } else {
        ctx.lineWidth = lw;
        ctx.strokeStyle = st.strokeColor;
        ctx.strokeText(seg.words[i], r.x + padX, baseline);
      }
    }
  }
}

/* Split-tone: alternates word colors between accent and text */
function renderSplitTone(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, seg.em[i]);
      // first word gets accent color, rest alternate
      let col = st.textColor;
      if (i === 0 || (i % 2 === 1)) col = accentOf(st);
      if (isAct) col = st.emTextColor;
      ctx.fillStyle = col;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Small badge under the active word */
function renderBadgeBelow(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    // badges under all revealed words
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      const badgeH = fs * 0.18;
      const badgeY = boxTop + boxH + fs * 0.05;
      const badgeW = r.w * 0.55;
      const badgeX = r.x + (r.w - badgeW) / 2;
      ctx.fillStyle = isAct ? accentOf(st) : st.boxColor;
      ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = isAct ? st.emTextColor : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Diagonal slash between words */
function renderSlashSplit(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, true); // italic
      const col = isAct ? accentOf(st) : st.textColor;
      ctx.fillStyle = col;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
      // slash between words
      if (k > 0){
        const prevR = rects[k-1];
        const sx = prevR.x + prevR.w + (r.x - prevR.x - prevR.w) / 2;
        ctx.save();
        ctx.strokeStyle = accentOf(st);
        ctx.lineWidth = Math.max(2, fs * 0.06);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(sx - fs * 0.12, baseline);
        ctx.lineTo(sx + fs * 0.12, baseline - fs * 0.7);
        ctx.stroke();
        ctx.restore();
      }
    }
  }
}

/* Horizontal rule above text */
function renderHorizLine(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, x0, total, boxTop, baseline } = line;
    ctx.fillStyle = st.textColor;
    ctx.fillRect(x0, boxTop - fs * 0.05, total, Math.max(2, fs * 0.04));
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = isAct ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Nested double outline box */
function renderDoubleFrame(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  const gap = Math.max(3, fs * 0.08);
  const lw = Math.max(2, fs * 0.04);
  for (const line of L.lines){
    const { idxs, rects, x0, total, boxTop, baseline } = line;
    const bx = x0 - padX * 0.6, bw = total + padX * 1.2;
    ctx.strokeStyle = accentOf(st);
    ctx.lineWidth = lw;
    ctx.strokeRect(bx, boxTop, bw, boxH);
    ctx.strokeRect(bx - gap, boxTop - gap, bw + gap * 2, boxH + gap * 2);
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = isAct ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Thick left accent bar */
function renderLeftBar(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  const barW = Math.max(4, fs * 0.14);
  for (const line of L.lines){
    const { idxs, rects, x0, total, boxTop, baseline } = line;
    ctx.fillStyle = accentOf(st);
    ctx.fillRect(x0 - padX - barW - fs * 0.08, boxTop - fs * 0.05,
                 barW, boxH + fs * 0.1);
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = isAct ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Colored underline under each revealed word */
function renderUnderlineAcc(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  const uH = Math.max(3, fs * 0.06);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      // underline
      ctx.fillStyle = isAct ? accentOf(st) : st.boxColor;
      ctx.fillRect(r.x + padX * 0.3, baseline + fs * 0.12,
                   r.w - padX * 0.6, uH);
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = isAct ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Small caps header strip above text */
function renderStripeHeader(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, x0, total, boxTop, baseline } = line;
    // top strip
    ctx.fillStyle = accentOf(st);
    ctx.fillRect(x0, boxTop - fs * 0.15, total, Math.max(3, fs * 0.06));
    // small caps header text (single-letter caps placeholders)
    ctx.font = '700 ' + Math.round(fs * 0.18) + 'px "' + st.fontFamily + '", sans-serif';
    ctx.fillStyle = st.textColor;
    ctx.textBaseline = "alphabetic";
    ctx.fillText("• " + seg.words.length + " WORDS", x0, boxTop - fs * 0.20);
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = isAct ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Neon corner glow frame */
function renderNeonFrame(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  const sw = Math.max(2, fs * 0.05);
  for (const line of L.lines){
    const { idxs, rects, x0, total, boxTop, baseline } = line;
    const pad = fs * 0.26, cLen = fs * 0.42;
    const bx = x0 - padX - pad, by = boxTop - pad;
    const bw = total + padX * 2 + pad * 2, bh = boxH + pad * 2;
    ctx.save();
    ctx.shadowColor = accentOf(st);
    ctx.shadowBlur = fs * 0.35;
    ctx.strokeStyle = accentOf(st);
    ctx.lineWidth = sw;
    ctx.lineCap = "square";
    ctx.beginPath();
    ctx.moveTo(bx, by + cLen);           ctx.lineTo(bx, by);           ctx.lineTo(bx + cLen, by);
    ctx.moveTo(bx + bw - cLen, by);      ctx.lineTo(bx + bw, by);      ctx.lineTo(bx + bw, by + cLen);
    ctx.moveTo(bx + bw, by + bh - cLen); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw - cLen, by + bh);
    ctx.moveTo(bx + cLen, by + bh);      ctx.lineTo(bx, by + bh);      ctx.lineTo(bx, by + bh - cLen);
    ctx.stroke();
    ctx.restore();
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = (i === act) ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Vintage cinema bar with letter spacing */
function renderCinemaBar(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, x0, total, boxTop, baseline } = line;
    const bx = x0 - padX * 0.5, bw = total + padX * 1;
    ctx.fillStyle = st.boxColor;
    ctx.fillRect(bx, boxTop, bw, boxH);
    ctx.strokeStyle = accentOf(st);
    ctx.lineWidth = Math.max(1, fs * 0.02);
    ctx.strokeRect(bx + fs * 0.05, boxTop + fs * 0.05, bw - fs * 0.1, boxH - fs * 0.1);
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = isAct ? "#ffffff" : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Big red bar (DAVID WILSON) */
function renderRedBar(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, x0, total, boxTop, baseline } = line;
    const bx = x0 - padX * 0.3, bw = total + padX * 0.6;
    ctx.fillStyle = st.boxColor;
    ctx.fillRect(bx, boxTop, bw, boxH);
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = isAct ? accentOf(st) : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* White bar with red text */
function renderWhiteBar(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, x0, total, boxTop, baseline } = line;
    const bx = x0 - padX * 0.3, bw = total + padX * 0.6;
    ctx.fillStyle = st.boxColor;
    ctx.fillRect(bx, boxTop, bw, boxH);
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, seg.em[i]);
      ctx.fillStyle = isAct ? "#ffffff" : st.textColor;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* Stacked two-color name (word 1 accent, word 2 white) */
function renderStacked(ctx, W, H, t, st, seg, L){
  const { fs, padX, boxH } = L;
  const act = activeWordIndex(seg, t);
  for (const line of L.lines){
    const { idxs, rects, baseline, boxTop } = line;
    for (let k = 0; k < idxs.length; k++){
      const i = idxs[k], r = rects[k];
      if (!revealed(seg, i, t, st.revealMode) && i !== act) continue;
      const isAct = (i === act);
      ctx.font = fontStr(st, fs, seg.em[i]);
      // alternate first word red, second white
      const col = (i === 0) ? accentOf(st) : st.textColor;
      ctx.fillStyle = isAct ? "#ffffff" : col;
      ctx.fillText(seg.words[i], r.x + padX, baseline);
    }
  }
}

/* =====================================================================
   RENDER LOOP
   ===================================================================== */
function renderLoop(){
  requestAnimationFrame(renderLoop);
  if (!video || !SW || !SH || !state.videoFile) return;
  const t = video.currentTime;
  if (!dirty && t === lastDrawTime) return;
  lastDrawTime = t; dirty = false;
  octx.setTransform(1,0,0,1,0,0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  drawCaptions(octx, SW, SH, t, state.style, state.segments, SCALE);
}

/* =====================================================================
   STAGE / BACKGROUND / MODE
   ===================================================================== */
function fitContain(sw, sh, dw, dh){
  const s = Math.min(dw / sw, dh / sh);
  return [sw * s, sh * s];
}
function recomputeStage(){
  const aspect = state.style.stageAspect || "auto";
  if (aspect === "custom"){
    // An explicit project size (chosen when importing audio, or typed in the Style tab).
    const pw = clamp(Math.round(state.style.projW || 1080), 64, 4096);
    const ph = clamp(Math.round(state.style.projH || 1920), 64, 4096);
    if (state.mode === "audio"){ SW = pw; SH = ph; }
    else {
      // Video keeps its own pixels; the project size only sets the frame shape.
      const targetAR = pw / ph, videoAR = (VW && VH) ? VW / VH : targetAR;
      if (!VW || !VH){ SW = pw; SH = ph; }
      else if (videoAR > targetAR){ SW = VW; SH = Math.round(VW / targetAR); }
      else { SH = VH; SW = Math.round(VH * targetAR); }
    }
    SCALE = Math.min(1, 1600 / Math.max(SW, SH));
    overlay.width  = Math.round(SW * SCALE);
    overlay.height = Math.round(SH * SCALE);
    dirty = true;
    return;
  }
  if (state.mode === "audio"){
    let aw, ah;
    if (aspect === "auto" && VW && VH){ aw = VW; ah = VH; }
    else if (aspect === "auto"){ aw = 16; ah = 9; }
    else { [aw, ah] = aspect.split(":").map(Number); }
    const longSide = 1920;
    if (aw >= ah){ SW = longSide; SH = Math.round(longSide * ah / aw); }
    else { SH = longSide; SW = Math.round(longSide * aw / ah); }
  } else {
    if (aspect === "auto" || !VW || !VH){ SW = VW; SH = VH; }
    else {
      const [aw, ah] = aspect.split(":").map(Number);
      const targetAR = aw / ah;
      const videoAR = VW / VH;
      if (videoAR > targetAR){ SW = VW; SH = Math.round(VW / targetAR); }
      else { SH = VH; SW = Math.round(VH * targetAR); }
    }
  }
  SCALE = Math.min(1, 1600 / Math.max(SW, SH));
  overlay.width  = Math.round(SW * SCALE);
  overlay.height = Math.round(SH * SCALE);
  dirty = true;
}
function applyModeUI(){
  const isAudio = state.mode === "audio";
  $("#videoShell").classList.toggle("audio-mode", isAudio);
  $$("#modeSwitch button").forEach(b => b.classList.toggle("active", b.dataset.mode === state.mode));
}
function setMode(mode){
  if (!state.videoFile) return;
  if (state.audioOnlySource && mode === "video") return;
  state.mode = mode;
  applyModeUI();
  if (VW && VH){ recomputeStage(); fitStage(); renderTimeline(); }
  dirty = true;
}
function applyVideoBgToShell(){
  const shell = $("#videoShell");
  shell.style.background = state.style.videoBgColor;
  shell.style.setProperty("--video-bg", state.style.videoBgColor);
}
function getStageDims(){ return { w: SW, h: SH }; }
function fitStage(){
  const shell = $("#videoShell");
  if (!SW || !SH) return;
  const availW = shell.parentElement.clientWidth;
  const availH = window.innerHeight * 0.56;
  const s = Math.min(availW / SW, availH / SH);
  shell.style.width  = Math.round(SW * s) + "px";
  shell.style.height = Math.round(SH * s) + "px";
  shell.style.margin = "0 auto";
}
window.addEventListener("resize", fitStage);

/* =====================================================================
   VIDEO
   ===================================================================== */
video = $("#video");
overlay = $("#overlay");
octx = overlay.getContext("2d");

function loadVideoFile(file, mode){
  if (!file) return;
  state.videoFile = file;
  state.audioOnlySource = isAudioFile(file);
  state.mode = state.audioOnlySource ? "audio" : (mode || "video");
  const url = URL.createObjectURL(file);
  video.src = url;
  video.load();
  $("#emptyState").classList.add("hide");
  applyModeUI();
  const ms = $("#modeSwitch");
  ms.classList.toggle("disabled", !!state.audioOnlySource);
  ms.title = state.audioOnlySource
    ? "This file has no picture, so it stays in audio mode"
    : "Switch between video and audio-only";
}

video.addEventListener("loadedmetadata", function(){
  VW = video.videoWidth || 1080;
  VH = video.videoHeight || 1920;
  duration = video.duration || 0;
  recomputeStage();
  fitStage();
  if (PRJ_KEEP_FONT_SIZE){ PRJ_KEEP_FONT_SIZE = false; }
  else if (!state.style.fontSize || state.style.fontSize === 64){
    const fs = Math.round((SH || VH) * 0.055);
    state.style.fontSize = clamp(fs, 24, 200);
    $("#fontSize").value = Math.min(200, state.style.fontSize);
    $("#fontSizeNum").value = state.style.fontSize;
    $("#fsLabel").textContent = state.style.fontSize + " px";
  }
  renderTimeline(); dirty = true;
});
video.addEventListener("timeupdate", onTimeUpdate);
video.addEventListener("seeked", () => { dirty = true; });
video.addEventListener("play",  () => { $("#playBtn").textContent = "❚❚"; });
video.addEventListener("pause", () => { $("#playBtn").textContent = "▶"; });
video.addEventListener("ended", () => { $("#playBtn").textContent = "▶"; });

function onTimeUpdate(){
  if (!duration) return;
  const p = video.currentTime / duration;
  const sc = $("#scrub");
  sc.value = Math.round(p * 1000);
  sc.style.setProperty("--p", (p*100).toFixed(2) + "%");
  $("#timeLabel").textContent = fmtClock(video.currentTime) + " / " + fmtClock(duration);
  const head = document.querySelector(".tl-head");
  if (head) head.style.left = (p * 100) + "%";
  highlightActiveRow();
}

/* =====================================================================
   TIMELINE + CAPTION LIST
   ===================================================================== */
function renderTimeline(){
  const el = $("#timeline");
  el.innerHTML = "";
  if (!duration || state.captions.length === 0){
    el.innerHTML = '<div class="tl-empty">' + (state.captions.length === 0 ? "No captions yet" : "Timeline") + '</div>';
    return;
  }
  state.captions.forEach((c, i) => {
    const d = document.createElement("div");
    d.className = "tl-block";
    d.style.left  = (c.start / duration * 100) + "%";
    d.style.width = Math.max(0.4, (c.end - c.start) / duration * 100) + "%";
    d.title = c.text;
    d.addEventListener("click", () => { video.currentTime = Math.max(0, c.start + 0.01); dirty = true; });
    el.appendChild(d);
  });
  const head = document.createElement("div");
  head.className = "tl-head";
  head.style.left = (duration ? (video.currentTime / duration * 100) : 0) + "%";
  el.appendChild(head);
}
function setWc(el, c){
  if (!c.wt){ el.textContent = ""; el.title = "Estimated timing"; el.style.color = "#4d5568"; return; }
  const est = c.wt.filter(x => x && x.est).length, real = c.wt.length - est;
  el.textContent = real + "⌚" + (est ? " +" + est + "~" : "");
  el.title = real + " word(s) with real timing" + (est ? ", " + est + " estimated" : "");
  el.style.color = real > 0 ? "#5ee08c" : "#4d5568";
}
function syncRowMeta(){
  document.querySelectorAll(".cap-row").forEach(row => {
    const c = state.captions[parseInt(row.dataset.i, 10)];
    if (!c) return;
    const ins = row.querySelectorAll(".cap-times input");
    if (ins[0] && ins[0] !== document.activeElement) ins[0].value = fmtTime(c.start);
    if (ins[1] && ins[1] !== document.activeElement) ins[1].value = fmtTime(c.end);
    const wc = row.querySelector(".cap-wc"); if (wc) setWc(wc, c);
  });
}
function renderCapList(){
  const list = $("#capList");
  list.innerHTML = "";
  if (state.captions.length === 0){
    list.innerHTML = '<div class="hint">No captions yet. Import an SRT, paste text, or use the Transcribe tab.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  state.captions.forEach((c, idx) => {
    const row = document.createElement("div");
    row.className = "cap-row";
    row.dataset.i = idx;
    const wrap = document.createElement("div");
    const times = document.createElement("div");
    times.className = "cap-times";
    const inT = document.createElement("input"); inT.type = "text"; inT.value = fmtTime(c.start);
    const arrow = document.createElement("span"); arrow.textContent = "→";
    const outT = document.createElement("input"); outT.type = "text"; outT.value = fmtTime(c.end);
    const wcount = document.createElement("span");
    wcount.style.marginLeft = "auto"; wcount.className = "cap-wc";
    setWc(wcount, c);
    times.append(inT, arrow, outT, wcount);
    const ta = document.createElement("textarea");
    ta.rows = 2; ta.value = c.text;
    wrap.appendChild(times); wrap.appendChild(ta);
    const x = document.createElement("button");
    x.className = "cap-x"; x.textContent = "×"; x.title = "Delete";
    row.appendChild(wrap); row.appendChild(x);
    ta.addEventListener("input", () => {
      reconcileCaptionText(c, ta.value);
      rebuildSegments(); renderTimeline(); updateCapInfo(); syncRowMeta();
    });
    ta.addEventListener("focus", () => { video.currentTime = Math.max(0, c.start + 0.01); dirty = true; });
    inT.addEventListener("change", () => {
      const v = parseTimeStr(inT.value);
      if (!isNaN(v)){ c.start = v; sortCaptions(); }
      rebuildAll();
    });
    outT.addEventListener("change", () => {
      const v = parseTimeStr(outT.value);
      if (!isNaN(v)){ c.end = v; sortCaptions(); }
      rebuildAll();
    });
    x.addEventListener("click", () => { state.captions.splice(idx, 1); rebuildAll(); });
    frag.appendChild(row);
  });
  list.appendChild(frag);
}
function highlightActiveRow(){
  if (!duration) return;
  const t = video.currentTime;
  document.querySelectorAll(".cap-row").forEach(row => {
    const c = state.captions[parseInt(row.dataset.i, 10)];
    if (!c) return;
    const on = (t >= c.start && t < c.end);
    if (on !== row.classList.contains("active")) row.classList.toggle("active", on);
  });
}

/* =====================================================================
   REBUILD
   ===================================================================== */
function sortCaptions(){ state.captions.sort((a,b) => a.start - b.start); }
function rebuildSegments(){ state.segments = buildSegments(state.captions, state.style); dirty = true; }
function updateCapInfo(){
  const n = state.captions.length;
  let words = 0, withTime = 0;
  for (const c of state.captions){
    words += splitWords(c.text, false).length;
    if (c.wt && c.wt.some(x => x && !x.est)) withTime++;
  }
  $("#capInfo").innerHTML = n === 0 ? "No captions yet."
    : "<b>" + n + "</b> caption" + (n===1?"":"s") + " · <b>" + words + "</b> words" +
      (withTime > 0 ? " · <b style='color:#5ee08c'>" + withTime + "</b> word-timed" : "") +
      (duration ? " · " + fmtClock(duration) : "");
}
function rebuildAll(){
  sortCaptions(); rebuildSegments(); renderTimeline(); renderCapList(); updateCapInfo();
}

/* =====================================================================
   TRANSCRIPTION
   ===================================================================== */
/* ---- Audio extraction helpers (so big videos work, esp. on mobile) ---- */
const TR_SAMPLE_RATE = 16000;          // Whisper's native rate; keeps files tiny
const TR_CHUNK_SECONDS = 90;           // 90s of 16 kHz mono 16-bit WAV ≈ 2.9 MB (< 4 MB limit)
const TR_MAX_FILE_BYTES = 400 * 1024 * 1024; // decoding bigger files can crash phones

async function decodeToMono16k(file, onProgress){
  const AC = window.AudioContext || window.webkitAudioContext;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC || !OAC) throw new Error("This browser cannot extract audio. Please update your browser (Chrome, Safari 14.1+ or Firefox).");
  if (file.size > TR_MAX_FILE_BYTES) {
    throw new Error("This file is very large (" + (file.size/1048576).toFixed(0) + " MB). Please use a file under 400 MB, or trim it first.");
  }
  onProgress("Reading file…", 4);
  let buf;
  try { buf = await file.arrayBuffer(); }
  catch (_) { throw new Error("Could not read the file (your phone may be low on memory). Try a smaller file."); }
  onProgress("Extracting audio from video…", 8);
  const ctx = new AC();
  let decoded;
  try {
    // Safari older versions only support the callback form; wrap both.
    decoded = await new Promise((resolve, reject) => {
      const r = ctx.decodeAudioData(buf, resolve, reject);
      if (r && typeof r.then === "function") r.then(resolve, reject);
    });
  } catch (_) {
    throw new Error("Could not read audio from this file. Use MP4 (H.264/AAC), MOV, WebM, MP3, M4A or WAV.");
  } finally {
    buf = null;
    try { ctx.close(); } catch (_) {}
  }
  onProgress("Converting audio…", 12);
  const length = Math.max(1, Math.ceil(decoded.duration * TR_SAMPLE_RATE));
  const off = new OAC(1, length, TR_SAMPLE_RATE);   // downmixes to mono automatically
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start(0);
  const rendered = await new Promise((resolve, reject) => {
    const r = off.startRendering();
    if (r && typeof r.then === "function") r.then(resolve, reject);
    else off.oncomplete = e => resolve(e.renderedBuffer);
  });
  return rendered.getChannelData(0);
}
function pcmToWav(samples){
  const n = samples.length, out = new ArrayBuffer(44 + n * 2), v = new DataView(out);
  const wr = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  wr(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); wr(8, "WAVE"); wr(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, TR_SAMPLE_RATE, true); v.setUint32(28, TR_SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); wr(36, "data"); v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++, o += 2){
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
  }
  return new Blob([out], { type: "audio/wav" });
}
// Choose cut points in quiet spots so words are not sliced in half.
function planChunks(samples){
  const size = TR_CHUNK_SECONDS * TR_SAMPLE_RATE, win = Math.floor(0.05 * TR_SAMPLE_RATE);
  const cuts = [0];
  while (samples.length - cuts[cuts.length-1] > size * 1.15){
    const target = cuts[cuts.length-1] + size;
    const lo = target - 5 * TR_SAMPLE_RATE, hi = Math.min(samples.length - win, target + 5 * TR_SAMPLE_RATE);
    let best = target, bestE = Infinity;
    for (let i = lo; i < hi; i += win){
      let e = 0;
      for (let j = i; j < i + win; j++) e += samples[j] * samples[j];
      if (e < bestE){ bestE = e; best = i + (win >> 1); }
    }
    cuts.push(best);
  }
  cuts.push(samples.length);
  const parts = [];
  for (let i = 0; i < cuts.length - 1; i++) parts.push([cuts[i], cuts[i+1]]);
  return parts;
}
async function sendChunk(blob, lang, tries){
  const form = new FormData();
  form.append("file", blob, "audio.wav");
  if (lang) form.append("language", lang);
  let lastErr;
  for (let attempt = 0; attempt <= tries; attempt++){
    try {
      const response = await fetch("/.netlify/functions/transcribe", { method: "POST", body: form });
      const text = await response.text();
      let data; try { data = JSON.parse(text); } catch (_) { data = null; }
      if (response.ok && data) return data;
      if (response.status === 404) throw Object.assign(new Error("Transcription service not found. The Netlify function was not deployed — redeploy the full folder (including netlify/functions)."), { fatal: true });
      if (response.status === 413) throw Object.assign(new Error("The server rejected the upload as too large."), { fatal: true });
      if ([401, 403].includes(response.status)) throw Object.assign(new Error((data && data.error) || "API key rejected. Check TRANSCRIPTION_API_KEY in Netlify."), { fatal: true });
      const msg = (data && (data.error || data.message)) || ("Transcription service returned HTTP " + response.status + (data ? "" : " (no JSON — the function may have timed out)"));
      lastErr = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      if (response.status === 429) await new Promise(r => setTimeout(r, 4000 * (attempt + 1)));
      else await new Promise(r => setTimeout(r, 1200));
    } catch (e){
      if (e.fatal) throw e;
      lastErr = (e instanceof TypeError) ? new Error("Network error — check your internet connection and try again.") : e;
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  throw lastErr;
}
function normalizeWords(data, offset){
  const out = [];
  const words = Array.isArray(data.words) ? data.words : [];
  if (words.length){
    for (const w of words) out.push({ text: w.word || w.text || "", timestamp: [Number(w.start) + offset, Number(w.end) + offset] });
    return out;
  }
  if (Array.isArray(data.chunks)) {
    for (const c of data.chunks) out.push({ text: c.text || "", timestamp: [(c.timestamp?.[0] ?? 0) + offset, (c.timestamp?.[1] ?? 0) + offset] });
    if (out.length) return out;
  }
  const segments = Array.isArray(data.segments) ? data.segments : [];
  for (const seg of segments){
    const tokens = String(seg.text || "").trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const a = (Number(seg.start) || 0) + offset, b = (Number(seg.end) || (a - offset) + 0.3) + offset;
    const d = Math.max(0.01, b - a) / tokens.length;
    tokens.forEach((word, i) => out.push({ text: word, timestamp: [a + i*d, a + (i+1)*d] }));
  }
  return out;
}
async function runHostedTranscription(file, modelId, lang, onProgress){
  const samples = await decodeToMono16k(file, onProgress);
  if (!samples.length) throw new Error("No audio track found in this file.");
  const parts = planChunks(samples);
  const all = [];
  for (let i = 0; i < parts.length; i++){
    const [a, b] = parts[i];
    const pct = 15 + Math.round((i / parts.length) * 70);
    onProgress(parts.length > 1 ? `Transcribing part ${i+1} of ${parts.length}…` : "Transcribing with hosted Whisper…", pct);
    const blob = pcmToWav(samples.subarray(a, b));
    const data = await sendChunk(blob, lang, 2);
    all.push(...normalizeWords(data, a / TR_SAMPLE_RATE));
  }
  return all;
}
function chunksToCaptions(chunks, maxWords, breakOnPunct){
  const captions = [];
  let curWords = [], curWt = [], lastEnd = 0;
  function flush(){
    if (curWords.length === 0) return;
    const start = curWt[0].s;
    const end = curWt[curWt.length-1].e;
    captions.push({ start, end, text: curWords.join(" "), wt: curWt.slice(), srcText: curWords.join(" ") });
    curWords = []; curWt = [];
  }
  for (const ch of chunks){
    const raw = (ch.text || "").trim();
    if (!raw) continue;
    const ts = ch.timestamp || [lastEnd, lastEnd + 0.3];
    const s = (ts[0] != null ? ts[0] : lastEnd);
    const e = (ts[1] != null ? ts[1] : s + 0.3);
    const words = raw.split(/\s+/);
    const wordDur = (e - s) / Math.max(1, words.length);
    for (let i = 0; i < words.length; i++){
      const w = words[i];
      if (!w) continue;
      const ws = s + i * wordDur;
      const we = ws + wordDur;
      curWords.push(w);
      curWt.push({ s: ws, e: we });
      const isEnd = breakOnPunct && /[.!?]$/.test(w);
      if (isEnd || curWords.length >= maxWords) flush();
    }
    lastEnd = e;
  }
  flush();
  return captions;
}
async function runTranscription(){
  if (!state.videoFile){ alert("Load a video or audio file first."); return; }
  const btn = $("#btnTranscribe");
  const prog = $("#trProgress");
  const bar = prog.querySelector("i");
  const status = $("#trStatus");
  btn.disabled = true;
  prog.classList.add("on");
  bar.style.width = "0%";
  status.textContent = "Preparing hosted transcription…";
  try {
    const modelId = $("#trModel").value;
    const lang = $("#trLang").value || undefined;
    const maxWords = parseInt($("#trGroupWords").value, 10) || 4;
    const breakPunct = $("#trBreakPunct").checked;
    const startT = performance.now();
    const chunks = await runHostedTranscription(state.videoFile, modelId, lang, (message, pct) => {
      status.textContent = message;
      bar.style.width = (pct || 0) + "%";
    });
    const elapsed = ((performance.now() - startT) / 1000).toFixed(1);
    status.textContent = "Building synchronized captions…";
    bar.style.width = "90%";
    if (!chunks.length){ status.textContent = "No speech found."; return; }
    const captions = chunksToCaptions(chunks, maxWords, breakPunct);
    state.orphans = [];
    state.captions = captions;
    rebuildAll();
    spAutoApply();
    status.textContent = `Done — ${captions.length} captions, ${chunks.length} words transcribed in ${elapsed}s.`;
    bar.style.width = "100%";
    $$("#tabs button").forEach(b => b.classList.remove("active"));
    $$(".tab-page").forEach(p => p.classList.remove("active"));
    document.querySelector('[data-tab="edit"]').classList.add("active");
    document.querySelector('[data-page="edit"]').classList.add("active");
  } catch (err){
    console.error(err);
    status.textContent = "Error: " + (err.message || err);
    alert("Transcription failed:\n\n" + (err.message || err) +
          "\n\nTip: if this keeps happening, try an MP4 (H.264/AAC), WebM, MP3 or M4A file.");
  } finally {
    btn.disabled = false;
    setTimeout(() => { prog.classList.remove("on"); }, 1500);
  }
}

/* =====================================================================
   PLAYHEAD TOOLS
   ===================================================================== */
function addAtPlayhead(){
  if (!duration){ alert("Load a video first."); return; }
  const t = video.currentTime;
  for (const c of state.captions) if (t >= c.start && t < c.end){
    alert("The playhead is inside a caption — use Split instead."); return;
  }
  let nextStart = Infinity;
  for (const c of state.captions) if (c.start > t && c.start < nextStart) nextStart = c.start;
  const end = Math.min(t + 2, nextStart, duration - 0.05);
  if (end - t < 0.2){ alert("Not enough free time at the playhead."); return; }
  state.captions.push({ start: t, end, text: "New caption" });
  rebuildAll();
  setTimeout(() => {
    const rows = document.querySelectorAll(".cap-row");
    const last = rows[rows.length-1];
    if (last){ last.scrollIntoView({ block: "center", behavior: "smooth" }); last.querySelector("textarea").focus(); }
  }, 60);
}
function splitAtPlayhead(){
  if (!duration){ alert("Load a video first."); return; }
  const t = video.currentTime;
  const idx = state.captions.findIndex(c => t >= c.start && t < c.end);
  if (idx < 0){ alert("Put the playhead inside a caption to split it."); return; }
  const c = state.captions[idx];
  if (t <= c.start + 0.05 || t >= c.end - 0.05){
    alert("The playhead is too close to the edge of the caption."); return;
  }
  const toks = normEmph(c.text).split(" ").filter(x => x);
  if (toks.length < 2){ alert("That caption has only one word."); return; }
  const pe = parseEmph(toks);
  const wt = c.wt || estimateWt(pe.words, c.start, c.end, state.style.timingMode);
  let best = 1, bd = Infinity;
  for (let k = 1; k < toks.length; k++){
    const d = Math.abs(wt[k].s - t);
    if (d < bd){ bd = d; best = k; }
  }
  const wA = wt.slice(0, best), wB = wt.slice(best);
  const eA = Math.max(...wA.map(x => x.e));
  const sB = Math.min(...wB.map(x => x.s));
  state.captions.splice(idx, 1,
    { start: wA[0].s, end: eA, text: toks.slice(0, best).join(" "), wt: wA, srcText: toks.slice(0, best).join(" ") },
    { start: sB, end: wB[wB.length-1].e, text: toks.slice(best).join(" "), wt: wB, srcText: toks.slice(best).join(" ") }
  );
  rebuildAll();
}
function snapWordToPlayhead(){
  if (!duration){ alert("Load a video first."); return; }
  const t = video.currentTime;
  const idx = state.captions.findIndex(c => t >= c.start - 0.5 && t <= c.end + 0.5);
  if (idx < 0){ alert("Put the playhead near a caption."); return; }
  const c = state.captions[idx];
  const clean = wordsOf(c.text);
  if (clean.length === 0) return;
  const wt = c.wt || estimateWt(clean, c.start, c.end, state.style.timingMode);
  let bi = 0, bd = Infinity;
  for (let i = 0; i < wt.length; i++){
    const d = Math.abs(wt[i].s - t);
    if (d < bd){ bd = d; bi = i; }
  }
  const old = wt[bi].s;
  const dur2 = Math.max(0.05, wt[bi].e - wt[bi].s);
  let nt = t;
  if (bi > 0) nt = Math.max(nt, wt[bi-1].s + 0.02);
  if (bi < wt.length-1) nt = Math.min(nt, wt[bi+1].s - 0.02);
  wt[bi] = { s: nt, e: nt + dur2 };
  if (bi > 0 && wt[bi-1].e > nt) wt[bi-1] = { s: wt[bi-1].s, e: Math.max(wt[bi-1].s + 0.02, nt) };
  c.wt = wt;
  c.start = Math.min(...wt.map(x => x.s));
  c.end = Math.max(...wt.map(x => x.e));
  c.srcText = c.text;
  rebuildAll();
  alert("Word '" + clean[bi] + "' now starts at " + fmtTime(nt) + " (was " + fmtTime(old) + ").");
}

/* =====================================================================
   EMPHASIS
   ===================================================================== */
function findCapAt(t){ return state.captions.findIndex(c => t >= c.start && t < c.end); }
function emphasizeAtPlayhead(){
  if (!duration){ alert("Load a video first."); return; }
  const t = video.currentTime;
  const idx = findCapAt(t);
  if (idx < 0){ alert("Put the playhead inside a caption."); return; }
  const c = state.captions[idx];
  const toks = normEmph(c.text).split(" ").filter(x => x);
  const pe = parseEmph(toks);
  const wt = c.wt || estimateWt(pe.words, c.start, c.end, state.style.timingMode);
  let wi = wt.length - 1;
  for (let i = 0; i < wt.length; i++) if (t < wt[i].e){ wi = i; break; }
  toks[wi] = pe.em[wi] ? pe.words[wi] : "*" + pe.words[wi] + "*";
  c.text = toks.join(" ");
  c.srcText = c.text;
  rebuildAll();
}
function emphasizeAll(){
  const q = normEmph($("#empFind").value);
  if (!q.trim()){ alert("Type the word or phrase first."); return; }
  const qw = parseEmph(q.split(" ").filter(x => x)).words.map(bareWord);
  if (qw.length === 0){ alert("Type a word first."); return; }
  let hits = 0;
  for (const c of state.captions){
    const toks = normEmph(c.text).split(" ").filter(x => x);
    const pe = parseEmph(toks);
    let changed = false;
    for (let a = 0; a + qw.length <= pe.words.length; a++){
      let ok = true;
      for (let j = 0; j < qw.length; j++) if (bareWord(pe.words[a+j]) !== qw[j]){ ok = false; break; }
      if (!ok) continue;
      for (let j = 0; j < qw.length; j++) toks[a+j] = "*" + pe.words[a+j] + "*";
      hits++; changed = true;
      a += qw.length - 1;
    }
    if (changed){ c.text = toks.join(" "); c.srcText = c.text; }
  }
  if (hits === 0){ alert("'" + $("#empFind").value.trim() + "' was not found."); return; }
  rebuildAll();
}
function clearEmphasis(){
  for (const c of state.captions){ c.text = stripEmph(c.text); c.srcText = c.text; }
  rebuildAll();
}

/* =====================================================================
   EXPORT
   ===================================================================== */
function download(blob, name){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function exportSRT(){
  if (state.captions.length === 0){ alert("No captions to export."); return; }
  const lines = [];
  state.captions.forEach((c, i) => {
    lines.push(String(i+1));
    lines.push(srtTime(c.start) + " --> " + srtTime(c.end));
    lines.push(stripEmph(c.text));
    lines.push("");
  });
  download(new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }), "captions.srt");
}
function exportVTT(){
  if (state.captions.length === 0){ alert("No captions to export."); return; }
  const vttTime = t => {
    const cs = Math.round(Math.max(0,t)*1000);
    const h = Math.floor(cs/3600000);
    const m = Math.floor(cs/60000)%60;
    const s = Math.floor(cs/1000)%60;
    const ms = cs % 1000;
    return pad2(h)+":"+pad2(m)+":"+pad2(s)+"."+String(ms).padStart(3,"0");
  };
  const lines = ["WEBVTT", ""];
  state.captions.forEach(c => {
    lines.push(vttTime(c.start) + " --> " + vttTime(c.end));
    lines.push(stripEmph(c.text));
    lines.push("");
  });
  download(new Blob([lines.join("\n")], { type: "text/vtt;charset=utf-8" }), "captions.vtt");
}
function paintStage(cx, stageW, stageH, drawScale){
  // Background and video are laid out in full stage units, then scaled to the (possibly
  // smaller) export canvas. Without this the video was drawn at full size onto a smaller
  // canvas, so it looked zoomed-in and cropped.
  const s = drawScale || 1;
  cx.save();
  cx.setTransform(s, 0, 0, s, 0, 0);
  cx.fillStyle = state.style.videoBgColor;
  cx.fillRect(0, 0, stageW, stageH);
  if (state.mode === "video" && VW && VH && video.videoWidth){
    const [dw, dh] = fitContain(VW, VH, stageW, stageH);
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(video, (stageW - dw) / 2, (stageH - dh) / 2, dw, dh);
  }
  cx.restore();
  drawCaptions(cx, stageW, stageH, video.currentTime, state.style, state.segments, drawScale);
}
function exportPNG(){
  if (!state.videoFile){ alert("Load a file first."); return; }
  const stage = getStageDims();
  const c = document.createElement("canvas");
  c.width = stage.w; c.height = stage.h;
  const cx = c.getContext("2d");
  paintStage(cx, stage.w, stage.h, 1);
  c.toBlob(b => download(b, "frame.png"), "image/png");
}
/* MP4 encoder (ffmpeg.wasm) is self-hosted in /vendor/ffmpeg so it loads from the same
   origin as the site. Loading it from unpkg through blob: URLs breaks the module worker's
   relative imports (./const.js, ./errors.js), which made ffmpeg.load() hang forever. */
const FFMPEG_VENDOR = new URL("../vendor/ffmpeg/", import.meta.url).href;
const EXPORT_MAX_SIDE = 1280; // longest edge of the exported video; wasm encoding is slow above this

async function transcodeWebMToMP4(webmBlob, onStatus, durationSec){
  onStatus("Loading MP4 encoder…", 0);
  const { FFmpeg } = await import(FFMPEG_VENDOR + "ffmpeg/index.js");
  const ffmpeg = new FFmpeg();
  let lastPct = -1;
  const report = frac => {
    if (!Number.isFinite(frac)) return;
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    if (pct <= lastPct) return;
    lastPct = pct;
    onStatus("Converting to MP4… " + pct + "%", pct);
  };
  // MediaRecorder WebM files have no duration, so ffmpeg's own progress value is unreliable.
  // Parse "time=00:00:12.34" from the log and divide by the known recording length instead.
  ffmpeg.on("log", ({ message }) => {
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
    if (m && durationSec > 0) report((+m[1] * 3600 + +m[2] * 60 + +m[3]) / durationSec);
  });
  ffmpeg.on("progress", ({ progress }) => {
    if (!(durationSec > 0) && Number.isFinite(progress) && progress >= 0 && progress <= 1) report(progress);
  });

  const loadCtl = new AbortController();
  const loadTimer = setTimeout(() => loadCtl.abort(), 90000);
  try {
    await ffmpeg.load({
      coreURL: FFMPEG_VENDOR + "core/ffmpeg-core.js",
      wasmURL: FFMPEG_VENDOR + "core/ffmpeg-core.wasm"
    }, { signal: loadCtl.signal });
  } catch (e) {
    try { ffmpeg.terminate(); } catch(_){}
    throw new Error("The MP4 encoder could not be loaded (" + (loadCtl.signal.aborted ? "timed out" : (e && e.message || e)) + "). Check that the /vendor/ffmpeg folder is deployed.");
  } finally { clearTimeout(loadTimer); }

  const input = "wordbox-input.webm", output = "wordbox-captions.mp4";
  try {
    await ffmpeg.writeFile(input, new Uint8Array(await webmBlob.arrayBuffer()));
    onStatus("Encoding MP4… keep this tab open.", 0);
    const timeoutMs = Math.max(10 * 60 * 1000, (durationSec || 60) * 30 * 1000);
    const code = await ffmpeg.exec(["-i", input, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output], timeoutMs);
    if (code !== 0) throw new Error("MP4 encoding did not finish (code " + code + "). Try a shorter clip.");
    const data = await ffmpeg.readFile(output);
    return new Blob([data], { type: "video/mp4" });
  } finally {
    try { ffmpeg.terminate(); } catch(_){}
  }
}

function exportVideo(){
  if (!state.videoFile){ alert("Load a file first."); return; }
  if (typeof MediaRecorder === "undefined"){ alert("Your browser does not support video recording."); return; }
  const btn = $("#btnExportVideo"), prog = $("#recProgress"), bar = prog.querySelector("i"), info = $("#recInfo");
  const mimes = ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm;codecs=vp9","video/webm"];
  let mime = ""; for (const m of mimes) if (MediaRecorder.isTypeSupported(m)){ mime = m; break; }
  if (!mime){ alert("Your browser cannot record a compatible source format."); return; }
  btn.disabled = true; prog.classList.add("on"); bar.style.width = "0%"; info.textContent = "Preparing video…";
  const stage = getStageDims();
  const exScale = Math.min(1, EXPORT_MAX_SIDE / Math.max(stage.w, stage.h));
  const cvs = document.createElement("canvas");
  cvs.width = Math.max(2, Math.round(stage.w * exScale));
  cvs.height = Math.max(2, Math.round(stage.h * exScale));
  const cx = cvs.getContext("2d");
  const stream = cvs.captureStream(30);
  let gotAudio = false;
  try {
    const vs = video.captureStream ? video.captureStream() : (video.mozCaptureStream ? video.mozCaptureStream() : null);
    if (vs) vs.getAudioTracks().forEach(t => { stream.addTrack(t); gotAudio = true; });
  } catch(e){}
  let rec;
  try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 }); }
  catch(e){ btn.disabled = false; prog.classList.remove("on"); alert("Could not start video recording: " + e.message); return; }
  const chunks = [];
  let webm = null;
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve, reject) => { rec.onstop = resolve; rec.onerror = e => reject(e.error || new Error("Recording failed")); });
  const prevTime = video.currentTime, prevVol = video.volume;
  let raf = 0, endHandler;
  video.pause();
  const restore = () => {
    cancelAnimationFrame(raf);
    try { stream.getTracks().forEach(t => t.stop()); } catch(e){}
    video.volume = prevVol; video.currentTime = prevTime; btn.disabled = false;
  };
  function begin(){
    rec.start(200);
    const playPromise = video.play();
    if (playPromise && playPromise.catch) playPromise.catch(err => { try { rec.stop(); } catch(e){}; info.textContent = "Playback failed: " + err.message; });
    function draw(){
      if (rec.state !== "recording") return;
      paintStage(cx, stage.w, stage.h, exScale);
      if (duration) bar.style.width = ((video.currentTime / duration) * 100 * .45).toFixed(1) + "%";
      info.textContent = "Recording… " + fmtClock(video.currentTime) + " / " + fmtClock(duration) + (gotAudio ? "" : " (source audio unavailable)") + " — keep this tab in the foreground";
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    endHandler = () => { video.removeEventListener("ended", endHandler); setTimeout(() => { try { if (rec.state !== "inactive") rec.stop(); } catch(e){} }, 250); };
    video.addEventListener("ended", endHandler, { once: true });
  }
  const seeked = new Promise(resolve => {
    if (video.currentTime === 0 && video.readyState >= 2){ resolve(); return; }
    const h = () => { video.removeEventListener("seeked", h); resolve(); };
    video.addEventListener("seeked", h, { once: true });
  });
  video.currentTime = 0;
  seeked.then(begin).then(() => stopped).then(async () => {
    cancelAnimationFrame(raf);
    webm = new Blob(chunks, { type: mime });
    if (!webm.size) throw new Error("The browser produced an empty recording. Try Chrome or Edge and keep this tab in the foreground.");
    bar.style.width = "48%";
    const mp4 = await transcodeWebMToMP4(webm, (message, pct) => {
      info.textContent = message;
      if (Number.isFinite(pct)) bar.style.width = (48 + pct * 0.5).toFixed(1) + "%";
    }, duration);
    download(mp4, "wordbox-captions.mp4");
    bar.style.width = "100%";
    info.textContent = "Done — MP4 saved (" + (mp4.size/1048576).toFixed(1) + " MB).";
    restore();
    setTimeout(() => prog.classList.remove("on"), 2600);
  }).catch(err => {
    console.error(err);
    restore();
    const msg = err && err.message ? err.message : String(err);
    if (webm && webm.size){
      // Don't lose the recording if only the MP4 conversion failed.
      download(webm, "wordbox-captions.webm");
      info.textContent = "MP4 conversion failed — saved the recording as WebM instead.";
      alert("MP4 export failed: " + msg + "\n\nYour captioned video was saved as a .webm file instead.");
    } else {
      info.textContent = "Export failed: " + msg;
      alert("Export failed: " + msg);
    }
  });
}

/* =====================================================================
   PROJECT SAVE/LOAD
   ===================================================================== */
/* A project is one file the user keeps on their PC:
     "WBOXPRJ1" + 4-byte little-endian header length + UTF-8 JSON header + raw media bytes.
   The header alone is valid JSON-ish metadata, and old .json projects still open. */
const PRJ_MAGIC = "WBOXPRJ1";
const PRJ_VERSION = 6;

function prjSnapshot(){
  return {
    app: "WordBox Studio",
    version: PRJ_VERSION,
    savedAt: new Date().toISOString(),
    style: state.style,
    captions: state.captions,
    mode: state.mode,
    project: {
      width: state.style.projW || 1080,
      height: state.style.projH || 1920,
      stageAspect: state.style.stageAspect || "auto"
    },
    playhead: video && isFinite(video.currentTime) ? video.currentTime : 0,
    media: null
  };
}
function prjFileName(){
  const f = state.videoFile;
  const base = f && f.name ? f.name.replace(/\.[^.]+$/, "") : "wordbox-project";
  return base.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) + ".wordbox";
}
async function saveProject(){
  const prog = $("#prjProgress"), info = $("#prjInfo");
  const includeMedia = !!($("#prjIncludeMedia") && $("#prjIncludeMedia").checked) && !!state.videoFile;
  const header = prjSnapshot();
  try {
    if (prog) prog.classList.add("on");
    if (info) info.textContent = includeMedia ? "Packing the project with its media\u2026" : "Packing the project\u2026";
    let mediaBuf = null;
    if (includeMedia){
      const f = state.videoFile;
      mediaBuf = await f.arrayBuffer();
      header.media = { name: f.name, type: f.type || "", size: mediaBuf.byteLength };
    }
    const json = new TextEncoder().encode(JSON.stringify(header));
    const magic = new TextEncoder().encode(PRJ_MAGIC);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, json.length, true);
    const parts = mediaBuf ? [magic, len, json, mediaBuf] : [magic, len, json];
    const blob = new Blob(parts, { type: "application/octet-stream" });
    download(blob, prjFileName());
    if (info) info.textContent = "Saved " + prjFileName() + " \u2014 " + (blob.size/1048576).toFixed(1) +
      " MB" + (includeMedia ? " (media included)." : " (settings only \u2014 open the media yourself next time).");
  } catch (err){
    console.error(err);
    if (info) info.textContent = "Could not save the project: " + (err && err.message ? err.message : String(err));
    alert("Could not save the project: " + (err && err.message ? err.message : String(err)));
  } finally {
    if (prog) setTimeout(() => prog.classList.remove("on"), 1200);
  }
}

function applyProjectData(data){
  state.orphans = [];
  if (Array.isArray(data.captions)) state.captions = data.captions;
  if (data.style) Object.assign(state.style, data.style);
  if (data.project){
    if (data.project.width)  state.style.projW = data.project.width;
    if (data.project.height) state.style.projH = data.project.height;
    if (data.project.stageAspect) state.style.stageAspect = data.project.stageAspect;
  }
  if (data.mode === "audio" || data.mode === "video") state.mode = data.mode;
  normalizeStyle();
  syncStyleToUI();
  rebuildAll();
  applyModeUI();
  if (SW || (VW && VH)){ recomputeStage(); fitStage(); renderTimeline(); }
  dirty = true;
}

async function readProjectFile(file){
  const info = $("#prjInfo");
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const magic = new TextDecoder().decode(bytes.subarray(0, PRJ_MAGIC.length));
    if (magic !== PRJ_MAGIC){
      // Legacy settings-only project (.json from earlier versions).
      const data = JSON.parse(new TextDecoder("utf-8").decode(bytes));
      applyProjectData(data);
      if (info) info.textContent = "Opened a settings-only project \u2014 import the media to go with it.";
      return;
    }
    const hLen = new DataView(buf).getUint32(PRJ_MAGIC.length, true);
    const hStart = PRJ_MAGIC.length + 4;
    const data = JSON.parse(new TextDecoder("utf-8").decode(bytes.subarray(hStart, hStart + hLen)));
    const mediaStart = hStart + hLen;
    const hasMedia = data.media && bytes.byteLength > mediaStart;
    if (hasMedia){
      const type = data.media.type || (data.mode === "audio" ? "audio/mpeg" : "video/mp4");
      const mediaFile = new File([buf.slice(mediaStart)], data.media.name || "project-media", { type });
      // Load the media first, then apply the saved look once its metadata is in.
      const once = () => {
        video.removeEventListener("loadedmetadata", once);
        applyProjectData(data);
        if (data.playhead > 0 && isFinite(data.playhead)){
          try { video.currentTime = Math.min(data.playhead, video.duration || data.playhead); } catch(e){}
        }
        if (info) info.textContent = "Opened " + file.name + " with its media.";
      };
      video.addEventListener("loadedmetadata", once);
      PRJ_KEEP_FONT_SIZE = true;
      loadVideoFile(mediaFile, (data.mode === "audio" || data.mode === "video") ? data.mode : "video");
    } else {
      applyProjectData(data);
      if (info) info.textContent = "Opened " + file.name + " \u2014 settings only, so import the media to go with it.";
    }
  } catch (err){
    console.error(err);
    if (info) info.textContent = "Could not read that project file.";
    alert("Could not read that project file.");
  }
}
function loadProject(e){
  const f = e.target.files[0];
  e.target.value = "";
  if (f) readProjectFile(f);
}

/* =====================================================================
   TEXT DISTRIBUTION
   ===================================================================== */
function distributeText(txt){
  if (!duration){ alert("Load a video first."); return; }
  const perCap = Math.max(1, parseInt($("#distWords").value, 10) || 3);
  const gap = Math.max(0, parseFloat($("#distGap").value) || 0);
  const rawLines = txt.replace(/\r\n/g,"\n").replace(/\r/g,"\n").split("\n");
  const chunks = [];
  for (const line of rawLines){
    const l = line.trim(); if (!l) continue;
    const words = splitWords(l, false);
    for (let j = 0; j < words.length; j += perCap) chunks.push(words.slice(j, j+perCap).join(" "));
  }
  if (chunks.length === 0){ alert("Nothing to distribute."); return; }
  const totalChars = chunks.reduce((a,c) => a + Math.max(1, c.replace(/\*/g,"").length), 0);
  const totalTime = Math.max(0.5, duration - 0.2);
  let cursor = 0.1;
  state.orphans = [];
  state.captions = [];
  for (const ch of chunks){
    const share = Math.max(1, ch.replace(/\*/g,"").length) / totalChars;
    const dur = Math.max(0.45, totalTime * share - gap);
    const start = cursor;
    const end = Math.min(duration - 0.05, start + dur);
    if (end <= start) break;
    state.captions.push({ start, end, text: ch });
    cursor = end + gap;
    if (cursor >= duration - 0.1) break;
  }
  rebuildAll();
}

/* =====================================================================
   UI
   ===================================================================== */
function bindColor(colorId, hexId, key){
  const c = $(colorId), h = $(hexId);
  c.addEventListener("input", () => { state.style[key] = c.value; h.value = c.value; rebuildSegments(); });
  h.addEventListener("change", () => {
    let v = h.value.trim(); if (v.charAt(0) !== "#") v = "#" + v;
    if (!/^#[0-9a-fA-F]{6}$/.test(v)){ h.value = state.style[key]; return; }
    state.style[key] = v.toLowerCase(); c.value = v.toLowerCase(); rebuildSegments();
  });
}
const PAD_SIDES = ["T","R","B","L"];
const PAD_OPPOSITE = { T:"B", B:"T", L:"R", R:"L" };
function syncPaddingUI(){
  const st = state.style;
  PAD_SIDES.forEach(side => {
    const el = $("#pad" + side), lab = $("#pad" + side + "Val");
    if (!el) return;
    const pct = Math.round(padRatio(st, side) * 100);
    el.value = pct;
    if (lab) lab.textContent = pct + "%";
  });
  const link = $("#padLink"); if (link) link.checked = st.padLink !== false;
  const fit = $("#boxFit"); if (fit) fit.value = st.boxFit || "font";
  const ps = $("#presetShadow"); if (ps) ps.checked = st.presetShadow !== false;
}
function setPad(side, pct){
  const st = state.style;
  const v = clamp(pct, 0, 80) / 100;
  st["pad" + side + "r"] = v;
  if (st.padLink !== false) st["pad" + PAD_OPPOSITE[side] + "r"] = v;
  // Keep the legacy pair in step, so older exports and the fitting pass agree.
  st.padXr = (padRatio(st, "L") + padRatio(st, "R")) / 2;
  st.padYr = (padRatio(st, "T") + padRatio(st, "B")) / 2;
  syncPaddingUI();
  rebuildSegments();
}
function setupPadding(){
  PAD_SIDES.forEach(side => {
    const el = $("#pad" + side);
    if (el) el.addEventListener("input", function(){ setPad(side, parseFloat(this.value)); });
  });
  const link = $("#padLink");
  if (link) link.addEventListener("change", function(){
    state.style.padLink = this.checked;
    if (this.checked){
      // Adopt the larger of each pair so nothing jumps inwards unexpectedly.
      const x = Math.max(padRatio(state.style, "L"), padRatio(state.style, "R"));
      const y = Math.max(padRatio(state.style, "T"), padRatio(state.style, "B"));
      state.style.padLr = state.style.padRr = x;
      state.style.padTr = state.style.padBr = y;
      state.style.padXr = x; state.style.padYr = y;
      syncPaddingUI(); rebuildSegments();
    }
  });
  const reset = $("#btnPadReset");
  if (reset) reset.addEventListener("click", () => {
    const st = state.style;
    st.padTr = st.padBr = 0.10; st.padLr = st.padRr = 0.16;
    st.padXr = 0.16; st.padYr = 0.10;
    syncPaddingUI(); rebuildSegments();
  });
  const fit = $("#boxFit");
  if (fit) fit.addEventListener("change", function(){ state.style.boxFit = this.value; rebuildSegments(); });
  const ps = $("#presetShadow");
  if (ps) ps.addEventListener("change", function(){ state.style.presetShadow = this.checked; rebuildSegments(); });
}
function syncColorInputs(){
  $("#textColor").value = state.style.textColor;
  $("#textColorHex").value = state.style.textColor;
  $("#boxColor").value = state.style.boxColor;
  $("#boxColorHex").value = state.style.boxColor;
  $("#accentColor").value = accentOf(state.style);
  $("#accentColorHex").value = accentOf(state.style);
  $("#strokeColor").value = strokeOf(state.style);
  $("#videoBgColor").value = state.style.videoBgColor;
  $("#videoBgColorHex").value = state.style.videoBgColor;
}
function normalizeStyle(){
  const d = {
    preset: "box", accentColor: "#ffd400", strokeColor: "#000000",
    strokeWidth: 0, revealMode: 2,
    videoBgColor: "#000000", stageAspect: "auto",
    shadowType: "none", shadowDirection: 135, shadowDistance: 12, shadowOpacity: 70,
    shadowBlur: 12, shadowColor: "#000000", shadowFade: "out",
    shadowLayer: "above", shadowScope: "all", shadowBox: false,
    projW: 1080, projH: 1920, padLink: true, boxFit: "font", presetShadow: true,
    padXr: 0.16, padYr: 0.10
  };
  for (const k in d) if (state.style[k] === undefined || state.style[k] === null) state.style[k] = d[k];
  // Projects and presets written before per-side padding only carry padXr / padYr.
  const st = state.style;
  if (typeof st.padTr !== "number") st.padTr = st.padYr;
  if (typeof st.padBr !== "number") st.padBr = st.padYr;
  if (typeof st.padLr !== "number") st.padLr = st.padXr;
  if (typeof st.padRr !== "number") st.padRr = st.padXr;
}
function renderPresetGrid(){
  const g = $("#presetGrid");
  if (!g) return;
  g.innerHTML = "";
  PRESETS.forEach(p => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "preset-card" + (state.style.preset === p.id ? " active" : "");
    const prev = document.createElement("span");
    prev.className = "pc-prev";
    prev.setAttribute("style", p.prev);
    prev.textContent = "Aa";
    const nm = document.createElement("span");
    nm.className = "pc-name";
    nm.textContent = p.name;
    b.appendChild(prev); b.appendChild(nm);
    b.addEventListener("click", () => applyPreset(p.id));
    g.appendChild(b);
  });
}
function applyPreset(id){
  const p = PRESETS.find(x => x.id === id);
  if (!p) return;
  state.style.preset = id;
  if (p.apply){
    Object.assign(state.style, p.apply);
    // A preset speaks in X/Y padding, so push that onto the four sides it replaces.
    if (typeof p.apply.padXr === "number"){ state.style.padLr = state.style.padRr = p.apply.padXr; }
    if (typeof p.apply.padYr === "number"){ state.style.padTr = state.style.padBr = p.apply.padYr; }
  }
  normalizeStyle();
  syncStyleToUI();
  if (document.fonts && document.fonts.load){
    document.fonts.load(state.style.fontWeight + ' 64px "' + state.style.fontFamily + '"')
      .then(() => { dirty = true; }).catch(() => {});
  }
  rebuildSegments();
}
function syncStyleToUI(){
  const st = state.style;
  $("#fontFamily").value = st.fontFamily;
  $("#fontWeight").value = String(st.fontWeight);
  $("#fontSize").value = clamp(st.fontSize, 16, 200);
  $("#fontSizeNum").value = st.fontSize;
  $("#fsLabel").textContent = st.fontSize + " px";
  $("#uppercase").checked = st.uppercase;
  syncPaddingUI();
  $("#corner").value = st.corner;
  $("#yPos").value = st.yPct;
  $("#maxWidth").value = st.maxWidthPct;
  $("#lineSpacing").value = st.lineSpacing;
  $("#maxLines").value = String(st.maxLines);
  ["shadowType","shadowDirection","shadowDistance","shadowOpacity","shadowBlur","shadowColor","shadowFade","shadowLayer","shadowScope"].forEach(k => { const el = $("#" + k); if (el) el.value = st[k]; });
  { const el = $("#shadowBox"); if (el) el.checked = !!st.shadowBox; }
  $("#keepWordsTogether").checked = st.keepWordsTogether !== false;
  [["shadowDirection","°"],["shadowDistance",""],["shadowOpacity","%"],["shadowBlur",""]].forEach(([id,suffix]) => { const el = $("#"+id+"Val"); if(el) el.textContent = $("#"+id).value + suffix; });
  $("#maxWords").value = st.maxWords;
  $("#wordsMode").value = String(st.wordsMode);
  $("#revealMode").value = String(st.revealMode);
  $("#boxMode").value = String(st.boxMode);
  $("#animIn").value = st.animIn;
  $("#popTime").value = st.popTime;
  $("#popFrom").value = st.popFrom;
  $("#moveDist").value = st.moveDist;
  $("#stagger").value = st.stagger;
  $("#outTime").value = st.outTime;
  $("#animOut").checked = st.animOut;
  $("#timingMode").value = String(st.timingMode);
  $("#emBold").checked = st.emBold;
  $("#emItalic").checked = st.emItalic;
  $("#emTextColor").value = st.emTextColor;
  $("#emBoxColor").value = st.emBoxColor;
  $("#strokeWidth").value = st.strokeWidth;
  $("#strokeWidthVal").textContent = st.strokeWidth;
  $("#videoBgColor").value = st.videoBgColor;
  $("#videoBgColorHex").value = st.videoBgColor;
  $("#stageAspect").value = st.stageAspect;
  syncProjSizeRow();
  syncColorInputs();
  $("#cornerVal").textContent = $("#corner").value;
  $("#yPosVal").textContent = $("#yPos").value + "%";
  $("#maxWidthVal").textContent = $("#maxWidth").value + "%";
  $("#lineSpacingVal").textContent = parseFloat(st.lineSpacing).toFixed(2);
  $("#popTimeVal").textContent = parseFloat(st.popTime).toFixed(2) + "s";
  $("#popFromVal").textContent = st.popFrom + "%";
  $("#moveDistVal").textContent = st.moveDist + "%";
  $("#staggerVal").textContent = parseFloat(st.stagger).toFixed(2) + "s";
  $("#outTimeVal").textContent = parseFloat(st.outTime).toFixed(2) + "s";
  renderPresetGrid();
  applyVideoBgToShell();
}
/* =====================================================================
   PROJECT SIZE  (audio has no picture of its own, so the canvas is chosen)
   ===================================================================== */
const SIZE_PRESETS = [
  { n: "Vertical \u00b7 9:16",  w: 1080, h: 1920 },
  { n: "Widescreen \u00b7 16:9", w: 1920, h: 1080 },
  { n: "Square \u00b7 1:1",      w: 1080, h: 1080 },
  { n: "Portrait \u00b7 4:5",    w: 1080, h: 1350 },
  { n: "Vertical HD \u00b7 9:16", w: 720,  h: 1280 },
  { n: "Classic \u00b7 4:3",     w: 1440, h: 1080 }
];
function gcd(a, b){ return b ? gcd(b, a % b) : a; }
function ratioText(w, h){
  w = Math.round(w); h = Math.round(h);
  if (!w || !h) return "";
  const g = gcd(w, h) || 1;
  let rw = w / g, rh = h / g;
  if (rw > 40 || rh > 40){ return (w / h).toFixed(2) + " : 1"; }
  return rw + ":" + rh;
}
let sizeDialogResolve = null;
function renderSizeGrid(){
  const g = $("#sizeGrid");
  if (!g) return;
  const w = parseInt($("#dlgW").value, 10) || 0, h = parseInt($("#dlgH").value, 10) || 0;
  g.innerHTML = "";
  SIZE_PRESETS.forEach(p => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "size-card" + (p.w === w && p.h === h ? " active" : "");
    const th = document.createElement("span");
    th.className = "size-thumb";
    const long = 34, s2 = long / Math.max(p.w, p.h);
    th.style.width  = Math.max(8, Math.round(p.w * s2)) + "px";
    th.style.height = Math.max(8, Math.round(p.h * s2)) + "px";
    const meta = document.createElement("span");
    meta.className = "size-meta";
    const nm = document.createElement("span"); nm.className = "size-name"; nm.textContent = p.n;
    const dm = document.createElement("span"); dm.className = "size-dim"; dm.textContent = p.w + " \u00d7 " + p.h;
    meta.appendChild(nm); meta.appendChild(dm);
    b.appendChild(th); b.appendChild(meta);
    b.addEventListener("click", () => {
      $("#dlgW").value = p.w; $("#dlgH").value = p.h;
      renderSizeGrid();
    });
    g.appendChild(b);
  });
  const rt = $("#dlgRatio");
  if (rt) rt.textContent = ratioText(w, h);
}
function askProjectSize(opts){
  const o = opts || {};
  const back = $("#sizeModal");
  if (!back) return Promise.resolve({ w: state.style.projW || 1080, h: state.style.projH || 1920 });
  $("#sizeModalTitle").textContent = o.title || "Project size";
  $("#sizeModalSub").textContent = o.sub ||
    "Audio has no picture of its own, so pick the canvas your captions will be rendered on.";
  $("#sizeOk").textContent = o.ok || "Create project";
  $("#dlgW").value = o.w || state.style.projW || 1080;
  $("#dlgH").value = o.h || state.style.projH || 1920;
  renderSizeGrid();
  back.hidden = false;
  setTimeout(() => { const el = $("#dlgW"); if (el) el.focus(); }, 30);
  return new Promise(resolve => { sizeDialogResolve = resolve; });
}
function closeSizeDialog(result){
  const back = $("#sizeModal");
  if (back) back.hidden = true;
  const r = sizeDialogResolve;
  sizeDialogResolve = null;
  if (r) r(result);
}
function applyProjectSize(w, h){
  state.style.projW = clamp(Math.round(w) || 1080, 64, 4096);
  state.style.projH = clamp(Math.round(h) || 1920, 64, 4096);
  state.style.stageAspect = "custom";
  const sa = $("#stageAspect"); if (sa) sa.value = "custom";
  syncProjSizeRow();
  if (overlay){ recomputeStage(); fitStage(); renderTimeline(); }
  dirty = true;
}
function syncProjSizeRow(){
  const row = $("#projSizeRow");
  if (!row) return;
  row.classList.toggle("on", state.style.stageAspect === "custom");
  const w = $("#projW"), h = $("#projH");
  if (w) w.value = state.style.projW || 1080;
  if (h) h.value = state.style.projH || 1920;
}
function setupSizeDialog(){
  ["dlgW","dlgH"].forEach(id => { const el = $("#"+id); if (el) el.addEventListener("input", renderSizeGrid); });
  const ok = $("#sizeOk"), cancel = $("#sizeCancel"), back = $("#sizeModal");
  if (ok) ok.addEventListener("click", () => {
    const w = clamp(parseInt($("#dlgW").value, 10) || 1080, 64, 4096);
    const h = clamp(parseInt($("#dlgH").value, 10) || 1920, 64, 4096);
    closeSizeDialog({ w, h });
  });
  if (cancel) cancel.addEventListener("click", () => closeSizeDialog(null));
  if (back) back.addEventListener("mousedown", e => { if (e.target === back) closeSizeDialog(null); });
  document.addEventListener("keydown", e => {
    if (!sizeDialogResolve) return;
    if (e.key === "Escape"){ e.preventDefault(); closeSizeDialog(null); }
    else if (e.key === "Enter" && !/TEXTAREA/.test(document.activeElement.tagName)){
      e.preventDefault();
      const b = $("#sizeOk"); if (b) b.click();
    }
  });
  ["projW","projH"].forEach(id => {
    const el = $("#"+id);
    if (el) el.addEventListener("change", () => {
      applyProjectSize(parseInt($("#projW").value, 10), parseInt($("#projH").value, 10));
    });
  });
  const pb = $("#btnProjSizeDlg");
  if (pb) pb.addEventListener("click", async () => {
    const r = await askProjectSize({
      title: "Project size",
      sub: "Pick the canvas this project renders on.",
      ok: "Apply size",
      w: state.style.projW, h: state.style.projH
    });
    if (r) applyProjectSize(r.w, r.h);
  });
}
function isAudioFile(f){
  if (!f) return false;
  if (f.type && /^audio\//.test(f.type)) return true;
  return /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|aiff?|caf)$/i.test(f.name || "");
}
/* Importing audio on its own: ask for the canvas first, then build the project. */
async function importMediaFile(file, mode){
  if (!file) return;
  const audioOnly = isAudioFile(file);
  const wantMode = audioOnly ? "audio" : (mode || "video");
  if (audioOnly || wantMode === "audio"){
    const r = await askProjectSize({
      title: audioOnly ? "New audio project" : "New audio-only project",
      sub: audioOnly
        ? "\u201c" + file.name + "\u201d has no picture, so choose the frame your captions are rendered on. You can change it later in Style \u2192 Stage."
        : "This project keeps only the sound, so choose the frame your captions are rendered on.",
      ok: "Create project"
    });
    if (!r) return;               // cancelled — nothing is loaded
    applyProjectSize(r.w, r.h);
  }
  loadVideoFile(file, wantMode);
}

/* =====================================================================
   SPELLING — US / UK
   ===================================================================== */
let spPending = null;     // the scan waiting to be applied
let spUndoSnapshot = null;

function spVariantName(v){ return v === "uk" ? "British (UK)" : "American (US)"; }

function spScan(){
  const variant = ($("#spVariant") || {}).value || "us";
  const tidy = !!($("#spTidy") && $("#spTidy").checked);
  const texts = [], counts = new Map();
  let capsTouched = 0, tidied = 0;
  state.captions.forEach((c, i) => {
    const r = convertCaption(c.text, variant, { tidy });
    texts[i] = r.text;
    if (r.text !== c.text) capsTouched++;
    for (const ch of r.changes){
      if (ch.tidy){ tidied++; continue; }
      const key = ch.from.toLowerCase() + "\u2192" + ch.to.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  });
  return { variant, texts, counts, capsTouched, tidied };
}

function spRender(scan){
  const box = $("#spResult"), actions = $("#spActions"), undoBtn = $("#btnSpUndo");
  if (!box) return;
  if (!state.captions.length){
    box.textContent = "No captions to check yet.";
    if (actions) actions.hidden = true;
    return;
  }
  if (!scan.capsTouched){
    box.innerHTML = '<span class="sp-ok">\u2713 Every caption already matches ' +
      spVariantName(scan.variant) + ' spelling.</span>';
    if (actions) actions.hidden = !(spUndoSnapshot);
    if (undoBtn) undoBtn.hidden = !spUndoSnapshot;
    spPending = null;
    return;
  }
  const rows = Array.from(scan.counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => {
      const [from, to] = key.split("\u2192");
      return '<div class="sp-item"><span class="sp-from">' + from +
             '</span><span>\u2192</span><span class="sp-to">' + to +
             '</span><span class="sp-n">\u00d7' + n + '</span></div>';
    }).join("");
  box.innerHTML = '<b>' + scan.capsTouched + ' caption' + (scan.capsTouched === 1 ? "" : "s") +
    '</b> would change to ' + spVariantName(scan.variant) + ' spelling' +
    (scan.tidied ? ', plus ' + scan.tidied + ' spacing fix' + (scan.tidied === 1 ? "" : "es") : "") +
    '.<div class="sp-list">' + rows + '</div>';
  spPending = scan;
  if (actions) actions.hidden = false;
  if (undoBtn) undoBtn.hidden = !spUndoSnapshot;
}

function spApply(scan){
  if (!scan || !scan.capsTouched) return 0;
  spUndoSnapshot = JSON.parse(JSON.stringify(state.captions));
  state.captions.forEach((c, i) => {
    if (scan.texts[i] !== undefined && scan.texts[i] !== c.text){
      c.text = scan.texts[i];
      // The words changed, so any per-word timing no longer lines up by index;
      // sanitizeWt re-derives it from the caption span on the next rebuild.
      if (c.srcText) c.srcText = scan.texts[i];
    }
  });
  state.orphans = [];
  rebuildAll();
  return scan.capsTouched;
}

/* Used by the "fix new captions automatically" switch, after an import or a transcription. */
function spAutoApply(){
  const auto = $("#spAuto");
  if (!auto || !auto.checked || !state.captions.length) return;
  const scan = spScan();
  if (!scan.capsTouched) return;
  spApply(scan);
  const box = $("#spResult");
  if (box) box.innerHTML = '<span class="sp-ok">\u2713 Auto-fixed ' + scan.capsTouched +
    ' caption' + (scan.capsTouched === 1 ? "" : "s") + ' to ' + spVariantName(scan.variant) + ' spelling.</span>';
  const undoBtn = $("#btnSpUndo"), actions = $("#spActions");
  if (actions) actions.hidden = false;
  if (undoBtn) undoBtn.hidden = false;
  const applyBtn = $("#btnSpApply");
  if (applyBtn) applyBtn.hidden = true;
}

function setupSpelling(){
  const check = $("#btnSpCheck");
  if (check) check.addEventListener("click", () => {
    const applyBtn = $("#btnSpApply");
    if (applyBtn) applyBtn.hidden = false;
    spRender(spScan());
  });
  const apply = $("#btnSpApply");
  if (apply) apply.addEventListener("click", () => {
    const n = spApply(spPending);
    const box = $("#spResult");
    if (n && box) box.innerHTML = '<span class="sp-ok">\u2713 Updated ' + n + ' caption' +
      (n === 1 ? "" : "s") + ' to ' + spVariantName(spPending.variant) + ' spelling.</span>';
    spPending = null;
    apply.hidden = true;
    const undoBtn = $("#btnSpUndo");
    if (undoBtn) undoBtn.hidden = false;
  });
  const undo = $("#btnSpUndo");
  if (undo) undo.addEventListener("click", () => {
    if (!spUndoSnapshot) return;
    state.captions = spUndoSnapshot;
    spUndoSnapshot = null;
    state.orphans = [];
    rebuildAll();
    const box = $("#spResult");
    if (box) box.textContent = "Reverted to the captions as they were before the spelling pass.";
    undo.hidden = true;
    const applyBtn = $("#btnSpApply");
    if (applyBtn) applyBtn.hidden = false;
  });
  const variant = $("#spVariant");
  if (variant) variant.addEventListener("change", () => {
    const applyBtn = $("#btnSpApply");
    if (applyBtn) applyBtn.hidden = false;
    spRender(spScan());
  });
}

function setupUI(){
  $$("#tabs button").forEach(btn => {
    btn.addEventListener("click", () => {
      $$("#tabs button").forEach(b => b.classList.remove("active"));
      $$(".tab-page").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.querySelector('[data-page="' + btn.dataset.tab + '"]').classList.add("active");
    });
  });
  const vi = $("#videoInput");
  function pickWithMode(m){ pendingMode = m; vi.click(); }
  $("#btnPickVideo2").addEventListener("click", () => pickWithMode("video"));
  $("#btnPickAudio").addEventListener("click", () => pickWithMode("audio"));
  $("#btnPickVideo").addEventListener("click", () => pickWithMode("video"));
  $("#btnPickAudioEmpty").addEventListener("click", () => pickWithMode("audio"));
  vi.addEventListener("change", e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) importMediaFile(f, pendingMode);
  });
  const shell = $("#videoShell");
  ["dragenter","dragover"].forEach(ev => shell.addEventListener(ev, e => { e.preventDefault(); shell.classList.add("drag"); }));
  ["dragleave","drop"].forEach(ev => shell.addEventListener(ev, e => { e.preventDefault(); shell.classList.remove("drag"); }));
  shell.addEventListener("drop", e => {
    const f = e.dataTransfer.files[0]; if (!f) return;
    if (/\.(srt|vtt|txt)$/i.test(f.name)) readSubtitleFile(f);
    else if (/\.(wordbox|json)$/i.test(f.name)) readProjectFile(f);
    else importMediaFile(f, pendingMode);
  });
  $$("#modeSwitch button").forEach(b => {
    b.addEventListener("click", () => {
      if (!state.videoFile) return;
      setMode(b.dataset.mode);
    });
  });
  $("#playBtn").addEventListener("click", togglePlay);
  document.addEventListener("keydown", e => {
    if (e.code === "Space" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)){
      e.preventDefault(); togglePlay();
    }
  });
  function togglePlay(){ if (video.src) video.paused ? video.play() : video.pause(); }
  $("#scrub").addEventListener("input", function(){
    if (duration) video.currentTime = (this.value / 1000) * duration;
    dirty = true;
  });
  $("#btnSplitTop").addEventListener("click", splitAtPlayhead);
  $("#btnAddTop").addEventListener("click", addAtPlayhead);
  const si = $("#srtInput");
  $("#btnPickSrt").addEventListener("click", () => si.click());
  si.addEventListener("change", e => { if (e.target.files[0]) readSubtitleFile(e.target.files[0]); });
  $("#btnImportText").addEventListener("click", () => {
    const txt = $("#pasteArea").value;
    if (!txt.trim()) return;
    if (looksLikeSRT(txt)){
      const caps = parseSRT(txt);
      if (caps.length === 0){ alert("No subtitles found in that text."); return; }
      state.orphans = [];
      state.captions = caps;
      rebuildAll();
      spAutoApply();
    } else { distributeText(txt); spAutoApply(); }
  });
  $("#btnClearCaps").addEventListener("click", () => { state.orphans = []; state.captions = []; rebuildAll(); });
  $("#btnDistribute").addEventListener("click", () => {
    const txt = $("#pasteArea").value;
    if (!txt.trim()){ alert("Paste some text first."); return; }
    distributeText(txt);
  });
  $("#btnTranscribe").addEventListener("click", runTranscription);
  $("#btnAddCap").addEventListener("click", addAtPlayhead);
  $("#btnSplitCap").addEventListener("click", splitAtPlayhead);
  $("#btnSnapWord").addEventListener("click", snapWordToPlayhead);
  $("#btnReloadCaps").addEventListener("click", renderCapList);
  $("#btnEmpToggle").addEventListener("click", emphasizeAtPlayhead);
  $("#btnEmpAll").addEventListener("click", emphasizeAll);
  $("#btnEmpClear").addEventListener("click", clearEmphasis);
  $("#emBold").addEventListener("change", e => { state.style.emBold = e.target.checked; rebuildSegments(); });
  $("#emItalic").addEventListener("change", e => { state.style.emItalic = e.target.checked; rebuildSegments(); });
  $("#emTextColor").addEventListener("input", e => { state.style.emTextColor = e.target.value; rebuildSegments(); });
  $("#emBoxColor").addEventListener("input", e => { state.style.emBoxColor = e.target.value; rebuildSegments(); });
  const bgC = $("#videoBgColor"), bgH = $("#videoBgColorHex");
  function applyBg(v){
    state.style.videoBgColor = v;
    bgC.value = v; bgH.value = v;
    applyVideoBgToShell();
    dirty = true;
  }
  bgC.addEventListener("input", () => applyBg(bgC.value));
  bgH.addEventListener("change", () => {
    let v = bgH.value.trim(); if (v.charAt(0) !== "#") v = "#" + v;
    if (!/^#[0-9a-fA-F]{6}$/.test(v)){ bgH.value = state.style.videoBgColor; return; }
    applyBg(v.toLowerCase());
  });
  $("#btnVideoBgReset").addEventListener("click", () => applyBg("#000000"));
  const BG_PRESETS = [
    { c: "#000000", n: "Black" }, { c: "#ffffff", n: "White" },
    { c: "#1a1a1a", n: "Charcoal" }, { c: "#0f172a", n: "Navy" },
    { c: "#7c3aed", n: "Purple" }, { c: "#2563eb", n: "Blue" },
    { c: "#dc2626", n: "Red" }, { c: "#16a34a", n: "Chroma" }
  ];
  const bgWrap = $("#videoBgPresets");
  BG_PRESETS.forEach(p => {
    const d = document.createElement("div");
    d.className = "sw"; d.style.background = p.c; d.title = p.n + " " + p.c;
    d.addEventListener("click", () => applyBg(p.c));
    bgWrap.appendChild(d);
  });
  $("#stageAspect").addEventListener("change", async function(){
    if (this.value === "custom"){
      const r = await askProjectSize({
        title: "Project size", sub: "Pick the canvas this project renders on.",
        ok: "Apply size", w: state.style.projW, h: state.style.projH
      });
      if (!r){ this.value = state.style.stageAspect; return; }
      applyProjectSize(r.w, r.h);
      return;
    }
    state.style.stageAspect = this.value;
    syncProjSizeRow();
    if (VW && VH){ recomputeStage(); fitStage(); renderTimeline(); }
    dirty = true;
  });
  $("#fontFamily").addEventListener("change", function(){
    state.style.fontFamily = this.value;
    if (document.fonts) document.fonts.load(state.style.fontWeight + ' 64px "' + this.value + '"').then(() => { dirty = true; }).catch(()=>{});
    rebuildSegments();
  });
  $("#fontWeight").addEventListener("change", function(){ state.style.fontWeight = parseInt(this.value, 10); rebuildSegments(); });
  const fsEl = $("#fontSize"), fsNum = $("#fontSizeNum"), fsLab = $("#fsLabel");
  fsEl.addEventListener("input", function(){ const v = parseInt(this.value, 10); state.style.fontSize = v; fsNum.value = v; fsLab.textContent = v + " px"; rebuildSegments(); });
  fsNum.addEventListener("input", function(){
    let v = parseInt(this.value, 10); if (isNaN(v)) return;
    v = clamp(v, 8, 400); state.style.fontSize = v; fsEl.value = clamp(v, 16, 200);
    fsLab.textContent = v + " px"; rebuildSegments();
  });
  $("#uppercase").addEventListener("change", e => { state.style.uppercase = e.target.checked; rebuildSegments(); });
  bindColor("#textColor", "#textColorHex", "textColor");
  bindColor("#boxColor",  "#boxColorHex",  "boxColor");
  bindColor("#accentColor", "#accentColorHex", "accentColor");
  $("#strokeColor").addEventListener("input", e => { state.style.strokeColor = e.target.value; rebuildSegments(); });
  $("#strokeWidth").addEventListener("input", function(){
    state.style.strokeWidth = parseFloat(this.value) || 0;
    $("#strokeWidthVal").textContent = this.value;
    rebuildSegments();
  });
  $("#btnSwapColors").addEventListener("click", () => {
    const t = state.style.textColor;
    state.style.textColor = state.style.boxColor;
    state.style.boxColor = t;
    syncColorInputs(); rebuildSegments();
  });
  function bindRng(id, key, opts){
    const el = $("#" + id), lab = $("#" + id + "Val");
    el.addEventListener("input", () => {
      let v = parseFloat(el.value);
      if (opts && opts.scale) v = v * opts.scale;
      state.style[key] = v;
      if (lab) lab.textContent = (opts && opts.suffix) ? el.value + opts.suffix : el.value;
      rebuildSegments();
    });
  }
  setupPadding();
  bindRng("corner", "corner");
  bindRng("yPos", "yPct", { suffix: "%" });
  bindRng("maxWidth", "maxWidthPct", { suffix: "%" });
  bindRng("lineSpacing", "lineSpacing");
  $("#corner").addEventListener("input", function(){ $("#cornerVal").textContent = this.value; });
  $("#yPos").addEventListener("input", function(){ $("#yPosVal").textContent = this.value + "%"; });
  $("#maxWidth").addEventListener("input", function(){ $("#maxWidthVal").textContent = this.value + "%"; });
  $("#lineSpacing").addEventListener("input", function(){ $("#lineSpacingVal").textContent = parseFloat(this.value).toFixed(2); });
  $("#maxLines").addEventListener("change", function(){ state.style.maxLines = parseInt(this.value, 10); rebuildSegments(); });
  ["shadowType","shadowFade","shadowColor","shadowLayer","shadowScope"].forEach(id => { const el = $("#"+id); if (el) el.addEventListener("input", function(){ state.style[id] = this.value; rebuildSegments(); }); });
  { const el = $("#shadowBox"); if (el) el.addEventListener("change", function(){ state.style.shadowBox = this.checked; rebuildSegments(); }); }
  [["shadowDirection","shadowDirection","°"],["shadowDistance","shadowDistance",""],["shadowOpacity","shadowOpacity","%"],["shadowBlur","shadowBlur",""]].forEach(([id,key,suffix]) => {
    $("#"+id).addEventListener("input", function(){ state.style[key] = parseFloat(this.value); $("#"+id+"Val").textContent = this.value + suffix; rebuildSegments(); });
  });
  $("#keepWordsTogether").addEventListener("change", function(){ state.style.keepWordsTogether = this.checked; rebuildSegments(); });
  $("#maxWords").addEventListener("input", function(){ let v = parseInt(this.value, 10); if (isNaN(v) || v < 0) v = 0; state.style.maxWords = v; rebuildSegments(); });
  $("#wordsMode").addEventListener("change", function(){ state.style.wordsMode = parseInt(this.value, 10); rebuildSegments(); });
  $("#revealMode").addEventListener("change", function(){ state.style.revealMode = parseInt(this.value, 10); rebuildSegments(); });
  $("#boxMode").addEventListener("change", function(){ state.style.boxMode = parseInt(this.value, 10); rebuildSegments(); });
  $("#animIn").addEventListener("change", function(){ state.style.animIn = this.value; rebuildSegments(); });
  function bindArng(id, key){
    const el = $("#" + id), lab = $("#" + id + "Val");
    el.addEventListener("input", () => {
      state.style[key] = parseFloat(el.value);
      if (lab) lab.textContent = parseFloat(el.value).toFixed(2) + (id === "popFrom" || id === "moveDist" ? "%" : "s");
      rebuildSegments();
    });
  }
  bindArng("popTime", "popTime");
  bindArng("popFrom", "popFrom");
  bindArng("moveDist", "moveDist");
  bindArng("stagger", "stagger");
  bindArng("outTime", "outTime");
  $("#animOut").addEventListener("change", e => { state.style.animOut = e.target.checked; rebuildSegments(); });
  $("#timingMode").addEventListener("change", function(){ state.style.timingMode = parseInt(this.value, 10); rebuildSegments(); });
  $("#btnExportTop").addEventListener("click", () => {
    $$("#tabs button").forEach(b => b.classList.remove("active"));
    $$(".tab-page").forEach(p => p.classList.remove("active"));
    document.querySelector('[data-tab="export"]').classList.add("active");
    document.querySelector('[data-page="export"]').classList.add("active");
  });
  $("#btnExportSrt").addEventListener("click", exportSRT);
  $("#btnExportVtt").addEventListener("click", exportVTT);
  $("#btnExportVideo").addEventListener("click", exportVideo);
  $("#btnExportPng").addEventListener("click", exportPNG);
  $("#btnSaveJson").addEventListener("click", saveProject);
  $("#btnLoadJson").addEventListener("click", () => $("#jsonInput").click());
  $("#jsonInput").addEventListener("change", loadProject);
  const PRESET_COLORS = ["#ffffff","#000000","#ffd400","#ff7a00","#ff3b30","#ff2d92",
                         "#7c3aed","#2563eb","#00c2ff","#22c55e","#a3e635","#1f2937"];
  const pw = $("#presets");
  PRESET_COLORS.forEach(hex => {
    const d = document.createElement("div");
    d.className = "sw"; d.style.background = hex; d.title = hex;
    d.addEventListener("click", () => {
      const af = document.activeElement;
      const target = (af === $("#boxColor") || af === $("#boxColorHex")) ? "boxColor"
                   : (af === $("#accentColor") || af === $("#accentColorHex")) ? "accentColor"
                   : "textColor";
      state.style[target] = hex; syncColorInputs(); rebuildSegments();
    });
    pw.appendChild(d);
  });
}
function readSubtitleFile(file){
  const r = new FileReader();
  r.onload = () => {
    const txt = String(r.result).replace(/^\uFEFF/, "");
    const caps = parseSRT(txt);
    if (caps.length === 0){ alert("No subtitles found in that file."); return; }
    state.orphans = [];
    state.captions = caps;
    rebuildAll();
    spAutoApply();
  };
  r.readAsText(file, "UTF-8");
}

/* =====================================================================
   BOOT
   ===================================================================== */
function boot(){
  normalizeStyle();
  setupUI();
  setupSizeDialog();
  setupSpelling();
  syncStyleToUI();
  applyVideoBgToShell();
  applyModeUI();
  updateCapInfo();
  rebuildSegments();
  renderTimeline();
  renderCapList();
  requestAnimationFrame(renderLoop);
  if (document.fonts && document.fonts.load){
    document.fonts.load('800 64px "Inter"').then(() => { dirty = true; }).catch(()=>{});
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

})();
