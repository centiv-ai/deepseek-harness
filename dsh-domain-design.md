# DeepSeek Harness — Domain Design and Logical Flow

A one-page map of the harness's moving parts for contributors who already know it is a TypeScript/Cordis plugin monorepo.

## 1. Domain map (bounded contexts)

| Domain | Owns | Key `ctx` service | Main packages |
|---|---|---|---|
| **Composition / Boot** | Profile, bundle, patch layers, loader tree, lifecycle | none (Cordis loader) | `packages/boot/app-boot` |
| **Session** | Append-only event log, in-memory projection, fork/resume, titles | `ctx.sessions` | `packages/session`, `packages/session-query` |
| **Agent runtime** | Turn/step driver, inbox, status, prompt assembly | `ctx.agentLoop`, `ctx.agents`, `ctx.systemPrompt` | `packages/core/agent-loop`, `core/agent`, `core/system-prompt`, `core/tools` |
| **LLM capability** | Message vocabulary, streaming adapter seam, providers | `ctx.llm` | `packages/llm/llm` + provider packages |
| **Tools capability** | Tool registry, guarded execution pipeline, tool schemas | `ctx.tools` | `packages/core/tools` |
| **Execution backends** | Bash, PTY, subprocess, sandbox, filesystem, LSP, code runtime | `ctx.shell`, `ctx.terminals`, `ctx.subprocess`, `ctx.sandbox`, `ctx.fs`, `ctx.lsp`, `ctx.codeRuntime` | `packages/shell`, `packages/terminal`, `packages/subprocess`, `packages/sandbox`, `packages/fs`, `packages/lsp`, `packages/code-runtime` |
| **Human collaboration** | Approval, commands, ask-user, feedback, interaction permissions | `ctx.approval`, `ctx.commands`, `ctx.interaction` | `packages/interaction`, `packages/feedback` |
| **Planning and goals** | Same-session goals, plan mode, todo list | `ctx.goals`, `ctx.todo`, `ctx.plan` | `packages/goal`, `packages/plan`, `packages/todo` |
| **Subagent / workflow** | Delegation, Ralph loop, background jobs | `ctx.subagent`, `ctx.workflow`, `ctx.jobs` | `packages/subagent`, `packages/workflow`, `packages/jobs` |
| **Context** | Request context (workspace instructions, time, etc.) | `ctx.context` | `packages/context` |
| **Web host** | HTTP server, route registry, upgrade routes, static fallback | `ctx.webServer` | `packages/host/webserver`, `packages/host/frontend-static` |
| **API / client** | Typert RPC gateway, browser wire, chat UI, conversation nodes | `ctx.apiGateway` (via gateway), client services | `packages/api/*`, `packages/client/*` |
| **Settings / credentials / identity** | User settings, credential records, anonymous identity | `ctx.settings`, `ctx.credentials`, `ctx.identity` | `packages/settings`, `packages/credentials`, `packages/identity` |
| **Self-modification** | Live plugin/service inspection and model-written mount/unmount | `ctx.extensions` | `packages/extensions` |
| **SDK / hooks** | Out-of-process JSON-RPC, Claude Code / Codex wire protocol | `ctx.sdk` | `packages/sdk`, `packages/hooks` |

## 2. Core entities and vocabulary

- **Profile**: a named composition stored in the harness home. It lists bundles and patch files. `web` and `headless` ship as templates.
- **Bundle**: a distribution of Cordis config rows and code that a profile stacks. A bundle can be patched by layers above it.
- **Cordis context**: the runtime container. Plugins expose services on stable `ctx.<key>` keys and communicate through typed events.
- **Capability seam**: a swappable feature with three roles — Service Definition (the `ctx.<key>` and vocabulary), Service Provider (implementation), and Consumer (usually a model-facing tool). One role alone is not a seam.
- **Session**: one conversation stream. The session log is an append-only sequence of `SessionEvent` facts.
- **Turn**: one drain of admitted input. It contains zero or more steps and ends when the model and its tools stop or a policy intervenes.
- **Step**: one model request plus the tool executions it causes.
- **Agent scope**: per-agent registrations (tools, prompt sections, restrictions). Scoped entries shadow same-named global entries for that agent only.
- **Model-visible ⟺ logged**: anything that reaches a model request must be reconstructable from the session log.

