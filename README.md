# Mell, the assistant that never makes the same mistake twice

**AI Innovate Paris, 22 October 2026. Challenge: Data-Centric Agents, idea 5: The Self-Improving Agent.**

Mell is a personal assistant you text on iMessage. No app. You ask, it books, searches, fills the forms and comes back with the result. It is live at [askmell.com](https://askmell.com).

Every agent today starts each task from zero. It hits the same cookie wall, the same broken booking widget, the same wrong train station, again and again. Mell learns: after each task it reads its own trace and writes a playbook. The next person who asks for the same kind of task gets the fast path.

## How it learns

1. **Traces.** Every message, tool call and browser step is stored in PostgreSQL (`messages`, `tool_calls`, `jobs`).
2. **Optimiser agent.** After each background task, a review run of the same model mines the trace and writes or corrects a playbook (`server/src/review.ts`). Lessons, never a diary: no transient failures, no "this tool does not work", read before write.
3. **Playbooks as context.** Shared per site or task class (`skills` table, versioned, `active / pending / stale / archived`). The browser loads the playbook of the site it lands on; the agent sees the index and reads one with `skill_view`.
4. **Learning from corrections.** When you correct Mell ("no, always in my name"), a quiet-conversation review turns it into a personal lesson that stays in its context.
5. **Curator.** Hourly lifecycle (stale after 14 days, archived after 30, never deleted) and weekly merge of duplicate playbooks (`server/src/curator.ts`). Contradicting or stale knowledge is handled, not piled up.
6. **Guardrails on what is shared.** A shared playbook containing an email, a phone, a card number or a personal detail is refused (`server/src/skills.ts`). A behaviour lesson meant for everyone is born `pending` and waits for human approval.

## Data layer, on Aiven

| Data | Where | Why |
|---|---|---|
| Conversations, traces, jobs, playbooks, lessons, memories | Aiven PostgreSQL | One source of truth the agent reads and writes every turn; full text search over the past (`history_search`) |
| The app itself | Aiven Runtime | `Dockerfile` at the root, `DATABASE_URL` injected by the PostgreSQL integration |

## Evidence (recorded benchmark runs, real websites, real browser)

Same request twice, "book Pink Mamma Saturday 8pm for 2", simulated user, stop before any payment. Full transcripts in [`evidence/`](evidence/), details in [EVIDENCE.md](EVIDENCE.md).

| | Pass 1 (no playbook) | Pass 2 (playbook learned from pass 1) |
|---|---|---|
| Time to first real options | 203 s | 134 s (-34 %) |
| Messages sent by Mell | 11 | 6 (-45 %) |
| First tool used | browser, exploring | `skill_view`, reads the playbook |

Curator benchmark: 5 of 5 criteria in 23 s (restaurant playbooks merged, site playbooks kept, "does not work" claims removed, nothing deleted). See [`evidence/RESULTATS-sonnet-1.md`](evidence/RESULTATS-sonnet-1.md).

## Run it

```bash
pnpm install
DATABASE_URL=postgres://... ANTHROPIC_API_KEY=... MELLA_MODEL=claude-sonnet-5-5 pnpm server
```

Without `DATABASE_URL` it runs on an in-process Postgres (PGlite). `pnpm sim` talks to it with a fake model.

Deploy on Aiven Runtime: create a PostgreSQL service, create an application service from this repository (`containerfile_path=Dockerfile`, port 8080), integrate PostgreSQL as `DATABASE_URL`.

## Who it is for, why now, first users

- **For** people who would rather text than open ten apps: students, founders, anyone booking, buying, planning.
- **Why now:** agents can finally browse the real web, but they do not learn. Shared learning is a network effect: every user makes Mell faster for the next one.
- **First users:** askmell.com is live, onboarding by invite code over iMessage.

## License

Source available for evaluation only, all rights reserved. No use, copy or commercial use without written permission. See [LICENSE](LICENSE).
