import type { PageElement, PageSnapshot } from "./types.ts";
import { wrapUntrusted } from "../untrusted.ts";

/**
 * Lecture d'une page en une seule évaluation par cadre : la liste des éléments actionnables
 * (avec une référence courte pour le modèle), le texte visible, et quelques indices.
 *
 * Écrit en source JavaScript pour servir tel quel à tous les moteurs : Playwright et ses
 * dérivés l'évaluent et gardent les nœuds en poignées ; le pont nodriver (Python) les range
 * sous une clé aléatoire non énumérable de `window`.
 *
 * Les mots de passe, codes à usage unique et numéros de carte n'ont jamais de valeur ici.
 * Idée reprise de Murmell (bots/browser-snapshot.ts), réécrite pour Mell.
 */
export const SNAPSHOT_FN = `(opts) => {
  const SEL = "a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=combobox],[role=menuitem],[role=menuitemradio],[role=option],[role=switch],[role=textbox],[role=searchbox],[role=gridcell],[contenteditable=''],[contenteditable=true],[onclick],[tabindex]:not([tabindex='-1'])";
  const SENSITIVE = /(password|passwd|mot.?de.?passe|otp|one.?time|verification|v[ée]rification|passcode|security.?code|cvc|cvv|cryptogramme|card.?number|num[ée]ro.?de.?carte|iban)/i;
  const PERSONAL = /(e-?mail|courriel|phone|t[ée]l[ée]phone|mobile|first.?name|last.?name|pr[ée]nom|surname|full.?name|^nom$|street|adresse|address|postal)/i;
  const roots = [document];
  const cands = [];
  let examined = 0;
  let anyLayout = false;
  const pointer = (el) => { try { return getComputedStyle(el).cursor === "pointer"; } catch (e) { return false; } };
  for (let r = 0; r < roots.length && r < 60 && examined < 15000; r++) {
    let all;
    try { all = roots[r].querySelectorAll("*"); } catch (e) { continue; }
    for (const node of all) {
      if (++examined > 15000) break;
      if (node.shadowRoot) roots.push(node.shadowRoot);
      let ok = false;
      try { ok = node.matches(SEL); } catch (e) {}
      if (!ok && pointer(node) && !(node.parentElement && pointer(node.parentElement))) ok = true;
      if (!ok) continue;
      if (cands.length < 800) cands.push(node);
    }
  }
  const vh = window.innerHeight || 800;
  const items = [];
  for (const node of cands) {
    let rect = null;
    try { rect = node.getBoundingClientRect(); } catch (e) {}
    if (rect && (rect.width > 0 || rect.height > 0)) anyLayout = true;
    items.push({ node, rect });
  }
  const visible = items.filter(({ node, rect }) => {
    if (!anyLayout) return true;
    if (!rect || !(rect.width > 0 && rect.height > 0)) return false;
    try { const s = getComputedStyle(node); if (s.visibility === "hidden" || s.visibility === "collapse" || s.display === "none") return false; } catch (e) {}
    return true;
  });
  const isField = (n) => n.matches && n.matches("input,textarea,select,[role=textbox],[role=searchbox],[role=combobox]");
  let chosen = visible;
  const MAX = opts.maxElements || 150;
  if (visible.length > MAX) {
    const score = ({ node, rect }) => {
      if (node === document.activeElement) return -1e9;
      const d = rect ? (rect.top < 0 ? -rect.top + vh : rect.top > vh ? rect.top - vh : 0) : 0;
      return d - (isField(node) ? 5000 : 0) - (node.matches && node.matches("[role=option],[role=menuitem]") ? 4000 : 0);
    };
    const keep = new Set(visible.slice().sort((a, b) => score(a) - score(b)).slice(0, MAX).map((x) => x.node));
    chosen = visible.filter((x) => keep.has(x.node));
  }
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const labelOf = (node) => {
    const root = node.getRootNode ? node.getRootNode() : document;
    const by = (node.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean).slice(0, 6)
      .map((id) => { const el = root.getElementById ? root.getElementById(id) : document.getElementById(id); return el ? el.textContent : ""; }).join(" ");
    const labels = node.labels ? Array.from(node.labels).map((l) => l.textContent).join(" ") : "";
    const img = node.querySelector ? node.querySelector("img[alt]") : null;
    const own = node.matches("input,textarea,select") ? "" : (node.innerText || node.textContent || "");
    return clean(node.getAttribute("aria-label") || by || labels || node.getAttribute("placeholder") || own || node.getAttribute("title") || (img && img.getAttribute("alt")) || node.getAttribute("value") || node.getAttribute("name") || "");
  };
  const roleOf = (node) => {
    const r = node.getAttribute("role");
    if (r) return r;
    const t = node.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "select") return "combobox";
    if (t === "textarea") return "textbox";
    if (t === "input") {
      const ty = (node.getAttribute("type") || "text").toLowerCase();
      if (ty === "checkbox" || ty === "radio") return ty;
      if (ty === "submit" || ty === "button" || ty === "reset" || ty === "image") return "button";
      return "textbox";
    }
    return t === "summary" ? "button" : t === "button" ? "button" : t;
  };
  const info = [];
  const nodes = [];
  let personalFilled = false;
  for (const { node } of chosen) {
    const field = node;
    const hint = [field.name, field.id, field.getAttribute("autocomplete"), field.getAttribute("aria-label"), field.getAttribute("placeholder"), node.labels ? Array.from(node.labels).map((l) => l.textContent).join(" ") : ""].filter(Boolean).join(" ");
    const isInput = node.matches("input,textarea");
    const type = node.tagName === "INPUT" ? (node.getAttribute("type") || "text").toLowerCase() : undefined;
    const sensitive = node.hasAttribute("data-mella-secret") || (isInput && (type === "password" || /one-time-code|cc-|password/.test(field.getAttribute("autocomplete") || "") || SENSITIVE.test(hint)));
    if (isInput && !sensitive && field.value && (type === "email" || type === "tel" || PERSONAL.test(hint))) personalFilled = true;
    const e = { role: roleOf(node), name: (sensitive ? "Champ sensible " : "") + labelOf(node).slice(0, 120) };
    if (type) e.type = type;
    if (!sensitive && (isInput || node.tagName === "SELECT") && field.value) e.value = String(field.value).slice(0, 80);
    if (sensitive) e.sensitive = true;
    if (node.matches(":disabled,[aria-disabled=true]")) e.disabled = true;
    if (type === "checkbox" || type === "radio") e.checked = !!field.checked;
    else if (node.hasAttribute("aria-checked")) e.checked = node.getAttribute("aria-checked") === "true";
    else if (node.hasAttribute("aria-selected")) e.checked = node.getAttribute("aria-selected") === "true";
    if (node.tagName === "A" && node.getAttribute("href")) {
      try { const u = new URL(node.getAttribute("href"), location.href); if (/^https?:$/.test(u.protocol)) e.href = (u.host === location.host ? "" : u.host) + u.pathname.slice(0, 60) + (u.search ? u.search.slice(0, 40) : ""); } catch (er) {}
    }
    if (node.tagName === "SELECT") e.options = Array.from(node.options).slice(0, 30).map((o) => clean(o.label || o.text).slice(0, 40));
    info.push(e);
    nodes.push(node);
  }
  let text = "";
  try { text = (document.body && (document.body.innerText || document.body.textContent)) || ""; } catch (e) {}
  text = text.replace(/[ \\t]+/g, " ").replace(/\\n\\s*\\n+/g, "\\n");
  const markers = [];
  try { for (const s of document.scripts) if (s.src) markers.push(s.src); } catch (e) {}
  try { for (const f of document.querySelectorAll("iframe")) if (f.src) markers.push(f.src); } catch (e) {}
  for (const id of ["challenge-form", "challenge-running", "px-captcha", "cf-turnstile", "captcha-container", "sec-if-cpt-container"]) {
    try { if (document.getElementById(id) || document.querySelector("." + id)) markers.push("#" + id); } catch (e) {}
  }
  let status;
  try { const nav = performance.getEntriesByType("navigation")[0]; if (nav && nav.responseStatus) status = nav.responseStatus; } catch (e) {}
  const result = { info, title: document.title || "", url: location.href, text: text.slice(opts.textOffset || 0, (opts.textOffset || 0) + (opts.textLimit || 6000)), totalText: text.length, personalFilled, markers: markers.join(" ").slice(0, 20000), status };
  if (opts.registry) {
    try { Object.defineProperty(window, opts.registry, { value: nodes, configurable: true, enumerable: false, writable: true }); } catch (e) {}
    return result;
  }
  result.nodes = nodes;
  return result;
}`;

