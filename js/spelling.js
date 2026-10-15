/* =====================================================================
   WordBox Studio — US / UK spelling
   ---------------------------------------------------------------------
   Converts caption text between American and British spelling. Everything
   runs in the browser: no network, no API key, nothing leaves the page.

   The pass is deliberately conservative. A word is only changed when the
   change is safe in that direction — "licence" always becomes "license"
   in US English, but "license" is left alone going the other way, because
   British English keeps "license" as the verb. Pairs carry a direction
   flag for exactly this reason.
   ===================================================================== */
"use strict";

/* ---------- irregular pairs: [British, American, direction] ----------
   direction: "both" | "uk2us" (only British → American) | "us2uk"       */
const PAIRS = [
  // ae / oe
  ["anaemia","anemia","both"], ["anaemic","anemic","both"],
  ["anaesthetic","anesthetic","both"], ["anaesthesia","anesthesia","both"],
  ["archaeology","archeology","uk2us"], ["coeliac","celiac","both"],
  ["diarrhoea","diarrhea","both"], ["encyclopaedia","encyclopedia","both"],
  ["faeces","feces","both"], ["foetus","fetus","both"], ["foetal","fetal","both"],
  ["gynaecology","gynecology","both"], ["haemoglobin","hemoglobin","both"],
  ["haemorrhage","hemorrhage","both"], ["haemophilia","hemophilia","both"],
  ["leukaemia","leukemia","both"], ["mediaeval","medieval","uk2us"],
  ["oesophagus","esophagus","both"], ["oestrogen","estrogen","both"],
  ["orthopaedic","orthopedic","both"], ["paediatric","pediatric","both"],
  ["paediatrician","pediatrician","both"], ["palaeontology","paleontology","both"],
  ["manoeuvre","maneuver","both"], ["manoeuvres","maneuvers","both"],
  ["manoeuvred","maneuvered","both"], ["manoeuvring","maneuvering","both"],
  // ce / se  (one-way: British keeps the -se spelling for the verb)
  ["defence","defense","uk2us"], ["offence","offense","uk2us"],
  ["pretence","pretense","uk2us"], ["licence","license","uk2us"],
  ["practise","practice","uk2us"], ["practising","practicing","uk2us"],
  ["practised","practiced","uk2us"],
  // single / double l
  ["cancelled","canceled","both"], ["cancelling","canceling","both"],
  ["counselled","counseled","both"], ["counselling","counseling","both"],
  ["counsellor","counselor","both"], ["counsellors","counselors","both"],
  ["chiselled","chiseled","both"], ["dialled","dialed","both"],
  ["dialling","dialing","both"], ["equalled","equaled","both"],
  ["fuelled","fueled","both"], ["fuelling","fueling","both"],
  ["jewellery","jewelry","both"], ["jeweller","jeweler","both"],
  ["labelled","labeled","both"], ["labelling","labeling","both"],
  ["levelled","leveled","both"], ["levelling","leveling","both"],
  ["marvelled","marveled","both"], ["marvellous","marvelous","both"],
  ["modelled","modeled","both"], ["modelling","modeling","both"],
  ["pencilled","penciled","both"], ["quarrelled","quarreled","both"],
  ["rivalled","rivaled","both"], ["signalled","signaled","both"],
  ["signalling","signaling","both"], ["totalled","totaled","both"],
  ["travelled","traveled","both"], ["travelling","traveling","both"],
  ["traveller","traveler","both"], ["travellers","travelers","both"],
  ["tunnelled","tunneled","both"], ["woollen","woolen","both"],
  // the other way round: British doubles, American keeps one
  ["appal","appall","both"], ["appalled","appalled","both"],
  ["distil","distill","both"], ["enrol","enroll","both"],
  ["enrolment","enrollment","both"], ["enthral","enthrall","both"],
  ["fulfil","fulfill","both"], ["fulfilment","fulfillment","both"],
  ["instalment","installment","both"], ["instil","instill","both"],
  ["skilful","skillful","both"], ["wilful","willful","both"],
  // everyday words
  ["aeroplane","airplane","both"], ["aluminium","aluminum","both"],
  ["ageing","aging","both"], ["cheque","check","uk2us"],
  ["cosy","cozy","both"], ["doughnut","donut","us2uk"],
  ["draught","draft","uk2us"], ["gaol","jail","uk2us"],
  ["grey","gray","both"], ["kerb","curb","uk2us"],
  ["judgement","judgment","both"], ["maths","math","both"],
  ["moustache","mustache","both"], ["mum","mom","both"],
  ["plough","plow","both"], ["programme","program","uk2us"],
  ["pyjamas","pajamas","both"], ["sceptical","skeptical","both"],
  ["sceptic","skeptic","both"], ["speciality","specialty","uk2us"],
  ["storey","story","uk2us"], ["sulphur","sulfur","both"],
  ["tyre","tyre_US_tire","never"],            // placeholder, replaced below
  ["whilst","while","uk2us"], ["amongst","among","uk2us"],
  ["carburettor","carburetor","both"], ["axe","ax","never"]
];
PAIRS.push(["tyre","tire","uk2us"], ["tyres","tires","uk2us"]);

