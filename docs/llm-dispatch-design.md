# LLM Dispatch Redesign — Design Doc & Algorithm Spec

Status: **proposal / spec only.** No code changes implied by this document.
Scope: replace the static role→host LLM router with a load-aware, model-centric
pool that spreads work across multiple self-hosted Ollama machines.

Environment assumption: **everything is self-hosted Ollama. No cloud calls, ever.**

---

## 1. Current state (what we have)

Dispatch today is **role-pinned, one host per role**:

- `LlmRouter.chat(role, …)` where `role ∈ {"heavy","light","images","embeddings"}`
  — `src/server/llm.ts:23`.
- `OpenAICompatRouter` constructs exactly three `OpenAICompatClient`s, each frozen
  to one `{base_url, model, api_key}` — `src/server/llm.ts:380,393`.
- `client(role)` is a static switch; no load awareness, no fallback —
  `src/server/llm.ts:400`.
- Config: one TOML table per role, each → one machine — `config/llm.toml`:
  - `heavy → gemma4 @ madison-sylveon`
  - `light → gemma3:4b-it-qat @ cat-desktop`
  - `images → gemma3:4b-it-qat @ cat-desktop`
  - `embeddings → nomic-embed @ madison-sylveon`
- Nodes call `deps.llm.chat("heavy"|"light", …)`; prompts declare `model="heavy"`
  — e.g. `config/prompts/infobox.toml`, parsed at `config/config.ts:36`.

**Consequence:** the only routing knob is `role`, mapped 1:1 to a physical host.
The graph runtime already supports concurrency (`parallel:` in
`src/server/pipeline/runtime/graph.ts:43`), and postProcess uses it for
summary+infobox (`src/server/pipeline/workflows/postProcess.ts:91`). But the
concurrency is **hand-tuned around physical hosts** — see the comment at
`graph.ts:48`: *"use different model tiers so they don't contend on the same LLM
pool."* `see_also` and `sidebar_caption` are forced serial because they'd collide
on cat-desktop. There is no scheduler, so contention is avoided manually.

## 2. Goals

1. A model can live on **N hosts**; requests for it **load-balance** across them.
2. Hosts are **heterogeneous** — same machine model, different model sets; or same
   models on different machines.
3. **Weights** per model (cost/heaviness) and per host (capacity).
4. **RAM/VRAM awareness** — don't schedule a model onto a host that can't hold it
   alongside what's already resident.
5. **Dynamic host availability** — hosts come and go; the pool adapts.
6. **Hot-model affinity** — avoid forcing an Ollama VRAM swap on a busy host.
7. **No interface churn** — nodes and prompts must not have to change.

## 3. Library evaluation (self-hosted lens)

The user's constraint: only adopt a dependency if it is *extremely* well-supported
(slop-squatting is real), otherwise hand-roll. Because the deployment is
**100% self-hosted Ollama with no cloud**, the usual reason to pull in a big
gateway (unify many cloud providers behind one key) **does not apply** — we'd be
adopting it purely for load balancing.

| Option | Status | Fit | Verdict |
|---|---|---|---|
| **LiteLLM Proxy/Router** | Very well-supported (Python). `routing_strategy: least-busy / latency-based / weighted`, fallbacks, health checks. Self-hostable as a local process. | Generic LB across "deployments" of the same model name. **Not** Ollama-VRAM-aware; no hot-model affinity; no `/api/ps` notion. Python sidecar process. | Real option, but it's a separate service in another language that solves the *generic* half and ignores the *local-specific* half (RAM/affinity) that gives the biggest wins here. |
| **Portkey AI Gateway** | Well-supported, TypeScript, self-hostable. Weighted load-balance, fallback, retries via config. | Same shape as LiteLLM: generic LB, provider-agnostic, not VRAM/affinity-aware. Runs as a gateway process. | Same trade-off as LiteLLM, closer to our language. Still an extra process for the generic half only. |
| **nginx / Caddy `least_conn`** | Battle-tested, zero code. | Balances by **connection/URL**, not by model name in the JSON body. Works only for a set of **identical** hosts (same models). Cannot route "model X → only hosts that have X" without OpenResty/Lua. | Great for the *homogeneous-replica* subset; can't express our heterogeneous map. |
| **In-process npm LB libs** | None dominant/reputable for model-aware Ollama dispatch. | — | **Avoid** — this is exactly the slop-squatting zone. |
| **Thin in-process `LlmPool`** | We own it (~300–400 LoC, zero deps). | Implements the existing `LlmRouter` interface; full control over affinity + `/api/ps` RAM logic. | **Recommended.** The valuable logic (hot-model affinity, VRAM pressure, queueing) is bespoke to Ollama and small; the generic LB part is also small. |

