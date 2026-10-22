import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LINE_HEADER, SIGNATURE_HEADER, sign } from "@mella/shared";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { ChatInput, Llm, LlmReply } from "../src/llm.ts";
import { commitActionFor } from "../src/browser/guard.ts";
import { extractCode } from "../src/browser/codes.ts";
import { ProfileStore } from "../src/browser/profiles.ts";
import { assertPublicUrl, runBrowserTask } from "../src/browser/loop.ts";
import { SessionManager } from "../src/browser/index.ts";
import type { BrowserEngine, PageDriver, PageSnapshot } from "../src/browser/types.ts";

/** Une page en mémoire : un titre, deux boutons, et ce que la boucle y a fait. */
class FakePage implements PageDriver {
  readonly engine = "faux";
  clicks: string[] = [];
  typed: Array<{ ref: string; text: string; secret?: boolean }> = [];
  current = "about:blank";
  constructor(private readonly personalFilled = false) {}
  async url() {
    return this.current;
  }
  async goto(url: string) {
    this.current = url;
    return { status: 200 };
  }
  async snapshot(): Promise<PageSnapshot> {
    return {
      url: this.current,
      title: "Le Petit Resto",
      text: "Samedi 17 octobre : 19:30, 20:00, 21:15. Prix moyen 35 €.",
      totalText: 60,
      personalFilled: this.personalFilled,
      elements: [
        { ref: "e1", role: "button", name: "Tout refuser" },
        { ref: "e2", role: "button", name: "Confirmer la réservation" },
        { ref: "e3", role: "textbox", name: "Code reçu par SMS" },
      ],
    };
  }
  async click(ref: string) {
    this.clicks.push(ref);
  }
  async type(ref: string, text: string, opts?: { secret?: boolean }) {
    this.typed.push({ ref, text, secret: opts?.secret });
  }
  async select() {}
  async press() {}
  async scroll() {}
  async back() {}
  async screenshot() {
    return Buffer.alloc(0);
  }
  async fillRole() {
    return true;
  }
  async storageState() {
    return { cookies: [{ name: "sid", value: "abc", domain: ".resto.fr", path: "/" }], origins: [] };
  }
  async close() {}
}

/** Modèle scripté : rend les appels d'outils prévus, dans l'ordre, pour les étapes du navigateur. */
function scripted(steps: Array<{ name: string; args: Record<string, unknown> }>): Llm {
  let i = 0;
  return {
    async chat(input: ChatInput): Promise<LlmReply> {
      const usage = { inputTokens: 1000, outputTokens: 100 };
      if (input.purpose === "browser_plan") return { text: '{"start_url":"https://resto.fr","plan":["lire"]}', toolCalls: [], usage };
      if (input.purpose === "browser_replan") return { text: '{"decision":"stop","reason":"rien à faire"}', toolCalls: [], usage };
      const s = steps[Math.min(i++, steps.length - 1)];
      return { text: null, toolCalls: [{ id: `c${i}`, type: "function", function: { name: s.name, arguments: JSON.stringify(s.args) } }], usage };
    },
  };
}

const CFG = loadConfig({ MELLA_LLM: "fake" } as any);
const LIMITS = { maxSteps: 10, maxMs: 30_000, maxCostUsd: 1 };

describe("navigateur : garde du clic", () => {
  it("reconnaît ce qui engage, laisse passer le reste", () => {
    const at = (name: string, personalFilled = false) => commitActionFor({ name, role: "button" }, { personalFilled });
    expect(at("Payer 42,00 €")).toBe("pay");
    expect(at("Confirmer la réservation")).toBe("book");
    expect(at("Créer mon compte")).toBe("create_account");
    expect(at("Résilier mon abonnement")).toBe("cancel_subscription");
    expect(at("Réserver")).toBeUndefined();
    expect(at("Réserver", true)).toBe("book");
    expect(at("Tout refuser")).toBeUndefined();
    expect(at("Supprimer le filtre")).toBeUndefined();
    expect(at("Envoyer le code", true)).toBeUndefined();
  });

  it("n'ouvre jamais une adresse interne de l'hôte", () => {
    for (const bad of ["http://127.0.0.1:8200/v1/sys", "http://localhost:3000", "http://169.254.169.254/latest", "http://[::1]/", "http://10.0.0.5", "file:///etc/passwd", "http://intranet/"]) {
      expect(() => assertPublicUrl(bad)).toThrow();
    }
    expect(assertPublicUrl("https://www.thefork.fr/").host).toBe("www.thefork.fr");
  });
});