/* ---------- -our / -or ---------- */
const OUR_STEMS = ["arbour","ardour","armour","behaviour","candour","clamour","colour",
  "demeanour","endeavour","favour","fervour","flavour","harbour","honour","humour",
  "labour","misdemeanour","neighbour","odour","parlour","rancour","rigour","rumour",
  "saviour","savour","splendour","succour","tumour","valour","vapour","vigour"];
const OUR_TAILS = ["","s","ed","ing","er","ers","less","ful","fully","able","ably","ite","ites",
  "ly","ist","ists","hood","hoods","ing's","s'","'s"];

/* ---------- -re / -er ---------- */
const RE_ENDINGS = [
  ["centre","center"], ["theatre","theater"], ["metre","meter"], ["litre","liter"],
  ["fibre","fiber"], ["calibre","caliber"], ["sombre","somber"], ["spectre","specter"],
  ["lustre","luster"], ["meagre","meager"], ["sceptre","scepter"], ["mitre","miter"],
  ["titre","titer"], ["goitre","goiter"], ["ochre","ocher"], ["sepulchre","sepulcher"],
  ["saltpetre","saltpeter"], ["reconnoitre","reconnoiter"], ["louvre","louver"]
];
/* Going back to British, these American forms are ambiguous ("meter" is also a
   parking meter in Britain), so only the unambiguous ones travel both ways. */
const RE_SAFE_BACK = { center:1, theater:1, fiber:1, liter:1, caliber:1, somber:1,
  specter:1, luster:1, meager:1, scepter:1, sepulcher:1, saltpeter:1, reconnoiter:1 };
const RE_TAILS = ["","s","d","ed","ing","al","ally","ed's"];

/* ---------- -ise / -ize ---------- */
/* Words that end in -ise in every variety of English. */
const ISE_KEEP = new Set(("advertise advise anise apprise arise braise bruise chastise chemise " +
  "circumcise comprise compromise concise cruise demise despise devise disguise enterprise " +
  "excise exercise expertise franchise guise improvise incise malaise mayonnaise merchandise " +
  "mortise noise paradise poise practise praise precise premise prise promise raise reprise " +
  "revise rise supervise surmise surprise televise tortoise treatise valise wise likewise " +
  "otherwise clockwise anticlockwise crosswise lengthwise").split(" "));
const ISE_SUFFIXES = [
  ["isation","ization"], ["isations","izations"], ["ising","izing"], ["ised","ized"],
  ["iser","izer"], ["isers","izers"], ["isable","izable"], ["ises","izes"], ["ise","ize"]
];
/* -yse / -yze */
const YSE_STEMS = ["analyse","paralyse","catalyse","dialyse","electrolyse","hydrolyse",
  "breathalyse","paralyse"];
const YSE_TAILS = ["","s","d","ed","ing","r","rs"];

