/**
 * Tokenizer for BM25: lowercase, strip accents, split on non-alphanumerics, drop
 * stopwords, Porter-stem words (numbers kept as-is, so "90" can match "90 days").
 * Deterministic and tested; good enough for a ~120-clause policy corpus.
 */

const STOPWORDS = new Set(
  "a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its me my no not of on or our she so than that the their them then there these they this to too up us was we were what when where which who why will with would you your yours".split(
    " ",
  ),
);

export function normalize(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of normalize(text).split(/[^a-z0-9]+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    out.push(/^\d+$/.test(raw) ? raw.replace(/^0+(?=\d)/, "") : stem(raw));
  }
  return out;
}

// ---------------------------------------------------------------- Porter stemmer (1980)

const isCons = (w: string, i: number): boolean => {
  const c = w[i];
  if ("aeiou".includes(c)) return false;
  if (c === "y") return i === 0 ? true : !isCons(w, i - 1);
  return true;
};

/** m() = number of VC sequences in the stem. */
function measure(w: string): number {
  let n = 0;
  let i = 0;
  const len = w.length;
  while (i < len && isCons(w, i)) i++;
  while (i < len) {
    while (i < len && !isCons(w, i)) i++;
    if (i >= len) break;
    n++;
    while (i < len && isCons(w, i)) i++;
  }
  return n;
}

const hasVowel = (w: string) => {
  for (let i = 0; i < w.length; i++) if (!isCons(w, i)) return true;
  return false;
};
const endsDoubleCons = (w: string) => w.length >= 2 && w[w.length - 1] === w[w.length - 2] && isCons(w, w.length - 1);
const cvc = (w: string) => {
  const l = w.length;
  if (l < 3) return false;
  if (!isCons(w, l - 3) || isCons(w, l - 2) || !isCons(w, l - 1)) return false;
  return !"wxy".includes(w[l - 1]);
};

function replaceSuffix(w: string, suffix: string, repl: string, cond: (stem: string) => boolean): string | null {
  if (!w.endsWith(suffix)) return null;
  const stemPart = w.slice(0, w.length - suffix.length);
  return cond(stemPart) ? stemPart + repl : w;
}

export function stem(word: string): string {
  if (word.length <= 2) return word;
  let w = word;

  // Step 1a
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (w.endsWith("ss")) {
    /* keep */
  } else if (w.endsWith("s")) w = w.slice(0, -1);

  // Step 1b
  let step1bExtra = false;
  if (w.endsWith("eed")) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && hasVowel(w.slice(0, -2))) {
    w = w.slice(0, -2);
    step1bExtra = true;
  } else if (w.endsWith("ing") && hasVowel(w.slice(0, -3))) {
    w = w.slice(0, -3);
    step1bExtra = true;
  }
  if (step1bExtra) {
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
    else if (endsDoubleCons(w) && !"lsz".includes(w[w.length - 1])) w = w.slice(0, -1);
    else if (measure(w) === 1 && cvc(w)) w += "e";
  }

  // Step 1c
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + "i";

  // Step 2
  const step2: [string, string][] = [
    ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"], ["izer", "ize"], ["abli", "able"],
    ["alli", "al"], ["entli", "ent"], ["eli", "e"], ["ousli", "ous"], ["ization", "ize"], ["ation", "ate"],
    ["ator", "ate"], ["alism", "al"], ["iveness", "ive"], ["fulness", "ful"], ["ousness", "ous"], ["aliti", "al"],
    ["iviti", "ive"], ["biliti", "ble"],
  ];
  for (const [suf, rep] of step2) {
    const r = replaceSuffix(w, suf, rep, (st) => measure(st) > 0);
    if (r !== null) {
      w = r;
      break;
    }
  }

  // Step 3
  const step3: [string, string][] = [["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"], ["ical", "ic"], ["ful", ""], ["ness", ""]];
  for (const [suf, rep] of step3) {
    const r = replaceSuffix(w, suf, rep, (st) => measure(st) > 0);
    if (r !== null) {
      w = r;
      break;
    }
  }

  // Step 4
  const step4 = ["al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement", "ment", "ent", "ion", "ou", "ism", "ate", "iti", "ous", "ive", "ize"];
  for (const suf of step4) {
    if (!w.endsWith(suf)) continue;
    const st = w.slice(0, -suf.length);
    if (measure(st) > 1) {
      if (suf === "ion") {
        if (st.endsWith("s") || st.endsWith("t")) w = st;
      } else {
        w = st;
      }
    }
    break;
  }

  // Step 5a
  if (w.endsWith("e")) {
    const st = w.slice(0, -1);
    const m = measure(st);
    if (m > 1 || (m === 1 && !cvc(st))) w = st;
  }
  // Step 5b
  if (measure(w) > 1 && endsDoubleCons(w) && w.endsWith("l")) w = w.slice(0, -1);

  return w;
}