describe("navigateur : boucle", () => {
  it("lecture seule : le bouton qui engage est refusé, la réponse revient", async () => {
    const page = new FakePage();
    const r = await runBrowserTask(
      {
        llm: scripted([
          { name: "click", args: { ref: "e1" } },
          { name: "click", args: { ref: "e2" } },
          { name: "done", args: { answer: "Créneaux : 19:30, 20:00, 21:15" } },
        ]),
        cfg: CFG,
        page,
      },
      { objective: "créneaux samedi soir" },
      LIMITS,
    );
    expect(r.status).toBe("done");
    expect(r.answer).toContain("19:30");
    expect(page.clicks).toEqual(["e1"]);
    expect(r.errors.some((e) => e.category === "politique")).toBe(true);
    expect(page.current).toBe("https://resto.fr");
  });

  it("toute boucle a une fin : plafond d'étapes", async () => {
    const r = await runBrowserTask({ llm: scripted([{ name: "scroll", args: { direction: "down" } }]), cfg: CFG, page: new FakePage() }, { objective: "x" }, { ...LIMITS, maxSteps: 3 });
    expect(r.status).toBe("limit");
    expect(r.steps).toBe(3);
    expect(r.reason).toContain("3 étapes");
  });

  it("le code demandé dans le fil est tapé dans le champ, sans passer par le modèle", async () => {
    const page = new FakePage();
    const r = await runBrowserTask(
      {
        llm: scripted([
          { name: "ask_code", args: { ref: "e3", question: "TheFork t'a envoyé un code par SMS, tu me l'envoies ?" } },
          { name: "done", args: { answer: "connecté" } },
        ]),
        cfg: CFG,
        page,
        hooks: { askCode: async () => "645046" },
      },
      { objective: "se connecter" },
      LIMITS,
    );
    expect(r.status).toBe("done");
    expect(page.typed).toEqual([{ ref: "e3", text: "645046", secret: true }]);
  });

  it("une tâche autorisée passe par la politique pour engager", async () => {
    const page = new FakePage(true);
    const asked: string[] = [];
    const r = await runBrowserTask(
      {
        llm: scripted([
          { name: "commit", args: { ref: "e2", action: "book" } },
          { name: "done", args: { answer: "réservé" } },
        ]),
        cfg: CFG,
        page,
        hooks: { commit: async (action) => (asked.push(action), { decision: "allowed" }) },
      },
      { objective: "réserver", task: { id: "t1", scope: "Réserver Le Petit Resto (réservation)", actions: ["book"] } },
      LIMITS,
    );
    expect(r.status).toBe("done");
    expect(asked).toEqual(["book"]);
    expect(page.clicks).toEqual(["e2"]);
  });
});

describe("navigateur : profils et codes", () => {
  it("chiffre le profil par personne", () => {
    const store = new ProfileStore(Buffer.alloc(32, 7).toString("base64"));
    const sealed = store.seal("u1", { cookies: [{ name: "sid", value: "secret-cookie" }], origins: [] });
    expect(sealed).not.toContain("secret-cookie");
    expect(store.open("u1", sealed).cookies[0].value).toBe("secret-cookie");
    expect(() => store.open("u2", sealed)).toThrow();
  });

  it("reconnaît un code seul, pas une phrase", () => {
    expect(extractCode("645046")).toBe("645046");
    expect(extractCode("123 456")).toBe("123456");
    expect(extractCode("code : A7K2Q9")).toBe("A7K2Q9");
    expect(extractCode("merci")).toBeUndefined();
    expect(extractCode("on se voit à 19h30 ?")).toBeUndefined();
  });
});