export interface RawFrameSnapshot {
  info: Omit<PageElement, "ref">[];
  title: string;
  url: string;
  text: string;
  totalText: number;
  personalFilled: boolean;
  markers: string;
  status?: number;
}

const DATE_HINT = /\b(date|dates|aller|retour|arrivée le|départ le|check-?in|check-?out|calendrier|calendar|quand|when)\b/i;

/** Un élément sans sa référence (qui change à chaque lecture) : rôle et nom. */
export const elementKey = (e: { role: string; name: string }) => `${e.role}|${e.name}`;

/** Empreinte d'une page pour voir si une action a changé quelque chose : adresse, éléments et valeurs, début du texte. */
export function pageFingerprint(s: PageSnapshot): string {
  const els = s.elements.map((e) => `${elementKey(e)}|${e.value ?? ""}|${e.checked ?? ""}`).join("\n");
  let h = 0;
  for (const c of `${els}\n${s.text.slice(0, 4000)}`) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return `${s.url.replace(/[?#].*$/, "")}|${s.elements.length}|${h}`;
}

/**
 * Ce que le modèle lit : URL, titre, éléments avec références, puis le texte. Tout ce qui vient
 * de la page est enveloppé comme donnée non fiable (règle 6) : un texte « ignore tes consignes »
 * dans une page reste une donnée.
 */