/* ---------- case handling ---------- */
function matchCase(src, out){
  if (src === src.toUpperCase() && src !== src.toLowerCase()) return out.toUpperCase();
  if (src.charAt(0) === src.charAt(0).toUpperCase() && src.slice(1) === src.slice(1).toLowerCase())
    return out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

/* ---------- the word-level converter ---------- */
function buildMaps(){
  const uk2us = new Map(), us2uk = new Map();
  for (const [uk, us, dir] of PAIRS){
    if (dir === "never") continue;
    if (dir === "both" || dir === "uk2us") uk2us.set(uk, us);
    if (dir === "both" || dir === "us2uk") us2uk.set(us, uk);
  }
  return { uk2us, us2uk };
}
const MAPS = buildMaps();

function convertWord(word, target){
  const lower = word.toLowerCase();
  const toUS = target === "us";
  const direct = toUS ? MAPS.uk2us.get(lower) : MAPS.us2uk.get(lower);
  if (direct) return direct;

  // -our / -or
  for (const stem of OUR_STEMS){
    const usStem = stem.replace(/our$/, "or");
    const from = toUS ? stem : usStem;
    const to   = toUS ? usStem : stem;
    if (lower.startsWith(from)){
      const tail = lower.slice(from.length);
      if (OUR_TAILS.indexOf(tail) >= 0) return to + tail;
    }
  }
  // -re / -er  (suffix match, so kilometre and millilitre come along)
  for (const [ukEnd, usEnd] of RE_ENDINGS){
    const from = toUS ? ukEnd : usEnd;
    const to   = toUS ? usEnd : ukEnd;
    for (const tail of RE_TAILS){
      const whole = from + tail;
      if (!lower.endsWith(whole)) continue;
      const head = lower.slice(0, lower.length - whole.length);
      if (!/^[a-z]*$/.test(head)) continue;
      // Coming back to British, "meter" could be a parking meter — but
      // "kilometer" never is, so a prefixed form is still safe.
      if (!toUS && !RE_SAFE_BACK[usEnd] && head === "") continue;
      return head + to + tail;
    }
  }
  // -yse / -yze
  for (const stem of YSE_STEMS){
    const usStem = stem.replace(/yse$/, "yze");
    const from = toUS ? stem : usStem;
    const to   = toUS ? usStem : stem;
    if (lower.startsWith(from)){
      const tail = lower.slice(from.length);
      if (YSE_TAILS.indexOf(tail) >= 0) return to + tail;
    }
  }
  // -ise / -ize
  for (const [ukSuf, usSuf] of ISE_SUFFIXES){
    const from = toUS ? ukSuf : usSuf;
    const to   = toUS ? usSuf : ukSuf;
    if (!lower.endsWith(from)) continue;
    const stem = lower.slice(0, lower.length - from.length);
    if (stem.length < 3) continue;
    const base = stem + (toUS ? "ise" : "ize");
    const ukBase = toUS ? base : stem + "ise";
    if (ISE_KEEP.has(ukBase)) continue;
    // A vowel right before the suffix nearly always means a word like "praise"
    // or "noise" rather than a verb that takes -ize.
    if (/[aeiou]$/.test(stem)) continue;
    return stem + to;
  }
  return null;
}

/* ---------- token-level: keeps punctuation, *emphasis* and case ---------- */
const WORD_RE = /^([^A-Za-z]*)([A-Za-z]+(?:['’][A-Za-z]+)*)([^A-Za-z]*)$/;

function convertToken(token, target){
  const m = WORD_RE.exec(token);
  if (!m) return null;
  const [, lead, core, trail] = m;
  // Work on the first part of a contraction ("colour's" → "color's").
  const apos = core.search(/['’]/);
  const head = apos < 0 ? core : core.slice(0, apos);
  const rest = apos < 0 ? "" : core.slice(apos);
  const out = convertWord(head, target);
  if (!out || out === head.toLowerCase()) return null;
  return { from: head, to: matchCase(head, out), token: lead + matchCase(head, out) + rest + trail };
}

/* Light tidy-up: doubled spaces, a space before punctuation, a lonely "i". */
function tidy(text){
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/(^|[\s(\u201c"])i(?=[\s,.!?;:'\u2019)\u201d"]|$)/g, "$1I")
    .trim();
}

/* ---------- public API ----------
   Returns { text, changes:[{from,to}] } for one caption. */
export function convertCaption(text, target, opts){
  const o = opts || {};
  const changes = [];
  const parts = String(text).split(/(\s+)/);
  for (let i = 0; i < parts.length; i++){
    if (/^\s*$/.test(parts[i])) continue;
    // A hyphenated compound is converted piece by piece ("metre-long").
    const pieces = parts[i].split("-");
    let touched = false;
    for (let j = 0; j < pieces.length; j++){
      const r = convertToken(pieces[j], target);
      if (r){ pieces[j] = r.token; touched = true; changes.push({ from: r.from, to: r.to }); }
    }
    if (touched) parts[i] = pieces.join("-");
  }
  let out = parts.join("");
  if (o.tidy){
    const t = tidy(out);
    if (t !== out) changes.push({ from: "spacing", to: "tidied", tidy: true });
    out = t;
  }
  return { text: out, changes };
}

export const VARIANTS = [
  { id: "us", name: "American (US)" },
  { id: "uk", name: "British (UK)" }
];
