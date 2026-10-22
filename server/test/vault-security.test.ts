import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeSite, siteMatchesHost } from "../src/vault/refs.ts";
import { fillFromVault, type FillTarget } from "../src/vault/inject.ts";
import { MemoryVault, VaultService } from "../src/vault/index.ts";
import { PlaywrightDriver } from "../src/browser/playwright.ts";
import { chromePath, engineConfigFromEnv } from "../src/browser/engines.ts";

describe("credential destinations", () => {
  it.each(["booking", "com", "co.uk", "github.io", "127.0.0.1", "localhost", "mell.invalid", "https://user:pass@booking.com", "ftp://booking.com"])("rejects a nonregistrable or ambiguous site: %s", (site) => {
    expect(() => normalizeSite(site)).toThrow();
  });

  it("normalizes concrete hosts while preserving tenant boundaries", () => {
    expect(normalizeSite("https://www.Booking.com/sign-in")).toBe("booking.com");
    expect(normalizeSite("account.booking.com")).toBe("account.booking.com");
    expect(normalizeSite("customer.github.io")).toBe("customer.github.io");
    expect(siteMatchesHost("customer.github.io", "https://other.github.io/login")).toBe(false);
    expect(siteMatchesHost("booking.com", "https://account.booking.com/sign-in")).toBe(true);
  });

  it.each([
    ["resy", "https://resy.evil.com/login"],
    ["com", "https://evil.com/login"],
    ["co.uk", "https://evil.co.uk/login"],
    ["github.io", "https://evil.github.io/login"],
    ["booking.com", "https://booking.com.evil.com/login"],
    ["booking.com", "http://booking.com/login"],
    ["_pending", "https://_pending.com/login"],
  ])("never authorizes %s on %s", (site, url) => {
    expect(siteMatchesHost(site, url)).toBe(false);
  });

  it("keeps the internal pending slot storable but never usable", async () => {
    const memory = new MemoryVault();
    await memory.putLogin("user", "_pending", { username: "demo", password: "dummy-secret" });
    expect((await memory.getLoginForInjection("user", "_pending"))?.username).toBe("demo");
    expect(siteMatchesHost("_pending", "https://_pending.com/")).toBe(false);
  });

  it("stops before the password if the page leaves the destination after username", async () => {
    const memory = new MemoryVault();
    const vault = new VaultService(memory);
    await memory.putLogin("user", "booking.com", { username: "demo", password: "dummy-secret" });
    let url = "https://booking.com/login";
    const filled: string[] = [];
    const target: FillTarget = {
      url: async () => url,
      fill: async (role) => { filled.push(role); url = "https://evil.com/login"; },
    };
    const q = { query: async () => ({ rows: [{ present: true }] }) } as any;
    await expect(fillFromVault(q, vault, async () => target, { userId: "user", taskId: "task", ref: "vault://login/booking.com" })).rejects.toThrow();
    expect(filled).toEqual(["username"]);
  });
});

const executablePath = chromePath(engineConfigFromEnv({}).home);
describe.skipIf(!existsSync(executablePath))("credential typing in real browser documents", () => {
  let browser: any;
  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ executablePath, headless: true });
  });
  afterAll(async () => browser?.close());

  async function fixture(body: string, frameBody = '<input type="password">') {
    const context = await browser.newContext();
    await context.route("**/*", (route: any) => route.fulfill({ contentType: "text/html", body: route.request().url() === "https://booking.com/" ? body : frameBody }));
    const page = await context.newPage();
    await page.goto("https://booking.com/");
    const driver = new PlaywrightDriver("test", context, page, true);
    return { context, page, driver };
  }

  it("does not fill a password inside an unrelated iframe", async () => {
    const { context, page, driver } = await fixture('<iframe src="https://evil.com/login"></iframe>');
    try {
      expect(await (driver.fillRole as any)("password", "dummy-secret", { credentialSite: "booking.com" })).toBe(false);
      expect(await page.frames()[1].locator("input").inputValue()).toBe("");
    } finally { await context.close(); }
  });

  it("fills an authorized login iframe without sending text to a focus trap", async () => {
    const frame = '<input id="trap"><input type="password" onfocus="document.querySelector(\'#trap\').focus()">';
    const { context, page, driver } = await fixture('<iframe src="https://account.booking.com/login"></iframe>', frame);
    try {
      expect(await (driver.fillRole as any)("password", "dummy-secret", { credentialSite: "booking.com" })).toBe(true);
      expect(await page.frames()[1].locator('input[type="password"]').inputValue()).toBe("dummy-secret");
      expect(await page.frames()[1].locator("#trap").inputValue()).toBe("");
    } finally { await context.close(); }
  });

  it("refuses credential typing if the top document is outside the authorized site", async () => {
    const { context, page, driver } = await fixture('<input type="password">');
    try {
      await page.goto("https://evil.com/");
      await expect((driver.fillRole as any)("password", "dummy-secret", { credentialSite: "booking.com" })).rejects.toThrow();
      expect(await page.locator("input").inputValue()).toBe("");
    } finally { await context.close(); }
  });
});

it("HTTP request logs hide bearer paths and callback query credentials", () => {
  const code = `
    import { createApp } from './server/src/app.ts';
    import { loadConfig } from './server/src/config.ts';
    const app = await createApp(loadConfig({MELLA_LLM:'fake',MELLA_BROWSER:'0',LOG_LEVEL:'info'}));
    for (const url of ['/v/DUMMY_VAULT_TOKEN_THAT_MUST_NOT_BE_LOGGED_12345','/l/DUMMY_LIVE_TOKEN_THAT_MUST_NOT_BE_LOGGED_123456/frames','/connect/google/callback?code=DUMMY_CALLBACK_CODE&state=DUMMY_CALLBACK_STATE','/connect/gmail?t=DUMMY_APP_PASSWORD_LINK']) {
      await app.http.inject({method:'GET',url});
    }
    await app.stop();
  `;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: new URL("../../", import.meta.url), encoding: "utf8", timeout: 30_000 });
  expect(output).toContain("incoming request");
  for (const secret of ["DUMMY_VAULT_TOKEN", "DUMMY_LIVE_TOKEN", "DUMMY_CALLBACK_CODE", "DUMMY_CALLBACK_STATE", "DUMMY_APP_PASSWORD_LINK"]) expect(output).not.toContain(secret);
});