## 3. Boot and composition flow

```mermaid
flowchart TD
    CLI["dsh --profile web"] --> Boot["packages/boot/app-boot"]
    Boot --> Profile["Load profile metadata"]
    Profile --> Bundles["Apply bundle layers in order"]
    Bundles --> Patch1["profile/cordis.patch.yml"]
    Patch1 --> Patch2["$HOME/dsh/cordis.patch.yml"]
    Patch2 --> Patch3["--patch overlays"]
    Patch3 --> Loader["Cordis loader resolves inject graph"]
    Loader --> Activate["activate() / apply(ctx)"]
    Activate --> Services["ctx populated with services"]
    Services --> Server["webserver.listen() only for profiles that mount webserver"]
```

Key points:
- Load order is implied by `inject` declarations, not manual sequencing.
- Every registration is an effect with a disposer; unloading a plugin unwinds its contributions.
- A provider swap (for example, local bash → sandboxed bash) is a composition change, not a code change.

## 4. Agent turn and step lifecycle

```mermaid
sequenceDiagram
    participant U as User / SDK
    participant A as Agent (ctx.agents)
    participant D as AgentLoop driver
    participant P as ctx.systemPrompt
    participant L as ctx.llm
    participant T as ctx.tools
    participant S as ctx.sessions
    participant UI as UI listener

    U->>A: followup(content)
    A-->>UI: agent/inbox/inserted
    A->>D: queued work wakes driver
    D-->>UI: agent/status running
    D->>S: turn/start
    D-->>UI: agent/inbox/claimed
    D->>D: agent/pre-step waterfall
    alt rejected or empty
        D->>S: turn/end (no step)
    else admitted
        D->>S: step/start
        D->>S: user/message
        D->>P: system-prompt/assemble
        D->>D: agent/request waterfall
        D->>L: llm/stream waterfall
        L-->>D: StreamChunk*
        D->>S: assistant/chunk*
        S-->>UI: session/event assistant/chunk
        D->>S: assistant/message

        loop for each tool call
            D->>S: tool/call
            D->>T: tools/pre-execute
            T->>T: guards / approval
            T->>T: tools/execute around dispatch
            T->>T: tool body + owned events
            T->>T: tools/post-execute
            T->>T: finalizeContent
            T-->>D: tools/result
            D->>S: tool/result
        end

        D->>S: step/end
        opt another step owed
            D->>D: claim next-step input
            D->>D: agent/pre-step
        end
        opt natural stop
            D->>D: agent/turn-stopping serial checkpoint
        end
        D->>S: turn/end
    end
    D-->>UI: agent/status idle
```

Important details:
- `turn/start` and `turn/end` are durable session events.
- `step/start`, `user/message`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, `step/end` are also durable.
- Live coordination events (`agent/*`, `llm/stream`) are not durable; consume `session/event` for replay.
- `agent/pre-step`, `agent/request`, `llm/stream`, and the `tools/*` events are waterfalls; listeners must call `next()` or they short-circuit the chain.
- `agent/turn-stopping` is a serial terminal checkpoint.

## 5. Tool execution pipeline (zoomed)

```mermaid
flowchart TD
    assistant["Assistant message contains tool calls"] --> toolCall["Session event: tool/call"]
    toolCall --> presentCall["UI: presentCall"]
    toolCall --> pre["tools/pre-execute waterfall"]
    pre -->|allow| guards["Monotonic guards"]
    pre -->|deny| denied["Tool body skipped"]
    pre -->|ask| approval["ctx.approval one-shot prompt"]
    approval -->|allowed| guards
    approval -->|rejected| denied
    guards -->|allow| around["tools/execute waterfall"]
    guards -->|deny| denied
    around --> body["Registered execute() body"]
    body --> fsGate["fs/write-intent or fs/edit-intent"]
    fsGate --> body
    body --> owned["Tool-owned events<br/>todo/write, fs/observed, hook/*, tool/code-dispatch"]
    body --> around
    denied --> post["tools/post-execute waterfall"]
    around --> post
    post --> finalize["ToolDefinition.finalizeContent"]
    finalize --> result["tools/result notification"]
    result --> toolResult["Session event: tool/result"]
    toolResult --> presentResult["UI: presentResult"]
```