describe("navigateur : de bout en bout dans le fil", () => {
  let app: App;
  const page = new FakePage();
  const engine: BrowserEngine = { name: "faux", open: async () => page, close: async () => {} };
  const ME = "+33622222222";
  let n = 0;
  const relay = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    return app.http.inject({
      method,
      url,
      payload: method === "POST" ? raw : undefined,
      headers: { "content-type": "application/json", [LINE_HEADER]: "l1", [SIGNATURE_HEADER]: sign("s1", method === "GET" ? url : raw) },
    });
  };
  const say = async (text: string) => {
    await relay("POST", "/relay/inbound", { lineId: "l1", messages: [{ guid: `b${++n}`, from: ME, sentAt: new Date().toISOString(), text }] });
    await app.tick();
  };
  const drain = async () => {
    const msgs = (await relay("GET", "/relay/outbox?wait=0")).json().messages as Array<{ id: number; text?: string; tapback?: string }>;
    await relay("POST", "/relay/ack", { lineId: "l1", results: msgs.map((m) => ({ id: m.id, ok: true })) });
    return msgs.map((m) => m.text ?? `[${m.tapback}]`);
  };

  beforeAll(async () => {
    const cfg = loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", MELLA_DEBOUNCE_MS: "0", LOG_LEVEL: "silent" } as any);
    const { openDb } = await import("../src/db.ts");
    const db = await openDb(undefined);
    const sessions = new SessionManager(db, new ProfileStore(), { engine: "patchright", home: "/nulle-part", headless: true }, undefined, async () => engine);
    app = await createApp(cfg, { db, sessions });
  });
  afterAll(() => app.stop());

  it("une recherche web part au navigateur et la réponse revient dans le fil", async () => {
    await say("Salut Mell !");
    await drain();
    await say("Regarde https://resto.fr et dis-moi comment s'appelle la page");
    await app.tick();
    const out = await drain();
    expect(out.join("\n")).toContain("Le Petit Resto");
    const run = (await app.db.query(`SELECT status, engine FROM browser_runs`)).rows[0];
    expect(run).toEqual({ status: "done", engine: "patchright" });
    const profile = (await app.db.query(`SELECT sealed FROM browser_profiles`)).rows[0];
    expect(profile.sealed).not.toContain("abc");
  });
});

describe("paiement : carte et banque", () => {
  it("lit la page après « Payer » : validé, refusé, code SMS, attente", async () => {
    const { readBankState } = await import("../src/browser/bank.ts");
    const s = (text: string, elements: PageSnapshot["elements"] = []) => ({ title: "", text, elements });
    expect(readBankState(s("Merci pour votre commande ! Commande n° A-1234"))).toBe("approved");
    expect(readBankState(s("Paiement refusé par votre banque."))).toBe("declined");
    expect(readBankState(s("Payment declined. Try another card."))).toBe("declined");
    expect(readBankState(s("Saisissez le code reçu par SMS", [{ ref: "f1e1", role: "textbox", name: "Code reçu par SMS" }]))).toBe("code");
    expect(readBankState(s("Validez le paiement dans votre application bancaire."))).toBe("pending");
  });

  it("valide la carte saisie sur la page du lien, sans jamais la renvoyer", async () => {
    const { parseCardForm } = await import("../src/vault/cards.ts");
    const now = new Date("2026-10-16T12:00:00Z");
    expect(parseCardForm({ number: "4242 4242 4242 4242", exp: "12/29", cvc: "123", holder: "Camille" }, "fr", now)).toEqual({ number: "4242424242424242", expMonth: 12, expYear: 2029, cvc: "123", holder: "Camille" });
    expect(() => parseCardForm({ number: "4242 4242 4242 4241", exp: "12/29", cvc: "123" }, "fr", now)).toThrow(/pas valide/);
    expect(() => parseCardForm({ number: "4242424242424242", exp: "09/26", cvc: "123" }, "fr", now)).toThrow(/expirée/);
    const { cardName } = await import("../src/vault/refs.ts");
    expect(cardName("5555 5555 5555 4444")).toBe("mastercard-4444");
  });
});