**Recommendation:** hand-roll a thin in-process `LlmPool` with **no new
dependency**. Rationale:

- The differentiating logic you actually asked for — *RAM awareness*, *"these two
  hosts share a model, dispatch dynamically"*, *hot-model affinity* — is precisely
  what the off-the-shelf gateways don't do, because they're cloud-provider routers,
  not local-GPU schedulers.
- The generic part they *do* do (least-busy, weighted, fallback) is ~50 lines.
- Adopting LiteLLM/Portkey means running and supervising a second process in the
  request path for a feature we'd still have to extend. Net negative for a
  self-hosted, Ollama-only setup.
- Escape hatch preserved: because `LlmPool` implements `LlmRouter`, if we ever
  *do* want LiteLLM/Portkey, we point one host entry's `base_url` at it and let it
  fan out further. They compose; they're not mutually exclusive.

(If you decide the in-process scheduler isn't worth maintaining: the boring
fallback is **nginx `least_conn` in front of each group of identical hosts**, and
keep today's role map pointing at those nginx VIPs. Zero code, but you lose
heterogeneous routing, affinity, and RAM awareness.)

## 4. Config schema (hybrid discovery)

Hosts and models become first-class. Roles point at **model names**, not hosts.
TOML declares hosts + overrides; the pool **auto-discovers** the rest from Ollama
at startup and on an interval, falling back to TOML when a host is unreachable.

```toml
# --- hosts: physical machines ---
[[llm.host]]
name = "madison-sylveon"
base_url = "http://madison-sylveon:11434/v1"
api_key = "ollama"
max_concurrency = 2        # in-flight requests before queueing (override)
vram_mb = 24000            # optional; discovered via /api/ps if omitted

[[llm.host]]
name = "cat-desktop"
base_url = "http://cat-desktop:11434/v1"
api_key = "ollama"
max_concurrency = 1

# --- models: logical, may live on many hosts ---
[llm.model.gemma4]
weight = 10                # heaviness / preference cost
est_vram_mb = 18000        # optional override; else discovered
# hosts = [...]            # optional pin; else discovered from /api/tags

[llm.model."gemma3:4b-it-qat"]
weight = 3
est_vram_mb = 4000

[llm.model."nomic-embed-text-v2-moe:latest"]
weight = 1

# --- roles: map the tier names the code already uses to model names ---
[llm.role]
heavy = "gemma4"
light = "gemma3:4b-it-qat"
images = "gemma3:4b-it-qat"
embeddings = "nomic-embed-text-v2-moe:latest"
```

Discovery precedence for every field: **explicit TOML > live Ollama discovery >
built-in default**. A host absent from discovery (down at boot) is still usable
from its TOML declaration; a host present in discovery but not TOML can be
ignored or auto-added (config flag).

### Backward-compat shim
`config/config.ts:withLlmDefaults` keeps accepting the legacy `[llm.chat]` /
`[llm.light]` / `[llm.images]` / `[llm.embeddings]` tables and synthesizes one
host + one model + one role each. So the new schema is opt-in; existing configs
keep working unchanged.

## 5. `LlmPool` architecture

