import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createCard, sendCards } from "../src/cards.ts";

/** Cartes d'action : la page, et ce que fait chaque bouton. */
let app: App;
let userId: string;

beforeAll(async () => {
  app = await createApp(loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", MELLA_PUBLIC_URL: "https://mell.test", LOG_LEVEL: "silent" } as any));
  userId = (await app.db.query(`INSERT INTO users (handle, line_id) VALUES ('+33655555555', 'l1') RETURNING id`)).rows[0].id;
});
afterAll(() => app.stop());

const post = (url: string) => app.http.inject({ method: "POST", url, payload: "", headers: { "content-type": "application/x-www-form-urlencoded" } });

describe("cartes d'action", () => {
  it("la page montre le texte et les boutons, et l'aperçu iMessage", async () => {
    const c = await createCard(app.db, userId, { kind: "draft", title: "Re: dîner jeudi", subtitle: "À julie@exemple.fr", body: "Avec plaisir, jeudi 20 h ça me va.", actions: ["send_mail", "edit"] });
    const page = await app.http.inject({ method: "GET", url: `/c/${c.id}` });
    expect(page.body).toContain("Avec plaisir, jeudi 20 h");
    expect(page.body).toContain(`/c/${c.id}/act/send_mail`);
    expect(page.body).toContain("Modifier");
    expect(page.body).toContain('og:title" content="Re: dîner jeudi"');
  });

  it("« Réserver · prix » autorise la tâche sous plafond et lance le travail, une seule fois", async () => {
    const c = await createCard(app.db, userId, { title: "TONY House", subtitle: "Bondy, 18 €", url: "https://www.booking.com/hotel/fr/tony.html", priceCents: 1800, actions: ["book"] });
    expect((await post(`/c/${c.id}/act/book`)).statusCode).toBe(200);
    const t = (await app.db.query(`SELECT status, actions, spend_cap_cents FROM tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0];
    expect(t).toMatchObject({ status: "authorized", spend_cap_cents: 2070 });
    expect(t.actions).toEqual(["book", "pay", "fill_personal"]);
    expect((await app.db.query(`SELECT count(*)::int AS n FROM jobs WHERE user_id = $1`, [userId])).rows[0].n).toBe(1);
    await post(`/c/${c.id}/act/book`);
    expect((await app.db.query(`SELECT count(*)::int AS n FROM jobs WHERE user_id = $1`, [userId])).rows[0].n).toBe(1);
  });

  it("« Je prends celui-là » arrive à Mell comme un message", async () => {
    const c = await createCard(app.db, userId, { title: "Le Servan", subtitle: "20 h 30, pour 4", actions: ["choose"] });
    await post(`/c/${c.id}/act/choose`);
    const m = (await app.db.query(`SELECT text FROM messages WHERE user_id = $1 AND direction = 'in' ORDER BY id DESC LIMIT 1`, [userId])).rows[0];
    expect(m.text).toContain("[choisi sur la carte] Le Servan");
  });

  it("une option avec son site : l'aperçu iMessage lit la vignette, le toucher ouvre directement le site", async () => {
    const c = await createCard(app.db, userId, { title: "Le Petit Hôtel", subtitle: "Paris 11e, ★ 8,6", url: "https://www.booking.com/hotel/fr/petit.html", image: "https://cf.bstatic.com/x.jpg", priceCents: 3300, actions: ["book"] });
    const apple = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0";
    const preview = await app.http.inject({ method: "GET", url: `/c/${c.id}`, headers: { "user-agent": apple } });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain('og:title" content="Le Petit Hôtel"');
    expect(preview.body).toMatch(/og:description" content="33,00\s€ · Paris 11e/);
    expect(preview.body).toContain('og:site_name" content="booking.com"');
    // Quel que soit le visiteur, la vignette est servie (un aperçu qui se présente comme Safari la reçoit aussi) ;
    // le renvoi vers le site est fait par la page, en JavaScript, que les robots d'aperçu n'exécutent pas.
    const tap = await app.http.inject({ method: "GET", url: `/c/${c.id}`, headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" } });
    expect(tap.statusCode).toBe(200);
    expect(tap.body).toContain('og:title" content="Le Petit Hôtel"');
    expect(tap.body).toContain('location.replace("https://www.booking.com/hotel/fr/petit.html")');
  });

  it("un brouillon de mail garde sa page à boutons, sans renvoi", async () => {
    const c = await createCard(app.db, userId, { kind: "draft", title: "Re: café", body: "Avec plaisir.", url: "https://mail.google.com/x", actions: ["send_mail", "edit"] });
    const page = await app.http.inject({ method: "GET", url: `/c/${c.id}` });
    expect(page.body).not.toContain("location.replace");
    expect(page.body).toContain(`/c/${c.id}/act/send_mail`);
  });

  it("son 👍 sur une carte vaut le bouton : la réservation est autorisée et lancée, une seule fois", async () => {
    const { cardReactions } = await import("../src/cards.ts");
    const { isPositiveTapback } = await import("../src/reactions.ts");
    const c = await createCard(app.db, userId, { title: "Hôtel du Nord", subtitle: "Paris 10e", url: "https://www.booking.com/hotel/fr/nord.html", priceCents: 5000, actions: ["book"] });
    await app.db.query(`INSERT INTO outbox (user_id, line_id, to_handle, kind, text, ref, status, guid) VALUES ($1, 'l1', '+33655555555', 'text', 'x', $2, 'sent', 'g-nord')`, [userId, `card:${c.id}`]);
    // Une demande lancée crée un travail, ou rejoint celui déjà ouvert pour elle : on compte les deux.
    const jobs = async () =>
      (await app.db.query(
        `SELECT ((SELECT count(*) FROM jobs WHERE user_id = $1 AND request LIKE '%Hôtel du Nord%')
               + (SELECT count(*) FROM jobs, jsonb_array_elements_text(followups) f WHERE user_id = $1 AND f LIKE '%Hôtel du Nord%'))::int AS n`,
        [userId],
      )).rows[0].n;
    const pending = [{ id: 999001, tapback: "like", target_guid: "g-nord", text: null }];
    expect((await cardReactions(app.db, ({ taskAuthorizationHours: 24, models: { task: "fake" } } as any), userId, pending, isPositiveTapback)).has(999001)).toBe(true);
    expect(await jobs()).toBe(1);
    await cardReactions(app.db, ({ taskAuthorizationHours: 24, models: { task: "fake" } } as any), userId, pending, isPositiveTapback);
    expect(await jobs()).toBe(1);
  });

  it("une carte sans photo part quand même en image (aperçu généré), et la route /pv refuse une signature falsifiée", async () => {
    const c = await createCard(app.db, userId, { title: "Démarche CAF", subtitle: "à remplir", url: "https://www.caf.fr/x", actions: ["choose"] });
    await app.db.query(`UPDATE cards SET image_url = NULL WHERE id = $1`, [c.id]);
    await sendCards(app.db, userId, "https://mell.test", [c.id]);
    // La carte part en un seul message : image (aperçu) + légende avec le lien.
    const card = (await app.db.query(`SELECT image_url, text FROM outbox WHERE user_id = $1 AND kind = 'card' ORDER BY id DESC LIMIT 1`, [userId])).rows[0];
    expect(card.image_url).toMatch(/^https:\/\/mell\.test\/pv\/.+\.png$/);
    expect(card.text).toContain(`/c/${c.id}`);
    const path = card.image_url.replace("https://mell.test", "");
    const okRes = await app.http.inject({ method: "GET", url: path });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.headers["content-type"]).toBe("image/png");
    const bad = path.replace(/\.[^.]+\.png$/, ".zzzzzzzzzzzzzzzz.png");
    expect((await app.http.inject({ method: "GET", url: bad })).statusCode).toBe(403);
  });
});
