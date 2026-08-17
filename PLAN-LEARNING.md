# PLAN-LEARNING — latoile learns from investigations

## Origin

Two ideas from the same thread converged into this:

1. Comments carry real signal latoile currently treats as flat text — mention-extraction
   (regex Jira-key detection) is the only structure pulled out of them. Named entities
   (people, decisions, rejected approaches) and a relevance judgment ("is this comment
   worth surfacing") are invisible.
2. latoile's stated long-term goal (user, 2026-07-23): it should *learn from every ticket
   investigated over time* — accumulate diagnostic outcomes (confirmed root causes, ruled-out
   hypotheses), not just raw Jira/GitLab facts. The PV2-18107 investigation is the concrete
   example of signal currently thrown away: two wrong static hypotheses, then a live-repro-
   confirmed root cause — none of that trail makes it back into latoile today.

The obvious mechanism for (1) — MCP **sampling**, where a server asks the connected client
to run a completion on its behalf — is a dead end for now.

## Sampling status (checked 2026-07-23)

**Claude Code does not implement the MCP sampling capability.** Confirmed via
[anthropics/claude-code#1785](https://github.com/anthropics/claude-code/issues/1785)
("Support for MCP Sampling to leverage Claude Max subscriptions and reduce API costs") —
open, unscheduled, no target version. A latoile MCP server sending
`sampling/createMessage` to a Claude Code client today gets nothing back.

**Do not design around sampling arriving on any timeline.** The two real options if latoile
itself needs an LLM call are: (a) latoile makes its own direct Anthropic API calls with its
own key — new secret, new cost center, works with any client, or (b) don't have latoile call
an LLM at all. This plan picks a third path that sidesteps the question entirely.

## Design: the agent writes back, latoile doesn't call out

latoile is (almost) never used standalone — it's driven by an agent that is *already*
reading the comments/context it returns and reasoning over them in its own turn. That
agent can extract entities and judge relevance as a normal side effect of doing the
investigation it was asked to do — no sampling, no extra API key, no extra latency at
traversal time. latoile's job is just to give that agent somewhere to **write the result
back to**, additively, so the next investigation benefits.

New MCP tool, sketch: `record_insight`
```
record_insight({
  issueKey: string,
  entities?: { name: string; role?: string }[],   // people/systems/decisions named in comments
  rootCause?: string,                              // confirmed cause, once diagnosed
  ruledOut?: string[],                             // hypotheses investigated and rejected
  relevantComments?: { commentId: string; relevance: 'high' | 'low'; why?: string }[],
})
```

Storage: additive, never overwrites/deletes raw data (same discipline as `:Issue.missing` —
see PLAN.md 2026-07-14). Sketch: an `:Insight` node per call, `RECORDED_ON` edge to the
`:Issue`, timestamped, multiple insights per issue accumulate rather than replace (an
agent's second pass can supersede without erasing the first). Exposed back out through
`get_context`/`known_context` as an optional `insights` block, so a *future* investigation
of a related issue sees what was already learned — this is the actual "learns over time"
payoff: it closes the loop from investigate → record → a later agent starts smarter.

## Non-goals / risks

- **Not automatic.** Nothing forces an agent to call `record_insight` — it's opt-in, the
  same way sink ingestion is fire-safe and additive elsewhere in latoile. Expect sparse,
  inconsistent coverage; design the read side (`insights` in context payloads) to degrade
  gracefully when absent, same discipline as `traversal`/`code` blocks.
  Quality is only as good as whatever agent chose to call it — no verification layer.
  Treat stored insights as *hints*, not ground truth (mirrors [[latoile-purpose-triage-not-verification]]).
- **No entity resolution/dedup at first.** "Bruno Parent Pichette" recorded from two
  different investigations doesn't automatically merge with the existing `:Person` identity
  work (`src/sink/person-identity.ts`) unless explicitly wired — scope that as a follow-up,
  not part of the first cut.
- **If MCP sampling ever ships in Claude Code**, this doesn't need to be thrown away —
  sampling could then *automate* extraction at ingest time as an addition, with
  `record_insight` remaining the manual/explicit path. Revisit issue #1785 periodically;
  don't block on it.

## First concrete steps (not started)

1. Add `:Insight` node + `RECORDED_ON` edge to the Neo4j schema (`src/sink/neo4j-sink.ts`),
   additive migration, no changes to existing ingest.
2. New MCP tool `record_insight` (handler in `src/mcp/handlers.ts`, wired in `server.ts`),
   unit-tested like the other write paths.
3. Surface `insights` as an optional block in `get_context`/`known_context` output —
   mirror how `traversal`/`code` were added: strictly additive, absent when nothing recorded.
4. Dogfood on the next live investigation: explicitly call `record_insight` with PV2-18107's
   actual diagnostic trail (two wrong hypotheses + confirmed root cause) as the first real
   data point, then verify a later `get_context` on a related ticket surfaces it.
