/**
 * Extracteur général de résultats : sur n'importe quelle page de liste (logements, produits, restos,
 * annonces), repère les blocs qui se répètent et portent une photo et un lien, et en tire titre, prix,
 * photo, lien et un bout de texte. Aucune connaissance d'un site : c'est la structure de la page qui
 * parle. Le choix des options à montrer reste au modèle.
 *
 * Passé à la page en texte (évalué tel quel), pour que le compilateur n'y glisse rien.
 */
export interface ListingItem {
  index: number;
  title: string;
  price?: string;
  text: string;
  url?: string;
  image?: string;
}

export const LISTING_FN = `(() => {
  const abs = (u) => { try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : undefined; } catch (e) { return undefined; } };
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const PRICE = /(?:€|EUR|\\$|£|CHF)\\s?\\d[\\d\\s.,]*|\\d[\\d\\s.,]*\\s?(?:€|EUR|\\$|£|CHF)/;
  const sig = (el) => el.tagName + "." + Array.from(el.classList).sort().slice(0, 3).join(".");
  const isCard = (el) => {
    const img = el.querySelector("img");
    const a = el.tagName === "A" ? el : el.querySelector("a[href]");
    const len = clean(el.innerText).length;
    return !!img && !!a && len >= 15 && len <= 1500;
  };
  // Les groupes : des frères de même forme, chacun avec photo, lien et texte.
  const groups = new Map();
  for (const p of document.querySelectorAll("body *")) {
    if (p.children.length < 3) continue;
    const bySig = new Map();
    for (const c of p.children) {
      if (!isCard(c)) continue;
      const k = sig(c);
      bySig.set(k, (bySig.get(k) || []).concat([c]));
    }
    for (const [k, els] of bySig) if (els.length >= 3) groups.set(p.tagName + ">" + k + groups.size, els);
  }
  let best = [];
  let bestScore = 0;
  for (const els of groups.values()) {
    const withPrice = els.filter((e) => PRICE.test(e.innerText || "")).length;
    const score = els.length + withPrice * 2;
    if (score > bestScore) { best = els; bestScore = score; }
  }
  return best.slice(0, 20).map((el, index) => {
    const head = el.querySelector("h1,h2,h3,h4,[data-testid*=title],[class*=title],[class*=Title]");
    const link = el.tagName === "A" ? el : el.querySelector("a[href]");
    const img = Array.from(el.querySelectorAll("img")).find((i) => (i.naturalWidth || i.width || 100) >= 60) || el.querySelector("img");
    const text = clean(el.innerText);
    const m = text.match(PRICE);
    return {
      index,
      title: clean((head && head.textContent) || (link && link.textContent) || text.slice(0, 80)).slice(0, 120),
      price: m ? clean(m[0]) : undefined,
      text: text.slice(0, 300),
      url: link ? abs(link.getAttribute("href")) : undefined,
      image: img ? abs(img.currentSrc || img.getAttribute("src") || img.getAttribute("data-src")) : undefined,
    };
  });
})()`;