export function formatSnapshot(s: PageSnapshot, opts: { textOffset?: number; fresh?: Set<string> } = {}): string {
  const lines = s.elements.map((e) => {
    // « * » : apparu depuis la dernière action (menu, calendrier, suggestions), comme browser-use.
    const bits = [`${opts.fresh?.has(elementKey(e)) ? "*" : ""}[${e.ref}] ${e.role}`];
    if (e.name) bits.push(JSON.stringify(e.name));
    if (e.type && e.role === "textbox" && e.type !== "text") bits.push(`type=${e.type}`);
    if (e.value !== undefined) bits.push(`valeur=${JSON.stringify(e.value)}`);
    if (e.checked !== undefined) bits.push(e.checked ? "coché" : "non coché");
    if (e.disabled) bits.push("désactivé");
    if (e.href) bits.push(`-> ${e.href}`);
    if (e.options?.length) bits.push(`options: ${e.options.join(" | ")}`);
    // Repère pour le modèle : ce champ ou ce bouton se règle avec set_date, pas par des clics.
    if (e.type === "date" || e.type === "datetime-local" || (/^(textbox|button|combobox)$/.test(e.role) && DATE_HINT.test(e.name))) bits.push("(date : set_date)");
    return bits.join(" ");
  });
  const offset = opts.textOffset ?? 0;
  const more = s.totalText > offset + s.text.length ? `\n[texte tronqué : ${offset + s.text.length} sur ${s.totalText} caractères, read_page pour la suite]` : "";
  const body = `Éléments (${s.elements.length}) :\n${lines.join("\n")}\n\nTexte de la page :\n${s.text}${more}`;
  return `URL : ${s.url}\nTitre : ${s.title}\n${wrapUntrusted(body, s.url)}`;
}
