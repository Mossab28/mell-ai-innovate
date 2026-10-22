import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { getUser } from "../src/users.ts";
import { issueLink } from "../src/vault/links.ts";
import { runTool } from "../src/tools.ts";

let app: App;
let owner: string;
let other: string;
beforeAll(async () => {
  app = await createApp(loadConfig({ MELLA_LLM: "fake", MELLA_SEED_LINES: "l1|+33100000000|s1", LOG_LEVEL: "silent", MELLA_PUBLIC_URL: "https://mella.test" } as any));
  owner = (await app.db.query(`INSERT INTO users (handle, line_id, lang) VALUES ('+33670000001','l1','fr') RETURNING id`)).rows[0].id;
  other = (await app.db.query(`INSERT INTO users (handle, line_id, lang) VALUES ('+33670000002','l1','fr') RETURNING id`)).rows[0].id;
});
afterAll(() => app.stop());
const taskFor = async (user: string, status = "authorized") => (await app.db.query(`INSERT INTO tasks (user_id,title,actions,status,expires_at) VALUES ($1,'Booking',ARRAY['log_in','book'],$2,now()+interval '1 hour') RETURNING id`, [user,status])).rows[0].id;

describe("vault connection workflow", () => {
  it("refuses links attached to someone else's task or a cancelled task", async () => {
    const foreign = await taskFor(other);
    const cancelled = await taskFor(owner, "cancelled");
    await expect(issueLink(app.db,"https://mella.test",{userId:owner,kind:"login",site:"booking.com",taskId:foreign})).rejects.toThrow();
    await expect(issueLink(app.db,"https://mella.test",{userId:owner,kind:"login",site:"booking.com",taskId:cancelled})).rejects.toThrow();
    expect((await app.db.query(`SELECT * FROM vault_links WHERE user_id=$1`,[owner])).rows).toHaveLength(0);
  });
  it("sends the link alone, so the thread shows its lock preview without returning the bearer to the model", async () => {
    const task = await taskFor(owner);
    const result = JSON.parse(await runTool(app.db,await getUser(app.db,owner),"vault_request_link",JSON.stringify({kind:"login",site:"https://www.booking.com/sign-in",task_id:task})));
    expect(result.link_sent).toBe(true);
    expect(JSON.stringify(result)).not.toContain("/v/");
    // Le lien part en une carte (image d'aperçu + le lien en légende), dans un seul message.
    const messages = (await app.db.query<{text:string;image_url:string|null}>(`SELECT text, image_url FROM outbox WHERE user_id=$1 AND kind='card' ORDER BY id`,[owner])).rows;
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toMatch(/^https:\/\/mella\.test\/v\/[A-Za-z0-9_-]+$/);
    expect(messages[0].image_url).toMatch(/\/pv\/.+\.png$/);
    const saved = (await app.db.query(`SELECT site, task_id FROM vault_links WHERE user_id=$1`,[owner])).rows;
    expect(saved).toEqual([{site:"booking.com",task_id:task}]);
  });
  it("does not silently drop a missing task or issue a task-bound login without a destination", async () => {
    const user = await getUser(app.db,owner);
    const task = await taskFor(owner);
    for (const args of [{kind:"login",site:"booking.com",task_id:"00000000-0000-0000-0000-000000000001"},{kind:"login",task_id:task},{kind:"unknown"}]) {
      const result = JSON.parse(await runTool(app.db,user,"vault_request_link",JSON.stringify(args)));
      expect(result.error).toBeTruthy();
      expect(result.link_sent).toBeUndefined();
    }
  });
});
