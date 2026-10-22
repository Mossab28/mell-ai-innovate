/**
 * Repris de Murmell (apps/daemon/src/bots/browser-stealth.ts, origin/main du 14/10/2026) : le profil
 * de lancement, le script d'init et le classifieur de pages bloquées de son vrai Chrome. Seul le
 * moteur « murmell-chrome » applique le profil et le script ; le classifieur sert à tous.
 */
/* eslint-disable */

export interface StealthProfile {
  readonly userAgent: string;
  readonly locale: string;
  readonly timezoneId: string;
  readonly acceptLanguage: string;
  readonly platform: string;
  readonly brands: readonly { readonly brand: string; readonly version: string }[];
  readonly fullVersion: string;
  readonly args: readonly string[];
}

/**
 * One coherent identity for the whole browser: a Linux desktop Chrome of the same major version as
 * the engine actually running, so the user agent, the client hints and the JavaScript surface all
 * tell the same story. The locale and time zone default to where Murmell's people are; a UTC clock
 * on a French-speaking browser is one of the cheaper tells.
 */
export function stealthProfile(browserVersion: string, env: NodeJS.ProcessEnv = process.env): StealthProfile {
  const major = /^\d+/.exec(browserVersion)?.[0] ?? "140";
  const fullVersion = /^\d+(?:\.\d+){3}$/.test(browserVersion) ? browserVersion : `${major}.0.0.0`;
  const locale = /^[a-z]{2}(?:-[A-Z]{2})?$/.test(env["MURMELL_BROWSER_LOCALE"] ?? "") ? env["MURMELL_BROWSER_LOCALE"]! : "fr-FR";
  const timezoneId = /^[A-Za-z_]+\/[A-Za-z_]+$/.test(env["MURMELL_BROWSER_TIMEZONE"] ?? "") ? env["MURMELL_BROWSER_TIMEZONE"]! : "Europe/Paris";
  const short = locale.split("-")[0]!;
  const acceptLanguage = short === "en" ? `${locale},en;q=0.9` : `${locale},${short};q=0.9,en-US;q=0.8,en;q=0.7`;
  return {
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    locale, timezoneId, acceptLanguage, platform: "Linux",
    brands: [{ brand: "Chromium", version: major }, { brand: "Google Chrome", version: major }, { brand: "Not=A?Brand", version: "24" }],
    fullVersion,
    args: [
      // Keeps `navigator.webdriver` false and drops the automation banner's side effects.
      "--disable-blink-features=AutomationControlled",
      `--lang=${locale}`,
      // A real desktop has a GPU; SwiftShader's name in WebGL is otherwise the giveaway.
      "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
      "--window-size=1280,800",
    ],
  };
}

/**
 * Runs before any page script. It only fills the holes a headless build leaves, never invents a
 * device: a missing `window.chrome`, a `navigator.languages` put back in tag shape (see its own
 * comment below), a permissions API that says "denied" while the prompt says "default", an outer
 * window of zero pixels, the software renderer's name in WebGL, a core count and a memory size no
 * desktop has shipped in years, and a screen sized to the window. Chrome
 * reports WebGL through ANGLE, which wraps the driver vendor, so the vendor reads
 * "Google Inc. (Intel)" and not the driver's bare name. Everything is wrapped so a page that seals
 * its globals cannot make the script throw.
 */
