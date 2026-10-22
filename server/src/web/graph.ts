import { readFileSync } from "node:fs";
import type { Db } from "../db.ts";
import { QUOTAS } from "../invites.ts";
import { headTags } from "./da.ts";

/**
 * Le graphe des invitations (/admin/graph) : qui a fait entrer qui, ce que chaque personne a rapporté en gens
 * actifs, et le classement de ceux qui font entrer le plus. Un petit composant React (UMD, sans build) et d3 pour
 * la disposition et le zoom ; les données viennent de /admin/graph.json. ?demo=1 montre un arbre inventé.
 */

const CLIENT = readFileSync(new URL("./graph-client.js", import.meta.url), "utf8");

export async function graphData(db: Pick<Db, "query">) {
  const users = (
    await db.query(
      `SELECT u.id, u.handle, u.name, u.status, u.invited_by, u.invite_depth, u.attribution_code, u.created_at, u.admitted_at,
              coalesce(
                (SELECT r.email FROM access_requests r WHERE r.user_id = u.id AND r.email IS NOT NULL ORDER BY r.created_at DESC LIMIT 1),
                (SELECT w.email FROM web_codes w WHERE w.user_id = u.id AND w.email IS NOT NULL ORDER BY w.created_at DESC LIMIT 1),
                CASE WHEN u.handle LIKE '%@%' THEN u.handle END
              ) AS email,
              (SELECT count(*)::int FROM messages m WHERE m.user_id = u.id AND m.direction = 'in') AS msgs,
              (SELECT count(*)::int FROM messages m WHERE m.user_id = u.id AND m.direction = 'in' AND m.sent_at > now() - interval '7 days') AS msgs7,
              (SELECT max(m.sent_at) FROM messages m WHERE m.user_id = u.id AND m.direction = 'in') AS last_in,
              (SELECT count(*)::int FROM jobs j WHERE j.user_id = u.id AND j.status = 'done') AS jobs,
              i.code AS invite_code, i.uses_left, i.used
       FROM users u LEFT JOIN invites i ON i.owner_id = u.id
       ORDER BY u.created_at`,
    )
  ).rows;
  const campaigns = (await db.query(`SELECT code, label, uses_left, used FROM invites WHERE owner_id IS NULL ORDER BY used DESC, code`)).rows;
  return { quotas: QUOTAS, users, campaigns };
}

export function graphPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>Invitations</title>${headTags()}
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:15px/1.4 Satoshi,-apple-system,BlinkMacSystemFont,sans-serif}
#app{height:100vh;height:100dvh;display:flex}
.stage{flex:1;position:relative;min-width:0;overflow:hidden}
.stage svg{width:100%;height:100%;display:block;cursor:grab}.stage svg:active{cursor:grabbing}
.top{position:absolute;top:16px;left:20px;right:20px;display:flex;align-items:center;gap:14px;pointer-events:none}
.top>*{pointer-events:auto}.top a,.top button{font:600 13px/1 Satoshi,sans-serif;color:var(--fg);background:var(--card);border:1.5px solid var(--line);border-radius:999px;padding:9px 14px;text-decoration:none;cursor:pointer}
.top .sum{font-size:13px;color:var(--mut);margin-left:4px}.top .grow{flex:1}
.legend{position:absolute;left:20px;right:20px;bottom:18px;display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--mut);align-items:center;pointer-events:none}.legend span{white-space:nowrap;background:var(--bg);padding:2px 6px;border-radius:6px}
.legend i{display:inline-block;width:11px;height:11px;border-radius:50%;border:1.5px solid var(--fg);margin-right:6px;vertical-align:-1px}.legend i.on{background:var(--fg)}.legend i.sq{border-radius:2px}
.panel{width:360px;flex:none;border-left:1.5px solid var(--line);background:var(--bg);overflow:auto;padding:22px 22px 40px}
.panel h1{font-size:22px;margin:0 0 4px;letter-spacing:-.3px}.panel .mut{color:var(--mut);font-size:13px}
.panel input{width:100%;margin:18px 0 6px;min-height:44px;border:1.5px solid var(--line);border-radius:12px;background:#fff;padding:10px 12px;font:400 15px Satoshi,sans-serif;color:var(--fg)}.panel input:focus{outline:none;border-color:var(--fg)}
.panel h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:var(--mut);margin:24px 0 8px;font-weight:700}
.row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);cursor:pointer}
.row:hover .nm{text-decoration:underline}.row .nm{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row .k{font-size:12px;color:var(--mut);white-space:nowrap}
.rank{font-variant-numeric:tabular-nums;color:var(--mut);width:22px;flex:none;font-size:13px}
.card .who{font-size:24px;font-weight:700;letter-spacing:-.3px;margin:6px 0 2px;overflow-wrap:anywhere}
.card a{color:var(--fg)}.card .line{font-size:14px;color:#3a3732;margin:2px 0;overflow-wrap:anywhere}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:18px 0 4px}
.stat{border:1.5px solid var(--line);border-radius:14px;padding:12px;background:#fff}.stat b{display:block;font-size:24px;letter-spacing:-.4px;font-variant-numeric:tabular-nums}.stat span{font-size:12px;color:var(--mut)}
.stat.hi{border-color:var(--fg)}
.close{margin-top:22px;background:none;border:0;padding:0;font:600 13px Satoshi,sans-serif;color:var(--mut);cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.empty{color:var(--mut);font-size:14px;margin-top:10px}
@media (max-width:820px){.legend{font-size:11px;bottom:10px;left:12px;right:12px;gap:4px 6px}.legend span:last-child{display:none}#app{flex-direction:column}.stage{height:58vh;flex:none}.panel{width:auto;border-left:0;border-top:1.5px solid var(--line)}.top .sum{display:none}}
</style></head><body><div id="app"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
<script>${CLIENT.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}