Key points:
- `tool/call` is logged before execution so the transcript shows intent even if the call is denied.
- Approval is a first-class capability (`ctx.approval`), not baked into the tool registry.
- Tool-owned events (for example, a todo update) are written by the tool itself during execution.
- `finalizeContent` enforces the tool's synchronous content-only invariant; `tool/result` is the frozen authoritative outcome.

## 6. Session persistence and projection

```mermaid
flowchart LR
    Log[(Session event log)] --> derive["deriveMessages()"]
    Log --> query["ctx.sessionQuery"]
    Log --> title["ctx.sessionTitle"]
    Log --> replay["SDK / UI replay"]
    Log --> fork["fork / resume"]
    derive --> model["Model history for next request"]
```

Invariants:
- The log is append-only and is the source of truth for model-visible state.
- `SESSION_FORMAT_VERSION` only bumps on structural log format changes.
- UI, SDK, and telemetry are projections of the log, not authoritative stores.

## 7. Capability seam swap example

```mermaid
flowchart TD
    Tool["dsh-tool-bash (Consumer)"] --> Shell["ctx.shell Service Definition"]
    Shell --> Local["dsh-bash-local Provider"]
    Shell --> Sandbox["dsh-bash-sandbox Provider"]
    Local --> Subprocess["ctx.subprocess"]
    Sandbox --> SandboxImpl["ctx.sandbox + ctx.subprocess"]
```

Swapping the provider moves Bash, PTY, and LSP consumers together because filesystem and subprocess providers share one execution world. No consumer code changes.

## 8. Web / API client flow

```mermaid
flowchart LR
    Browser --> Static["frontend-static fallback<br/>(index.html + dist)"]
    Browser --> HTTP["ctx.webServer HTTP routes"]
    HTTP --> APIGateway["dsh-api-gateway (Typert RPC)"]
    HTTP --> WSUpgrade["WebSocket upgrade route"]
    WSUpgrade --> Connection["client/connection wire"]
    Connection --> Agent["ctx.agents / ctx.agentLoop"]
    APIGateway --> Agent
```

Notes:
- `dsh-host-webserver` knows no harness concepts; it only provides route registration.
- The API gateway and downlink WebSockets are routes owned by the connection plugin.
- Chat UI nodes are contributed by plugins through `ConversationNodeDefinition` + keyed renderers.

## 9. Extension points map

| What you want to add | Extension point |
|---|---|
| New model provider | Register adapter on `ctx.llm` |
| New model-facing capability | Register tool on `ctx.tools` |
| Per-session capability set | Compose an agent preset with scoped registrations |
| Shell backend | Register `ctx.shell` provider |
| Persistent terminal | Register `ctx.terminals` provider + `dsh-tool-terminal` |
| Human command | Register on `ctx.commands` |
| Background work | Register on `ctx.jobs`; expose `job_*` tools |
| Filesystem policy | Register `ctx.fs` provider or listen to `fs/*` events |
| Process confinement | Register `ctx.sandbox` backend |
| Intercept a tool/turn | Listen to `agent/*` or `tools/*` events |
| Inject model-visible context | Call `agent.inject()`; it lands in the next admitted request |
| New UI chat node | Register `ConversationNodeDefinition` + renderer |
| Durable session state | Extend `SessionEventMap`; render/replay from log |
| Session titles | Register sole `ctx.sessionTitle` provider |
| Same-session objective | Use `ctx.goals` with `agent/*` continuation |
| Fork a session | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| Scope to one agent | Use that agent's `agent.ctx` |

## 10. Invariants and constraints

1. **Everything is a plugin.** There is no privileged core. Even the agent loop and session log are plugins.
2. **Registrations are effects.** Prompt sections, tools, listeners, and adapters install through `ctx.effect()` / `ctx.on()` and dispose on unload.
3. **Model-visible means logged.** A new model-visible input requires a new `SessionEventMap` entry.
4. **Waterfall listeners delegate.** A listener that does not call `next()` short-circuits the chain.
5. **Scoped shadowing.** Per-agent registrations replace same-named global ones for that agent only.
6. **Capability seams are complete.** A seam needs Service Definition + Provider + Consumer.
7. **Append-only log.** Session events are never mutated after append.
8. **Trust typed boundaries.** Runtime validation is reserved for parser/config, wire, file, worker, and process boundaries, not same-process typed interfaces.