export const STEALTH_INIT_SCRIPT = `(() => {
  const own = (target, key, get) => { try { Object.defineProperty(target, key, { get, configurable: true }); } catch {} };
  try {
    if (!window.chrome) {
      const chrome = { app: { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" }, RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" } }, runtime: {}, csi() { return {}; }, loadTimes() { return {}; } };
      Object.defineProperty(window, "chrome", { value: chrome, writable: true, configurable: true, enumerable: true });
    }
  } catch {}
  try {
    if (window.outerWidth === 0 || window.outerHeight === 0) {
      // The chrome furniture is added back, because a window with no toolbar is a headless shape.
      // It is never added past the screen, though: a window taller or wider than the display is a
      // geometry no real machine produces, and an outer height above the screen height is one of
      // the cheaper checks there is. On a viewport that already fills the screen this lands on the
      // fullscreen window a person would get, rather than an impossible one.
      const capped = (value, ceiling) => typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling > 0 ? Math.min(value, ceiling) : value;
      const display = typeof screen === "undefined" ? undefined : screen;
      own(window, "outerWidth", () => capped(window.innerWidth, display?.width));
      own(window, "outerHeight", () => capped(window.innerHeight + 85, display?.height));
    }
  } catch {}
  try {
    // Chromium builds its client hints from the string it is handed, and it fills
    // navigator.languages by splitting that string on commas: the quality values come along, so
    // the browser announced ["fr-FR", "fr;q=0.9", "en-US;q=0.8", "en;q=0.7"]. "fr;q=0.9" is not
    // a language tag, and a list that is not a list of tags is a finding for anything that reads
    // it. The real list is rebuilt from navigator.language alone, in the same order the profile's
    // Accept-Language promises, and frozen the way Chromium's own is.
    const language = typeof navigator.language === "string" && navigator.language !== "" ? navigator.language : "en-US";
    const short = language.split("-")[0] || "en";
    const wanted = short === "en" ? [language, "en"] : [language, short, "en-US", "en"];
    const tags = [];
    for (const tag of wanted) if (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag) && !tags.includes(tag)) tags.push(tag);
    const frozen = Object.freeze(tags);
    const proto = Object.getPrototypeOf(navigator) || (typeof Navigator !== "undefined" ? Navigator.prototype : undefined);
    if (proto) own(proto, "languages", () => frozen);
  } catch {}
  try {
    // A container's honest answers are counts no desktop has shipped in years. Only the tell is
    // patched: a machine that already reports a common figure keeps its own.
    const proto = Object.getPrototypeOf(navigator) || (typeof Navigator !== "undefined" ? Navigator.prototype : undefined);
    if (proto) {
      if (typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency < 4) own(proto, "hardwareConcurrency", () => 8);
      // Desktop Chrome always answers this one; a missing answer is the hole, not a value to keep.
      if (typeof navigator.deviceMemory !== "number" || navigator.deviceMemory < 4) own(proto, "deviceMemory", () => 8);
    }
  } catch {}
  try {
    // Headless sizes the screen to the window, a panel nobody sells. The common desktop shape is a
    // windowed browser on an ordinary 1080p display, and the outer-window cap above follows it.
    const proto = typeof Screen !== "undefined" ? Screen.prototype : undefined;
    if (proto && (screen.width < 1920 || screen.height < 1080)) {
      own(proto, "width", () => 1920); own(proto, "height", () => 1080);
      own(proto, "availWidth", () => 1920); own(proto, "availHeight", () => 1040);
    }
  } catch {}
  try {
    const query = navigator.permissions && navigator.permissions.query;
    if (query) {
      const patched = function (descriptor) {
        if (descriptor && descriptor.name === "notifications" && typeof Notification !== "undefined") return Promise.resolve({ state: Notification.permission, onchange: null });
        return query.call(this, descriptor);
      };
      Object.defineProperty(patched, "toString", { value: () => "function query() { [native code] }" });
      navigator.permissions.query = patched;
    }
  } catch {}
  try {
    const patchGl = (proto) => {
      if (!proto) return;
      const getParameter = proto.getParameter;
      const patched = function (parameter) {
        if (parameter === 37445) return "Google Inc. (Intel)";
        if (parameter === 37446) return "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)";
        return getParameter.call(this, parameter);
      };
      Object.defineProperty(patched, "toString", { value: () => "function getParameter() { [native code] }" });
      proto.getParameter = patched;
    };
    patchGl(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    patchGl(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  } catch {}
})();`;

export type BlockKind = "challenge" | "captcha" | "forbidden" | "rate_limited";
export interface BlockedPage { readonly kind: BlockKind; readonly vendor: string; readonly retryAfterMs?: number }

export interface PageEvidence {
  readonly url: string;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly title: string;
  readonly text: string;
  /** The document's markup, when the caller has it. Vendors are named in script sources, not text. */
  readonly html?: string;
}

const lower = (value: string | undefined): string => (value ?? "").toLowerCase();

