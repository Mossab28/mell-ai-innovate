# Evidence it works

**Improvement target:** how fast and how cleanly Mell completes a web task it has already seen once.
**Baseline:** the same agent, same model (Claude Sonnet), same code. The only difference between the two passes is the data Mell learned from the first one.

## Method

- Real websites, real cloud browser (AWS AgentCore), stopped before anything that commits money.
- A simulated user who writes like a real one (short, casual, "go").
- **Pass 1:** empty playbook library.
- After pass 1, the optimiser agent reads the trace and writes playbooks into Postgres.
- **Pass 2:** same request, new user, the learned playbooks available.
- Results are **recorded runs** from 19 October 2026 (`results-apprentissage-2.jsonl`). The iPhone demo on stage is a **live run** on production.

## Result 1: restaurant booking ("book Pink Mamma Saturday 8pm for 2")

| | Pass 1, no playbook | Pass 2, learned playbook | Change |
|---|---|---|---|
| First action | searches TheFork (blocked by anti-bot) | **reads the playbook** (`skill_view`) | right path first |
| Time to first real options | 203 s | 134 s | **-34 %** |
| Tool calls | 21 | 6 | **-71 %** |
| Messages sent by Mell | 11 | 6 | **-45 %** |
| Total run time | 660 s | 153 s | -77 % (*) |

(*) Not a pure comparison: in pass 1 the user asked for another evening, which triggered a second search. Time to first options is the fair metric.

**What the optimiser wrote after pass 1:** two playbooks.
- "Book a restaurant" (task type): try TheFork first; if it is blocked, open the restaurant's own booking widget; do not keep retrying a blocked site.
- "SevenRooms" (site): open the widget from the restaurant's site or Google Maps, then show all time slots.

## Result 2: cheap hotel near Gare de Lyon (honest limit)

| | Pass 1 | Pass 2 | Change |
|---|---|---|---|
| First action | Booking search | reads the playbook | |
| Total time | 473 s | 476 s | no gain |
| Tool calls | 33 | 26 | -21 % |
| Messages | 9 | 10 | +1 |
| Contradictions | yes (self-corrected on location) | none | better |

Learning removed the contradictions but not the time: Booking.com asks for more personal details than the vault had, in both passes.

## Result 3: the curator (stale and conflicting knowledge)

A library seeded with duplicate and wrong playbooks, curated by the same model:
**5 of 5 criteria in 23 s.** Restaurant playbooks merged into one, site playbooks kept, "this tool does not work" claims removed, nothing deleted (archived only).

## Why the data is the product

The improvement lives in the data, not in the model: playbooks, lessons and traces sit in Postgres. Switch to another model and the learning carries over. Every user who hits a new website makes Mell faster for the next one.

Raw transcripts of every run: `evidence/learning-bench-restaurant-hotel.md` and `evidence/RESULTATS-sonnet-1.md` in https://github.com/Mossab28/mell-ai-innovate