## 11. Self-modification: dynamic Cordis packages

The harness lets the running agent inspect and temporarily extend its own Cordis runtime through the `dsh-tool-cordis` toolset (backed by `ctx.dynamicCordisRunner` in `packages/extensions`). This is an opt-in, development-only capability treated with the same trust as a bash tool: it is not a security boundary and can affect every session in the same process.

### The five model-facing tools

| Tool | What it does |
|---|---|
| `cordis_inspect` | Read-only report over the current process: live services, plugin fibers, registered tools, temporary packages, and generated API/event references. Narrow with `what` and `name`. |
| `cordis_define` | Records a dynamic package (`name`, `purpose`, optional host half `code`, optional browser half `client`) after syntax-checking both halves. Does not run anything. |
| `cordis_run` | Evaluates the host half in a `node:vm` sandbox and, if a browser half exists, asks an open page to load it. Running an already-running package re-delivers the live version. |
| `cordis_stop` | Disposes the host half and retracts the browser half, leaving the definition runnable again. |
| `cordis_undefine` | Stops the package if needed and removes the definition. The card stays in the transcript as a record. |

### Host-only vs dual-half packages

A package can have a **host half** (runs inside the DSH process), a **browser half** (loaded into the web client), or both. Host-only packages affect the runtime immediately. Dual-half packages need a human page to answer the run request because the browser half cannot be forced onto a remote client.

```mermaid
flowchart TD
    model["Model calls cordis_define"] --> registry["Definition registry<br/>(process memory)"]
    model -->|cordis_run| runner["ctx.dynamicCordisRunner"]
    runner --> host["Evaluate host half in node:vm"]
    host --> facade["Whitelist ctx façade"]
    facade --> services["ctx.shell / ctx.fs / ctx.web / ..."]
    runner -->|browser half| page["Open web page"]
    page -->|person allows| resolved["cordis/request-run-resolved"]
    resolved --> runner2["Host half bound; browser half loaded"]
    model -->|cordis_stop| stop["Dispose host fiber + retract browser half"]
    model -->|cordis_undefine| undefine["Forget definition"]
```

### Sandbox semantics

- Code is evaluated as an async function body in a fresh `node:vm` realm with minimal globals.
- Node built-ins such as `require`, `fetch`, `setTimeout`, and `Buffer` are either absent or redirect to Cordis services, steering mounts onto `ctx.fs`, `ctx.web`, `ctx.bash`, and timer helpers.
- The host half receives a whitelist `ctx` façade that exposes injectable services but hides framework internals; it cannot call `ctx.effect()` directly.
- Service reads require a declared `inject`, preserving Cordis activation and unload semantics.
- `harness.defineTool` / `harness.registerTool` register tools through the host registry so schemas and bodies are normalized and disposable.
- `vmTimeoutMs` bounds only synchronous evaluation; an async body escapes it.

### Composition and lifecycle

- Dynamic packages are mounted under an internal `cordis-dynamic` group fiber.
- Each package gets a process-local id such as `dyn-1`.
- Packages can depend on each other through ordinary Cordis `provide` / `inject`: package A provides `foo`, package B injects `foo` and activates when it exists.
- `cordis_stop` and `cordis_undefine` unwind every owned tool, listener, service, timer, and effect to quiescence.
- Temporary packages disappear on toolset unload or DSH restart.

### API catalog and inspectability

`cordis_inspect` renders from a generated catalog (`src/api-catalog.ts`) that is freshness-gated by `pnpm run verify-cordis-api`. The catalog is produced by the same AST scan as `docs/subsystems/`, so the API the model reads and the published docs cannot drift. Broad reports show summaries; an exact `name` returns full method signatures, JSDoc, and referenced types.

### Storage stance

Definitions live only in process memory. The session log records tool-call metadata, not package source, and nothing is written to disk or restored after restart. To keep an experiment, the model must implement a normal repository plugin or installable bundle through the regular development workflow.

### Trust stance

The sandbox prevents accidental global pollution and guides code toward Cordis services, but a motivated mount can escape through host-realm helpers. A temporary plugin can call `ctx.shell` with the host executor's privileges and reach real filesystems, networks, and other sessions. Load the toolset only where that level of trust is acceptable.