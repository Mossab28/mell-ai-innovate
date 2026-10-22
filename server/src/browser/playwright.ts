import { LISTING_FN } from "./listing.ts";
import { SNAPSHOT_FN, type RawFrameSnapshot } from "./snapshot.ts";
import { BrowserError, type FillPolicy, type FillRole, type PageDriver, type PageElement, type PageSnapshot, type StorageState } from "./types.ts";
import { siteMatchesHost } from "../vault/refs.ts";

/**
 * Pilote commun à tous les moteurs qui parlent l'API Playwright : Chrome patché (Patchright,
 * rebrowser), Chrome de Murmell (playwright-core), Camoufox (Firefox), et les navigateurs joints
 * par CDP (steel-browser, Browserless, Lightpanda). Les types restent structurels (`any`) : chaque
 * moteur vient de son propre paquet, avec sa propre version.
 */

const MASK = 'input[type=password], input[autocomplete="one-time-code"], input[autocomplete^="cc-"], [data-mella-secret]';
const MAX_FRAMES = 8;

/** Rôle du coffre -> sélecteurs du champ, du plus sûr au plus large. */
const ROLE_SELECTORS: Record<string, string[]> = {
  username: [
    'input[autocomplete="username"]',
    "input[type=email]",
    'input[name*="email" i]',
    'input[name*="user" i]',
    'input[name*="login" i]',
    'input[id*="email" i]',
    'input[id*="user" i]',
    'input[name*="identifier" i]',
  ],
  password: ['input[autocomplete="current-password"]', "input[type=password]"],
  totp: [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[name*="totp" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
    'input[inputmode="numeric"]',
  ],
  "personal:email": ['input[autocomplete="email"]', "input[type=email]", 'input[name*="mail" i]'],
  "personal:phone": ['input[autocomplete="tel"]', "input[type=tel]", 'input[name*="phone" i]', 'input[name*="tel" i]'],
  "personal:full_name": ['input[autocomplete="name"]', 'input[name="name"]', 'input[name*="fullname" i]'],
  "personal:address": ['input[autocomplete="street-address"]', 'input[autocomplete="address-line1"]', 'input[name*="address" i]', 'input[name*="adresse" i]'],
  "personal:birthdate": ['input[autocomplete="bday"]', "input[type=date]", 'input[name*="birth" i]', 'input[name*="naissance" i]'],
  // Formulaires de carte : champs du marchand ou cadres du prestataire (Stripe, Adyen, Checkout.com, PayPlug...).
  card_number: [
    'input[autocomplete="cc-number"]',
    'input[name="cardnumber"]',
    'input[name*="cardnumber" i]',
    'input[name*="card_number" i]',
    'input[name*="card-number" i]',
    'input[id*="cardnumber" i]',
    'input[id*="card-number" i]',
    'input[data-fieldtype="encryptedCardNumber"]',
    'input[data-elements-stable-field-name="cardNumber"]',
    'input[aria-label*="card number" i]',
    'input[aria-label*="numéro de carte" i]',
    'input[placeholder*="numéro de carte" i]',
    'input[placeholder*="card number" i]',
    'input[placeholder*="1234 1234" i]',
  ],
  card_exp: [
    'input[autocomplete="cc-exp"]',
    'input[name="exp-date"]',
    'input[name*="expiry" i]',
    'input[name*="expiration" i]',
    'input[id*="expiry" i]',
    'input[data-fieldtype="encryptedExpiryDate"]',
    'input[data-elements-stable-field-name="cardExpiry"]',
    'input[aria-label*="expir" i]',
    'input[aria-label*="échéance" i]',
    'input[placeholder*="MM / " i]',
    'input[placeholder*="MM/" i]',
  ],
  card_exp_month: ['select[autocomplete="cc-exp-month"]', 'input[autocomplete="cc-exp-month"]', 'select[name*="month" i]', 'input[name*="month" i]', 'select[name*="mois" i]', 'input[data-fieldtype="encryptedExpiryMonth"]'],
  card_exp_year: ['select[autocomplete="cc-exp-year"]', 'input[autocomplete="cc-exp-year"]', 'select[name*="year" i]', 'input[name*="year" i]', 'select[name*="annee" i]', 'select[name*="année" i]', 'input[data-fieldtype="encryptedExpiryYear"]'],
  card_cvc: [
    'input[autocomplete="cc-csc"]',
    'input[name="cvc"]',
    'input[name*="cvc" i]',
    'input[name*="cvv" i]',
    'input[name*="csc" i]',
    'input[name*="securitycode" i]',
    'input[name*="cryptogramme" i]',
    'input[data-fieldtype="encryptedSecurityCode"]',
    'input[data-elements-stable-field-name="cardCvc"]',
    'input[aria-label*="cvc" i]',
    'input[aria-label*="cvv" i]',
    'input[aria-label*="security code" i]',
    'input[aria-label*="cryptogramme" i]',
    'input[placeholder*="CVC" i]',
    'input[placeholder*="CVV" i]',
  ],
  card_holder: ['input[autocomplete="cc-name"]', 'input[name*="cardholder" i]', 'input[name*="holder" i]', 'input[name*="titulaire" i]', 'input[id*="cardholder" i]', 'input[data-fieldtype="holderName"]'],
};

export function categorize(e: unknown): BrowserError {
  if (e instanceof BrowserError) return e;
  const m = e instanceof Error ? e.message : String(e);
  const short = m.split("\n")[0].slice(0, 240);
  if (/Target (page, context or browser )?(has been )?closed|Browser has been closed|browser has disconnected|Connection closed|WebSocket .*closed|Session closed/i.test(m)) return new BrowserError(short, "session_perdue");
  if (/not attached to the DOM|detached|Execution context was destroyed|Cannot find context|frame was detached|stale/i.test(m)) return new BrowserError(short, "page_changee");
  if (/intercepts pointer events/i.test(m)) return new BrowserError(`un autre élément recouvre la cible (pop-up, bandeau cookies ?) : ${short}`, "cookies");
  if (/Timeout|timed out/i.test(m)) return new BrowserError(short, "delai");
  if (/net::ERR|NS_ERROR|navigation/i.test(m)) return new BrowserError(short, "navigation");
  return new BrowserError(short, "autre");
}

const NEXT_MONTH = ['button[aria-label*="mois suivant" i]', 'button[aria-label*="suivant" i]', 'button[aria-label*="next month" i]', 'button[aria-label^="next" i]', '[data-testid*="next" i]', 'button[title*="suivant" i]', 'button[title*="next" i]'].join(", ");
/** Les options d'une liste maison, une fois ouverte. */
const CHOICES = ['[role="option"]', '[role="menuitemradio"]', '[role="menuitem"]', '[role="listbox"] li', '[role="menu"] li', '[role="radiogroup"] label', '[role="dialog"] [role="radio"]'].join(", ");
const SUGGESTIONS = ['[role="option"]', '[role="listbox"] li', '[class*="suggest" i] li', '[class*="autocomplete" i] li', '[id*="suggest" i] li', '[class*="Suggest"] [role="button"]'].join(", ");
const DAYS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const DAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Les libellés qu'un calendrier met sur la case d'un jour (« lundi 19 octobre 2026 », « October 19, 2026 »...). */
export function dayLabels(date: string): string[] {
  const d = new Date(`${date}T12:00:00Z`);
  const [n, m, y, w] = [d.getUTCDate(), d.getUTCMonth(), d.getUTCFullYear(), d.getUTCDay()];
  const dd = String(n).padStart(2, "0");
  return [...new Set([
    `${DAYS_FR[w]} ${n} ${MONTHS_FR[m]} ${y}`, `${DAYS_FR[w]} ${dd} ${MONTHS_FR[m]} ${y}`, `${n} ${MONTHS_FR[m]} ${y}`, `${dd} ${MONTHS_FR[m]} ${y}`,
    `${DAYS_EN[w]}, ${MONTHS_EN[m]} ${n}, ${y}`, `${MONTHS_EN[m]} ${n}, ${y}`, `${n} ${MONTHS_EN[m]} ${y}`, `${dd}/${String(m + 1).padStart(2, "0")}/${y}`,
  ])];
}

/** Une date écrite comme l'exemple du champ : « JJ/MM/AAAA », « MM/DD/YYYY », « 2026-10-19 », « jj.mm.aa ». Par défaut JJ/MM/AAAA. */
export function dateLike(example: string, date: string): string {
  const [y, m, d] = date.split("-");
  const ex = example.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(ex) || /^(yyyy|aaaa)-/i.test(ex)) return date;
  const sep = /[./-]/.exec(ex)?.[0] ?? "/";
  const year = /(^|\W)(aa|yy)$/i.test(ex) ? y.slice(2) : y;
  return /^(mm|MM)\W*(dd|DD)/.test(ex) ? [m, d, year].join(sep) : [d, m, year].join(sep);
}