`LlmPool implements LlmRouter` (`src/server/llm.ts:23`) — **identical signatures**,
so `src/server/index.ts:862` and `:1117` are the only construction sites that
change, and **no node or prompt changes**.

Internal pieces:

- **HostClient** — today's `OpenAICompatClient`, but `model` is passed per-call
  instead of fixed at construction (small refactor: thread `model` through
  `chat`/`streamChat`/`embed`).
- **Registry** — `model → Host[]` (who serves it) and `Host → {inflight,
  max_concurrency, residentModels, vramFreeMb, healthy, lastModel}`.
- **Semaphore per host** — caps `inflight` at `max_concurrency`; requests await a
  slot. A `streamChat` holds its slot for the whole generation.
- **Discoverer** — periodic poll of each host's `/api/tags` (capability) and
  `/api/ps` (resident models + live VRAM). Updates the registry; flips
  `healthy`.
- **Selector** — `select(model) → Host` per the algorithm in §6.

`ChatOptions` (`src/server/llm.ts:12`) gains an optional `model?: string` so a
node/prompt can pin a concrete model, not just a tier. Role resolution becomes:
`options.model ?? roleTable[role]`. Prompt loader (`config/config.ts:36`) can
likewise accept a literal model name alongside `"heavy"|"light"`.

## 6. Selection algorithm (spec)

`select(model)` — **weighted least-connections with hot-model affinity and VRAM
admission**:

```
select(model):
  candidates = hosts where healthy AND serves(host, model)
  if candidates empty:
     # discovery may be stale or model truly absent
     fallback = hosts from TOML model.hosts pin, else error "no host for model"
     candidates = fallback ∩ healthy
     if still empty: throw NoHostAvailable(model)

  # 1. AFFINITY: prefer hosts where `model` is already resident/hot.
  #    Avoids an Ollama VRAM swap (the dominant local cost).
  hot = candidates where model ∈ host.residentModels
  pool = nonEmpty(hot) ? hot : candidates

  # 2. VRAM ADMISSION: drop hosts that can't hold the model right now,
  #    unless it's already resident there (resident => already fits).
  admit = pool where (model ∈ host.residentModels)
                  OR (host.vramFreeMb >= model.est_vram_mb)
  pool = nonEmpty(admit) ? admit : pool   # if none "fit", fall back & let it swap

  # 3. LEAST-CONNECTIONS, normalized by capacity.
  #    load = inflight / max_concurrency  (0 = idle, 1 = full)
  best = argmin over pool of host.inflight / host.max_concurrency

  # 4. TIE-BREAK: more headroom wins, then higher host capacity,
  #    then lower model.weight bias toward bigger machines for heavy models.
  ties = pool where load == best.load
  return argmax over ties of (host.vramFreeMb, host.max_concurrency)
```

Acquire/release:

```
dispatch(model, fn):
  host = select(model)
  await host.semaphore.acquire()       # queues if all slots busy
  host.inflight += 1
  try:    return await fn(host, model)  # chat / streamChat / embed
  finally: host.inflight -= 1; host.semaphore.release()
          host.lastModel = model
```

Notes:
- **Queueing over overload**: if every candidate host is full, the request awaits
  a slot rather than piling a 3rd concurrent generation onto a 1-slot desktop.
- **Affinity vs. balance**: affinity (step 1) is deliberately *before* least-conn
  so we don't thrash VRAM just to even out counts. Tunable: a host whose
  `load == 1.0` is skipped even if hot, falling through to step-1 `pool` =
  all candidates.
- **Embeddings** reuse the same path with `role="embeddings"` → its model.

## 7. Discovery details (Ollama-specific, hybrid mode)

- **`GET /api/tags`** — list of models a host *can* serve → builds `model → hosts`.
  Run at startup and every `discovery_interval_s` (default 30s). A host that
  starts answering is added; one that stops is marked `unhealthy` after
  `health_fail_threshold` consecutive failures.
