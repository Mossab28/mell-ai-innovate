import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LINE_HEADER, SIGNATURE_HEADER, sign } from "@mella/shared";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

/** Accès sur invitation : liste d'attente sans code, entrée avec un code, admission par l'admin. */
let app: App;
let n = 0;

async function relay(method: "GET" | "POST", url: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  return app.http.inject({ method, url, payload: method === "POST" ? raw : undefined, headers: { "content-type": "application/json", [LINE_HEADER]: "l1", [SIGNATURE_HEADER]: sign("s1", method === "GET" ? url : raw) } });
}
async function say(from: string, text: string) {
  await relay("POST", "/relay/inbound", { lineId: "l1", messages: [{ guid: `i${++n}`, from, sentAt: new Date().toISOString(), text }] });
  await app.tick();
}
async function drain(): Promise<Array<{ to: string; text?: string }>> {
  const msgs = (await relay("GET", "/relay/outbox?wait=0")).json().messages as Array<{ id: number; to: string; text?: string }>;
  await relay("POST", "/relay/ack", { lineId: "l1", results: msgs.map((m) => ({ id: m.id, ok: true })) });
  return msgs;
}
const admin = (url: string, payload: unknown) => app.http.inject({ method: "POST", url, payload: JSON.stringify(payload), headers: { "content-type": "application/json", authorization: "Bearer adm" } });

beforeAll(async () => {
  app = await createApp(loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", MELLA_DEBOUNCE_MS: "0", MELLA_ADMIN_TOKEN: "adm", MELLA_INVITE_ONLY: "1", MELLA_PUBLIC_URL: "https://mell.test", LOG_LEVEL: "silent" } as any));
});
afterAll(() => app.stop());

describe("invitations", () => {
  it("sans code : sur la liste, une seule relance par jour, aucun modèle", async () => {
    await say("+33622222222", "Salut Mell !");
    expect((await drain()).map((m) => m.text)).toEqual(["Tu es sur la liste ! 🎉", "Les places sont comptées pour l'instant. Je t'écris ici dès que c'est ton tour."]);
    await say("+33622222222", "alors ?");
    await say("+33622222222", "allo");
    expect((await drain()).map((m) => m.text)).toEqual(["Toujours sur la liste, je t'écris dès que c'est ton tour."]);
  });

  it("un code de créateur fait entrer, jusqu'à épuisement", async () => {
    const r = (await admin("/admin/invites", { uses: 1, label: "créatrice test", code: "lea1" })).json();
    expect(r.link).toBe("https://mell.test/i/lea1");
    await say("+33633333333", "Salut Mell ! (lea1)");
    expect(String((await drain())[0].text).toLowerCase()).toContain("tu es dedans");
    await say("+33644444444", "Salut Mell ! (lea1)");
    expect((await drain())[0].text).toContain("sur la liste");
  });

  it("l'admin fait entrer la liste dans l'ordre, et Mell écrit aussitôt", async () => {
    const r = (await admin("/admin/admit", { count: 1 })).json();
    expect(r).toEqual({ admitted: 1, waiting: 1 });
    const out = await drain();
    expect(out[0]).toMatchObject({ to: "+33622222222", text: "Tu es dedans ! 🎉" });
  });

  it("la page du lien ouvre Messages avec le code", async () => {
    await admin("/admin/invites", { uses: 3, code: "zz99" });
    const res = await app.http.inject({ method: "GET", url: "/i/zz99", headers: { "accept-language": "fr-FR" } });
    expect(res.body).toContain('href="/access?i=zz99"'); // le compte, c'est le numéro : la boucle mène à la demande d'accès avec le code
  });
});
