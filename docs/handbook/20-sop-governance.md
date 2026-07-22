# SOP-0 · Policy Governance — How Policies & This Handbook Are Maintained

> Part II · SOP Manual · Owner: Sky Pace · Last reviewed: 2026-07-22

This chapter is the policy about policies: who owns them, how a new policy is created or changed, how this handbook stays in sync with the systems it describes, and how the same content feeds the AI assistants. Everything else in the SOP manual is governed by the rules here.

## Document model — one source, three surfaces

**Policy.** Every fact lives in exactly one authoritative place; everything else links to it.

| Layer | Lives in | Audience |
|---|---|---|
| **This handbook** | `skypace/apbg-billing` → `docs/handbook/*.md`, served at [/docs/handbook/](https://apbg-billing.netlify.app/docs/handbook/) (via the gateway: [alamedapointbg.com/margin/docs/handbook/](https://alamedapointbg.com/margin/docs/handbook/)) | Staff — user guides + SOPs |
| **Customer knowledge base** | `activespacescience/brix-order` → `content/knowledge-base/*.md` + `orders.kb_documents` (managed at [/admin/knowledge](https://orders.brixbev.com/admin/knowledge)) | Customers, Mr. Bubbles, Chloe |
| **Architecture handbook** | [`Skilliosis_Mytosis_Architecture/ARCHITECTURE.md`](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md) + per-repo `CLAUDE.md` | Engineers + Claude sessions |

The handbook **summarizes and links** rather than duplicating: chapter [06](#/06-refractor-margin-control) points at the full Refractor guide, chapter [02](#/02-brix-order-portal) is the staff view of the same portal manual Bubbles serves to customers. Duplicated prose is drift waiting to happen — when you're tempted to copy, link.

## Chapter ownership & metadata

**Policy.** Every chapter has one named **owner** and a **last_reviewed** date, recorded both in the chapter's metadata line and in `docs/handbook/manifest.json`. The owner is accountable for the chapter being true; the date is the freshness contract the sweep checks against.

Each manifest entry also registers the chapter's **sources** — the repo files the chapter was written from. Registering a source means: *when this file changes, this chapter may be stale.*

## Creating or changing a policy

**Procedure.**

1. **Draft** the policy in the relevant SOP chapter. New, not-yet-approved policies are marked visibly: `> **Draft policy — proposed <date>, pending owner approval.**`
2. **Review** with the chapter owner (and Sky for anything touching money, customers, or security).
3. **Approve**: remove the draft marker, bump the chapter's `last_reviewed` date in the manifest, and note the change in the PR description.
4. **Propagate**: if the policy affects customers, update the corresponding KB article via [/admin/knowledge](https://orders.brixbev.com/admin/knowledge) (or the repo file + `kb-ingest`) so the bots and the Resources library say the same thing. If it changes architecture, update `ARCHITECTURE.md` per the standing cross-repo rule.
5. **Ship** via a normal PR to `apbg-billing` — the build copies `docs/` into the served site automatically; no extra deploy step.

**Why:** the AI assistants answer from the KB verbatim. A policy that changes in people's heads but not in the KB means Bubbles and Chloe confidently tell customers the old rule.

## Keeping the handbook fresh — the sweep

**Policy.** The handbook is checked for drift with the **Handbook Sweep** in [Master Control](#/09-master-control) — at minimum monthly, and after any large feature push.

**Procedure.**

1. Open [alamedapointbg.com/control](https://alamedapointbg.com/control) → **APBG Handbook** → **Run sweep**.
2. The sweep reads `manifest.json` and, for each chapter, asks GitHub for the last commit touching each registered source. Sources newer than the chapter's `last_reviewed` date flag the chapter **stale** (with links to the exact commits).
3. For each stale chapter, click **Copy update prompt** — it generates a ready-to-paste instruction for a Claude Code session naming the chapter file, its sources, and what changed. Paste it into a session, review the diff, merge.
4. A chapter re-verified as still accurate just gets its `last_reviewed` bumped in the manifest — no prose change needed.
5. The deeper, engineering-level drift audit remains the `/sync-arch` skill (architecture handbook vs recent commits across all repos); run it when the sweep shows broad staleness.

The sweep **finds** drift — it never edits content on its own. Judgment about what a code change means for a procedure stays with a human or a supervised Claude session.

## Feeding the assistants (internal RAG)

**Policy.** Handbook chapters may be ingested into the same RAG the bots use (`orders.kb_documents`) **only** with `customer_visible = false`, so internal procedure never leaks into the customer Resources library or customer-facing answers.

**Procedure:** save the chapter as a doc in [/admin/knowledge](https://orders.brixbev.com/admin/knowledge) with "Show in the customer Resources library" **unchecked** (admin-saved docs are managed-in-app and never overwritten by repo ingests). Anything containing spoken-code references, credential locations, or customer financial process detail stays out of the RAG entirely.

## Change log discipline

**Policy.** Per-repo `CLAUDE.md` change logs remain the engineering record of what shipped and why — every session appends there. The handbook is the *distilled* layer on top; it cites incidents ("Why" notes) but does not replay session-by-session history.

## Related

- [Start Here](#/00-start-here) — system map and handbook navigation
- [Master Control](#/09-master-control) — where the sweep runs
- [SOP-9 · Data & Engineering](#/29-sop-data-engineering) — architecture-handbook update rule, KB ingest mechanics