/**
 * A blocked page is one the site built for a robot, not for a reader. The markers are the vendors'
 * own: the widgets they inject, the titles they ship, the headers they set. A 403 alone is not
 * enough (a private document is a 403 too), and a page that merely mentions a CAPTCHA in its
 * prose must not count, so the text checks stay on short pages that say little else.
 */
export function detectBlockedPage(page: PageEvidence): BlockedPage | null {
  const title = lower(page.title).trim();
  const text = lower(page.text);
  const html = lower(page.html);
  const headers = page.headers ?? {};
  const server = lower(headers["server"]);
  const status = page.status;
  const retryAfter = Number(headers["retry-after"]);
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(3_600_000, retryAfter * 1000) : undefined;
  const short = text.length < 2_500;

  // Cloudflare: managed challenge and Turnstile, the block page, and rate limiting.
  if (lower(headers["cf-mitigated"]) === "challenge" || title === "just a moment..." || html.includes("challenges.cloudflare.com/turnstile") || html.includes("cf-chl-") || (short && text.includes("verify you are human") && text.includes("cloudflare"))) {
    return { kind: "challenge", vendor: "Cloudflare" };
  }
  if (server === "cloudflare" && (status === 403 || status === 503) && (title.startsWith("attention required") || title.includes("access denied") || text.includes("cloudflare ray id"))) {
    return { kind: "forbidden", vendor: "Cloudflare" };
  }
  if (server === "cloudflare" && status === 429) return { kind: "rate_limited", vendor: "Cloudflare", ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  // DataDome: a 403 with its own headers, or its CAPTCHA frame.
  if (headers["x-datadome"] !== undefined || headers["x-datadome-cid"] !== undefined || html.includes("captcha-delivery.com") || html.includes("geo.captcha-delivery.com")) {
    return { kind: status === 403 ? "forbidden" : "captcha", vendor: "DataDome" };
  }
  // PerimeterX / HUMAN: the press-and-hold challenge.
  if (html.includes("px-captcha") || html.includes("_pxhc") || (short && text.includes("press & hold"))) return { kind: "captcha", vendor: "PerimeterX" };
  // Akamai Bot Manager: the reference-numbered "Access Denied".
  if ((status === 403 || status === undefined) && title === "access denied" && (text.includes("reference #") || text.includes("errors.edgesuite.net") || html.includes("errors.edgesuite.net"))) return { kind: "forbidden", vendor: "Akamai" };
  // Imperva / Incapsula.
  if (html.includes("_incapsula_resource") || (short && text.includes("request unsuccessful") && text.includes("incapsula"))) return { kind: "challenge", vendor: "Imperva" };
  // Kasada answers with its own header family.
  if (Object.keys(headers).some((name) => name.toLowerCase().startsWith("x-kpsdk"))) return { kind: "challenge", vendor: "Kasada" };
  // Distil / Imperva's older interstitial.
  if (title === "pardon our interruption" || (short && text.includes("pardon our interruption"))) return { kind: "challenge", vendor: "Distil" };
  // Amazon's robot check and Google's "unusual traffic" page.
  if (short && (text.includes("robot check") || (text.includes("type the characters you see") && text.includes("amazon")))) return { kind: "captcha", vendor: "Amazon" };
  if (short && text.includes("unusual traffic from your computer network")) return { kind: "captcha", vendor: "Google" };
  // A bare CAPTCHA page: the widget is nearly all there is.
  if (short && (html.includes("hcaptcha.com/1/api.js") || html.includes("google.com/recaptcha/api.js") || html.includes("recaptcha/enterprise.js")) && text.length < 600) {
    return { kind: "captcha", vendor: html.includes("hcaptcha") ? "hCaptcha" : "reCAPTCHA" };
  }
  if (status === 429) return { kind: "rate_limited", vendor: "site", ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  // A generic 403 with a bot-shaped body. A 403 on a real document says something else.
  if (status === 403 && short && /(automated|bot|robot|unusual activity|suspicious)/.test(text) && /(access|blocked|denied|detected)/.test(text)) return { kind: "forbidden", vendor: "site" };
  return null;
}