const foldText = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export class PlaywrightDriver implements PageDriver {
  private page: any;
  private refs = new Map<string, any>();
  private handles: any[] = [];

  constructor(
    readonly engine: string,
    private readonly context: any,
    page: any,
    private readonly ownsContext: boolean,
  ) {
    this.page = page;
    this.watch(page);
    // Un lien qui ouvre un onglet : on suit le nouvel onglet, comme une personne.
    context.on?.("page", (p: any) => {
      this.page = p;
      this.watch(p);
    });
  }

  private lastUrl = "about:blank";

  private watch(p: any): void {
    p.on?.("dialog", (d: any) => d.dismiss().catch(() => {}));
    p.on?.("framenavigated", (f: any) => {
      if (f === p.mainFrame?.() && /^https?:/.test(f.url())) this.lastUrl = f.url();
    });
    // Onglet qui plante (mémoire, page trop lourde) : on le marque, la prochaine action en rouvre un.
    p.on?.("crash", () => void p.close().catch(() => {}));
    p.on?.("close", () => {
      if (this.page === p) {
        const others = this.context.pages?.().filter((x: any) => x !== p && !x.isClosed?.()) ?? [];
        if (others.length) this.page = others[others.length - 1];
      }
    });
  }

  /**
   * La page a disparu (plantage, fermeture par le site) mais le navigateur est là : un onglet neuf
   * rouvre la dernière adresse, au lieu de perdre toute la tâche. Cause d'échec relevée au banc
   * sur SNCF Connect depuis PwnAI.
   */
  private async live(): Promise<any> {
    if (!this.page.isClosed?.()) return this.page;
    const others = this.context.pages?.().filter((x: any) => !x.isClosed?.()) ?? [];
    if (others.length) {
      this.page = others[others.length - 1];
      return this.page;
    }
    try {
      const p = await this.context.newPage();
      this.page = p;
      this.watch(p);
      if (/^https?:/.test(this.lastUrl)) await p.goto(this.lastUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      return p;
    } catch (e) {
      throw new BrowserError(`navigateur perdu : ${categorize(e).message}`, "session_perdue");
    }
  }

  async url(): Promise<string> {
    await this.live();
    return this.page.url();
  }

  async playwright(): Promise<unknown> {
    await this.release();
    return this.live();
  }

  async goto(url: string, timeoutMs = 30_000): Promise<{ status?: number }> {
    await this.live();
    try {
      const res = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await this.settle();
      return { status: res?.status?.() };
    } catch (e) {
      throw categorize(e);
    }
  }

  /** Laisse la page finir de se construire, sans attendre un réseau qui ne se tait jamais. */
  private async settle(ms = 2500): Promise<void> {
    await this.page.waitForLoadState?.("load", { timeout: ms }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
  }

  async snapshot(opts: { textOffset?: number; textLimit?: number } = {}): Promise<PageSnapshot> {
    await this.release();
    await this.live();
    const frames: any[] = [this.page.mainFrame()];
    for (const f of this.page.frames()) {
      if (frames.length >= MAX_FRAMES) break;
      if (f === frames[0] || f.isDetached?.()) continue;
      const u = f.url?.() ?? "";
      if (!u || u === "about:blank" || u.startsWith("javascript:")) continue;
      frames.push(f);
    }
    const elements: PageElement[] = [];
    const texts: string[] = [];
    let title = "";
    let url = this.page.url();
    let totalText = 0;
    let personalFilled = false;
    let markers = "";
    let status: number | undefined;
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      let handle: any;
      try {
        handle = await frame.evaluateHandle(`(${SNAPSHOT_FN})(${JSON.stringify({ textOffset: i === 0 ? (opts.textOffset ?? 0) : 0, textLimit: i === 0 ? (opts.textLimit ?? 6000) : 1500, maxElements: i === 0 ? 150 : 40 })})`);
      } catch (e) {
        if (i === 0) throw categorize(e);
        continue; // cadre parti entre-temps
      }
      this.handles.push(handle);
      const raw = (await handle.evaluate((v: any) => ({ ...v, nodes: undefined }))) as RawFrameSnapshot;
      const nodesHandle = await handle.getProperty("nodes");
      this.handles.push(nodesHandle);
      const props: Map<string, any> = await nodesHandle.getProperties();
      const prefix = i === 0 ? "e" : `f${i}e`;
      raw.info.forEach((info, n) => {
        const ref = `${prefix}${n + 1}`;
        const el = props.get(String(n))?.asElement?.();
        if (!el) return;
        this.refs.set(ref, el);
        this.handles.push(el);
        elements.push({ ...info, ref });
      });
      if (i === 0) {
        title = raw.title;
        url = raw.url;
        totalText = raw.totalText;
        status = raw.status;
        texts.push(raw.text);
      } else if (raw.text.trim()) {
        let host = "";
        try {
          host = new URL(raw.url).host;
        } catch {}
        texts.push(`\n--- cadre ${host} ---\n${raw.text}`);
      }
      personalFilled ||= raw.personalFilled;
      markers += ` ${raw.markers}`;
    }
    return { url, title, text: texts.join("\n"), totalText, elements, personalFilled, html: markers, status };
  }

  /** Les poignées de la lecture précédente sont libérées : une référence ne vit qu'une lecture. */
  private async release(): Promise<void> {
    const old = this.handles;
    this.handles = [];
    this.refs.clear();
    await Promise.all(old.map((h) => h.dispose?.().catch(() => {})));
  }

  private el(ref: string): any {
    const h = this.refs.get(ref);
    if (!h) throw new BrowserError(`référence ${ref} inconnue : relis la page`, "element_introuvable");
    return h;
  }

  async click(ref: string): Promise<void> {
    const h = this.el(ref);
    try {
      await h.click({ timeout: 6000 });
    } catch (e) {
      const err = categorize(e);
      // Recouvert par un bandeau ou en dehors de l'écran : un clic DOM direct, une seule fois.
      if (err.category === "cookies" || err.category === "delai") {
        try {
          await h.evaluate((n: any) => n.click());
        } catch (e2) {
          throw categorize(e2);
        }
      } else throw err;
    }
    await this.settle(2000);
  }

  async type(ref: string, text: string, opts: { submit?: boolean; secret?: boolean } = {}): Promise<void> {
    const h = this.el(ref);
    try {
      await h.click({ timeout: 5000 }).catch(() => h.focus());
      await h.fill?.("").catch(() => {});
      // Une personne tape : les sites en React écoutent les touches, et les détecteurs aussi.
      const delay = text.length <= 120 ? Math.max(20, Math.min(55, Math.floor(3500 / Math.max(1, text.length)))) : 0;
      if (delay) await this.page.keyboard.type(text, { delay });
      else await h.fill(text);
      if (opts.secret) await h.evaluate((n: any) => n.setAttribute("data-mella-secret", "")).catch(() => {});
      if (opts.submit) {
        await this.page.keyboard.press("Enter");
        await this.settle(3000);
      }
    } catch (e) {
      throw categorize(e);
    }
  }

  async setDate(ref: string, date: string, time?: string): Promise<string> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BrowserError("date attendue au format AAAA-MM-JJ", "politique");
    const h = this.el(ref);
    const info: { tag: string; type: string; example: string } = await h
      .evaluate((n: any) => ({ tag: String(n.tagName || ""), type: String(n.type || "").toLowerCase(), example: String(n.getAttribute("placeholder") || n.value || "") }))
      .catch(() => ({ tag: "", type: "", example: "" }));
    try {
      // Champ natif : la valeur ISO posée directement, comme browser-use (le sélecteur du système ne s'ouvre pas).
      if (info.tag === "INPUT" && ["date", "datetime-local", "month", "time"].includes(info.type)) {
        const v = info.type === "datetime-local" ? `${date}T${time ?? "12:00"}` : info.type === "time" ? (time ?? "12:00") : info.type === "month" ? date.slice(0, 7) : date;
        await h.evaluate((n: any, v: string) => {
          const set = Object.getOwnPropertyDescriptor(n.ownerDocument.defaultView.HTMLInputElement.prototype, "value")?.set;
          set?.call(n, v);
          n.dispatchEvent(new Event("input", { bubbles: true }));
          n.dispatchEvent(new Event("change", { bubbles: true }));
        }, v);
        await this.settle(1000);
        return `champ ${info.type} réglé, il affiche ${await h.inputValue().catch(() => v)}`;
      }
      // Champ texte : au format de son exemple (JJ/MM/AAAA en France).
      if ((info.tag === "INPUT" && !["button", "submit", "checkbox", "radio"].includes(info.type)) || info.tag === "TEXTAREA") {
        const text = dateLike(info.example, date);
        await this.type(ref, text);
        await this.settle(800);
        return `tapé ${text}, le champ affiche ${await h.inputValue().catch(() => "?")}`;
      }
      // Bouton ou case qui ouvre un calendrier : on l'ouvre, on avance de mois en mois, on clique la case du jour.
      if (!(await this.calendarDay(date).count().catch(() => 0))) await this.click(ref);
      for (let i = 0; i < 14; i++) {
        const day = this.calendarDay(date).first();
        if (await day.isVisible().catch(() => false)) {
          await day.click({ timeout: 5000 });
          await this.settle(1200);
          return `case du ${date} cliquée dans le calendrier${time ? " (l'heure se choisit ensuite)" : ""}`;
        }
        const next = this.page.locator(NEXT_MONTH).first();
        if (!(await next.isVisible().catch(() => false))) break;
        await next.click({ timeout: 5000 });
        await new Promise((r) => setTimeout(r, 450));
      }
      throw new BrowserError(`pas de case pour le ${date} dans le calendrier : relis la page`, "element_introuvable");
    } catch (e) {
      throw e instanceof BrowserError ? e : categorize(e);
    }
  }

  /** La case d'un jour : par sa date technique, sinon par son libellé lisible (fr ou en). */
  private calendarDay(date: string): any {
    const sel = [`[data-date="${date}"]`, `[data-day="${date}"]`, `[data-value="${date}"]`, `[data-iso="${date}"]`, `time[datetime="${date}"]`, ...dayLabels(date).map((l) => `[aria-label*="${l}" i]`)]
      .map((x) => `${x}:not([disabled]):not([aria-disabled="true"])`)
      .join(", ");
    return this.page.locator(sel);
  }

  async pickSuggestion(ref: string, text: string, choice?: string): Promise<{ chosen: string; others: string[] }> {
    await this.type(ref, text);
    const options = this.page.locator(SUGGESTIONS);
    let texts: string[] = [];
    for (let i = 0; i < 10 && !texts.length; i++) {
      await new Promise((r) => setTimeout(r, 400));
      texts = (await options.evaluateAll((ns: any[]) => ns.filter((n) => n.offsetParent !== null).map((n) => String(n.innerText || n.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 15)).catch(() => [])).filter(Boolean);
    }
    if (!texts.length) throw new BrowserError(`aucune suggestion après « ${text.slice(0, 40)} » : relis la page`, "element_introuvable");
    const want = foldText(choice ?? text);
    const score = (t: string) => { const f = foldText(t); return f === want ? 4 : f.startsWith(want) ? 3 : f.includes(want) ? 2 : want.split(" ").filter((w) => w && f.includes(w)).length / 10; };
    const best = texts.map((t, i) => ({ t, i, s: score(t) })).sort((a, b) => b.s - a.s || a.i - b.i)[0];
    try {
      await options.filter({ visible: true }).nth(best.i).click({ timeout: 5000 });
    } catch (e) {
      throw categorize(e);
    }
    await this.settle(1500);
    return { chosen: best.t.slice(0, 120), others: texts.filter((_, i) => i !== best.i).slice(0, 4).map((t) => t.slice(0, 80)) };
  }

  /**
   * Liste native : l'option par son libellé. Liste maison (un bouton qui ouvre des options, comme les voyageurs de SNCF
   * Connect le 22/10, où selectOption échouait en boucle) : on l'ouvre et on clique l'option visible la plus proche.
   */
  async select(ref: string, value: string): Promise<void> {
    const h = this.el(ref);
    try {
      const native = await h.evaluate((n: any) => n.tagName === "SELECT").catch(() => false);
      if (native) {
        await h.selectOption({ label: value }, { timeout: 5000 }).catch(() => h.selectOption(value, { timeout: 5000 }));
        await this.settle(1500);
        return;
      }
      await h.click({ timeout: 5000 });
      const options = this.page.locator(CHOICES);
      let texts: string[] = [];
      // Les index suivent les options visibles, vides comprises : c'est sur elles que se fait le clic.
      for (let i = 0; i < 6 && !texts.some(Boolean); i++) {
        await new Promise((r) => setTimeout(r, 300));
        texts = await options.evaluateAll((ns: any[]) => ns.filter((n) => n.offsetParent !== null).map((n) => String(n.innerText || n.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 30)).catch(() => []);
      }
      const want = foldText(value);
      const seen = texts.map((t, i) => ({ t, i, f: foldText(t) })).filter((o) => o.f);
      const best = seen.find((o) => o.f === want) ?? seen.find((o) => o.f.includes(want) || want.includes(o.f));
      if (!best) throw new BrowserError(`liste ouverte, pas d'option « ${value.slice(0, 40)} »${seen.length ? ` (options : ${seen.slice(0, 8).map((o) => o.t).join(" / ").slice(0, 300)})` : ""} : clique l'option voulue`, "element_introuvable");
      await options.filter({ visible: true }).nth(best.i).click({ timeout: 5000 });
      await this.settle(1500);
    } catch (e) {
      throw e instanceof BrowserError ? e : categorize(e);
    }
  }

  async press(key: string): Promise<void> {
    try {
      await this.page.keyboard.press(key);
      await this.settle(1500);
    } catch (e) {
      throw categorize(e);
    }
  }

  async scroll(direction: "down" | "up"): Promise<void> {
    try {
      const h = (await this.page.evaluate("window.innerHeight").catch(() => 800)) as number;
      await this.page.mouse.wheel(0, (direction === "down" ? 1 : -1) * Math.round(h * 0.85));
      await new Promise((r) => setTimeout(r, 700));
    } catch (e) {
      throw categorize(e);
    }
  }

  /**
   * Retour arrière. Un lien ouvert dans un nouvel onglet n'a pas d'historique : comme une
   * personne, on ferme l'onglet et on revient au précédent. Sans page précédente, on le dit.
   */
  async back(): Promise<void> {
    try {
      const before = this.page.url();
      const r = await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
      if (!r && this.page.url() === before) {
        const pages: any[] = this.context.pages?.() ?? [];
        const others = pages.filter((p) => p !== this.page);
        if (!others.length) throw new BrowserError("pas de page précédente : utilise goto", "navigation");
        const current = this.page;
        this.page = others[others.length - 1];
        await current.close().catch(() => {});
        await this.page.bringToFront?.().catch(() => {});
      }
      await this.settle();
    } catch (e) {
      throw categorize(e);
    }
  }

  async screenshot(): Promise<Buffer> {
    try {
      return await this.page.screenshot({ type: "jpeg", quality: 60, timeout: 10_000, mask: [this.page.locator(MASK)], maskColor: "#202020" });
    } catch (e) {
      throw new BrowserError(`capture impossible : ${categorize(e).message}`, "capture");
    }
  }

  async listing(): Promise<Array<{ index: number; title: string; price?: string; text: string; url?: string; image?: string }>> {
    await this.live();
    try {
      return (await this.page.evaluate(LISTING_FN)) ?? [];
    } catch {
      return [];
    }
  }

  async cardOf(ref: string): Promise<{ href?: string; image?: string }> {
    const h = this.el(ref);
    try {
      return await h.evaluate((n: any) => {
        // Pas de fonction nommée ici : sous tsx, elle devient __name(...), inconnu dans la page, et tout l'appel échouait
        // (cartes sans lien ni photo).
        // Le lien de l'option : le sien, sinon celui du plus petit bloc qui n'en contient qu'un, sinon la page où elle est.
        let link = n.closest?.("a[href]") || n.querySelector?.("a[href]");
        for (let b = n.parentElement, i = 0; !link && b && i < 4; b = b.parentElement, i++) {
          const all = [...new Set([...b.querySelectorAll("a[href]")].map((a: any) => a.getAttribute("href")))];
          if (all.length === 1) link = b.querySelector("a[href]");
          if (all.length > 1) break;
        }
        // La photo : la première image du plus petit bloc qui entoure l'option.
        let box = n;
        let img: any = null;
        for (let i = 0; i < 7 && box && !img; i++) {
          img = box.tagName === "IMG" ? box : box.querySelector?.("img");
          box = box.parentElement;
        }
        const src = img ? img.currentSrc || img.getAttribute("src") || img.getAttribute("data-src") : null;
        const [href, image] = [link ? link.getAttribute("href") : location.href, src].map((u: string | null) => {
          if (!u) return undefined;
          try {
            const x = new URL(u, location.href);
            return /^https?:$/.test(x.protocol) ? x.href : undefined;
          } catch {
            return undefined;
          }
        });
        return { href, image };
      });
    } catch {
      return {};
    }
  }

  async fillRole(role: FillRole, value: string, policy: FillPolicy = {}): Promise<boolean> {
    const credential = role === "username" || role === "password" || role === "totp";
    const page = await this.live();
    const site = policy.credentialSite;
    if (credential && (!site || !siteMatchesHost(site, page.url()))) throw new BrowserError("la page n'est pas sur le site autorisé pour cet identifiant", "politique");
    const selectors = ROLE_SELECTORS[role] ?? [`input[autocomplete="${role.slice("personal:".length)}"]`];
    for (const frame of page.frames().slice(0, MAX_FRAMES)) {
      if (credential && !siteMatchesHost(site!, frame.url())) continue;
      for (const sel of selectors) {
        const loc = frame.locator(`${sel}:visible`).first();
        if (!(await loc.count().catch(() => 0))) continue;
        try {
          if (credential) {
            if (this.page !== page || !siteMatchesHost(site!, page.url())) throw new BrowserError("la page a quitté le site autorisé", "politique");
            // Contrôle et écriture dans le même document, sans clavier global ni course au focus.
            const filled = await loc.evaluate((n: any, p: { site: string; value: string }) => {
              const win = n.ownerDocument.defaultView;
              if (!win || !n.isConnected || n.disabled || n.readOnly) return false;
              const url = new URL(win.location.href);
              const host = url.hostname.toLowerCase().replace(/\.$/, "");
              if (url.protocol !== "https:" || url.username || url.password || !(host === p.site || host.endsWith(`.${p.site}`))) return false;
              const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
              if (!setter || !(n instanceof win.HTMLInputElement)) return false;
              n.setAttribute("data-mella-secret", "");
              setter.call(n, p.value);
              n.dispatchEvent(new win.Event("input", { bubbles: true }));
              n.dispatchEvent(new win.Event("change", { bubbles: true }));
              return true;
            }, { site: site!, value });
            if (filled) return true;
            continue;
          }
          // Liste déroulante (mois, année d'une carte) : on choisit l'option, sous ses écritures courantes.
          if ((await loc.evaluate((n: any) => n.tagName).catch(() => "")) === "SELECT") {
            const v = value.replace(/^0/, "");
            const variants = [value, v, value.padStart(2, "0"), value.slice(-2), v.length === 4 ? v.slice(-2) : `20${v}`];
            for (const opt of [...new Set(variants)]) {
              if (await loc.selectOption(opt, { timeout: 2000 }).then(() => true).catch(() => false)) {
                await loc.evaluate((n: any) => n.setAttribute("data-mella-secret", ""));
                return true;
              }
            }
            continue;
          }
          await loc.click({ timeout: 4000 }).catch(() => loc.focus());
          await loc.fill("");
          await this.page.keyboard.type(value, { delay: value.length <= 64 ? 35 : 0 });
          // Le champ rempli depuis le coffre est masqué sur toute capture, et sa valeur jamais relue.
          await loc.evaluate((n: any) => n.setAttribute("data-mella-secret", ""));
          return true;
        } catch (e) {
          if (e instanceof BrowserError && e.category === "politique") throw e;
          continue;
        }
      }
    }
    return false;
  }

  async storageState(): Promise<StorageState> {
    try {
      return await this.context.storageState();
    } catch (e) {
      throw categorize(e);
    }
  }

  async close(): Promise<void> {
    await this.release().catch(() => {});
    if (this.ownsContext) await this.context.close().catch(() => {});
    else await this.page.close().catch(() => {});
  }
}