- **`GET /api/ps`** — models currently *loaded* + their VRAM size + expiry →
  populates `residentModels` and `vramFreeMb` (total VRAM − Σ resident). Drives
  affinity (step 1) and admission (step 2).
- We already hit the sibling **`POST /api/show`** for vision probing
  (`src/server/llm.ts:347`), so the base-URL→Ollama-native derivation
  (strip `/v1`) is established and reused.
- All discovery is best-effort: any endpoint failing just leaves that field on its
  TOML/default value. Discovery never blocks request dispatch.

## 8. Health & failover

- Per-host rolling health from discovery polls + real request outcomes. N
  consecutive failures → `unhealthy` → removed from `candidates`. A later
  successful poll → restored.
- A request that fails mid-flight (host died) **retries `select()` once** on the
  remaining candidates before surfacing the error — bounded, no infinite loop.
- If `select` finds zero candidates, throw a typed `NoHostAvailable` so nodes can
  fall back exactly as they do today (e.g. summary fallback at
  `postProcess.ts:308`, infobox returns `undefined` at `:454`).

## 9. Integration / migration seams

1. Add types: `HostConfig`, `ModelConfig`, `RoleMap` in `src/server/types.ts`
   (next to `ChatConfig` at `:220`); extend `LlmConfig` (`:235`).
2. Extend `withLlmDefaults` (`config/config.ts:128`) to parse the new tables
   **and** synthesize them from legacy tables (backward-compat shim, §4).
3. Refactor `OpenAICompatClient` to take `model` per-call (`src/server/llm.ts:96`).
4. Add `LlmPool implements LlmRouter` in `src/server/llm.ts`.
5. Swap the two construction sites (`src/server/index.ts:862`, `:1117`) to build
   `LlmPool` when the new `[[llm.host]]` schema is present, else keep
   `OpenAICompatRouter`.
6. (Optional) add `model?: string` to `ChatOptions` (`llm.ts:12`) and accept a
   literal model in the prompt loader (`config/config.ts:36`).

Nodes, prompts, the graph runtime, and the trace UI are **untouched**.

## 10. Payoff for the post-process flow

Once the pool manages contention, the graph's `parallel:` stops being hand-tuned:

- Fan out `regenerate_summary` + `generate_infobox` + `generate_see_also`
  **concurrently** (`postProcess.ts:91` group expands) and let the pool spread them
  across madison + cat-desktop, queueing overflow. Wall time → the single longest
  call instead of the serial sum (~13s today).
- The `graph.ts:48` warning ("use different model tiers so they don't contend")
  becomes obsolete — the semaphore *is* the contention manager.

Orthogonal infobox-content wins (still worth doing; not blocked on the pool):

- The infobox node feeds the **full body** on purpose (`postProcess.ts:427` "mine
  every fact") → that's the 12kc / ~7s. Reframe `config/prompts/infobox.toml` as
  **extraction** ("pull these fields; null if not stated; do not infer") with
  type-aware field caps, then it can run on the small replicated model
  (`gemma3:4b`) instead of `gemma4` — grounded, faster, and now safely parallel.
- **Skip-when-unchanged**: post-process regenerates the infobox every run; diff the
  source body and reuse the persisted infobox (`postProcess.ts:466`) when facts
  didn't move.

## 11. Open questions / phasing

- **Phase 1**: schema + shim + `LlmPool` with least-conn + health (no VRAM/affinity
  yet — treat every candidate as admissible). Pure throughput win, low risk.
- **Phase 2**: add `/api/ps` discovery → affinity + VRAM admission.
- **Phase 3**: expand the post-process parallel group + infobox prompt rework.
- Decide: auto-add discovered-but-undeclared hosts, or require TOML declaration?
  (Proposed default: discovery enriches declared hosts only; log unknown hosts.)
- Decide: per-host vs per-host-per-model concurrency caps. (Proposed: per-host,
  since Ollama serializes/swaps at the host level anyway.)
```
