# Staff-X Design Specification

**Status:** Draft, pending review  
**Built on:** DeepSeek Harness (`@deepseek-ai/dsh-*`) as an additive, separate-repo layer.

---

## 1. Purpose

Staff-X is a per-tenant executive-augmentation harness. It senses hidden signals across a company's operations (CRM, sales, finance, revenue, operations, customer success, dev/product execution), surfaces them to C-level users, recommends next-best actions, and executes those actions with approval.

It is **not** a duplicate of a CEO. It is the "10x staff" layer: a coordinator that gives executives a continuous, synthesized feel for the company and lets them act through delegated domain agents.

---

## 2. Design principles

- **Core untouched.** All Staff-X code lives in a separate repository and consumes `@deepseek-ai/dsh-*` packages from npm. No harness source is modified for business logic.
- **Additive composition.** Capabilities are added as bundles, preset agents, and capability seams on top of the harness spine.
- **Per-tenant isolation.** Each tenant runs its own Staff-X harness process in its own container/pod.
- **Durability by default.** Session logs, task state, permission requests, signal audit, and ontology changes survive process restarts and pod failures.
- **Human-in-the-loop.** Approval and permission requests route to domain owners; tenant admins can approve or overrule.
- **Model-visible means logged.** Anything that reaches a model prompt is reconstructable from the session log.

---

## 3. Repository and package topology

Staff-X is a pnpm monorepo that mirrors harness package disciplines but stays in its own namespace (`@yourco/staffx-*` or similar).

```text
packages/
  staff-core/              # Domain vocabulary, ontology, signals, task events, orchestration
  integrations/
    integration-crm/       # Service Definition: CrmRuntime
    integration-sales/     # Service Definition: SalesRuntime
    integration-finance/   # Service Definition: FinanceRuntime
    integration-revenue/   # Service Definition: RevenueRuntime
    integration-operations/# Service Definition: OperationsRuntime
    integration-support/   # Service Definition: SupportRuntime (customer success)
    integration-product/   # Service Definition: ProductRuntime (dev/product)
    integration-analytics/ # Service Definition: AnalyticsRuntime
  providers/
    provider-hubspot/
    provider-attio/
    provider-quickbooks/
    provider-intercom/
    provider-mixpanel/
    provider-jira/
    provider-linear/
  tools/
    tool-crm/
    tool-sales/
    tool-finance/
    tool-revenue/
    tool-operations/
    tool-customer-success/
    tool-dev-product/
    tool-analytics/
    tool-staffx/           # Orchestration tools for the Staff-X agent
  presets/
    preset-crm/
    preset-sales/
    preset-finance/
    preset-revenue/
    preset-operations/
    preset-customer-success/
    preset-dev-product/
    preset-signal-monitor/
    preset-staffx/          # The top-level orchestrator agent
  authz/
    staff-authz/            # Permission service, role/permission model, audit
  service/
    staffx-service/         # Fastify/Express HTTP service and webhook/scheduler adapters
  bundles/
    bundle-staffx-base/     # Wires harness spine + all presets + providers + storage
    bundle-staffx-service/  # Adds the HTTP service entry
```

### Isolation rules

- `staff-core` and `integration-*` packages never import provider internals.
- Function presets never import each other.
- Only `bundles/` and `service/` are allowed to assemble concrete providers.
- The Staff-X agent preset only sees orchestration tools and Service Definitions, not SaaS SDKs.

---

## 4. Capability seams

Each business function is a harness **capability seam** with three roles: Service Definition, Provider, and Consumer.

| Function | Service Definition | Example methods |
|---|---|---|
| CRM | `CrmRuntime` | `queryContacts`, `queryCompanies`, `queryDeals`, `getPipeline` |
| Sales | `SalesRuntime` | `queryOpportunities`, `getForecast`, `getActivities` |
| Finance | `FinanceRuntime` | `getPnl`, `getCashFlow`, `getBalanceSheet`, `getInvoices` |
| Revenue | `RevenueRuntime` | `getMrr`, `getArr`, `getChurn`, `getRevenueRecognition` |
| Operations | `OperationsRuntime` | `getProjects`, `getInventory`, `getVendorStatus`, `getRisks` |
| Customer Success | `SupportRuntime` | `getTickets`, `getConversations`, `getHealthScores`, `getNps` |
| Dev/Product | `ProductRuntime` | `getIssues`, `getEpics`, `getSprintStatus`, `getReleaseStatus`, `getRoadmap` |
| Analytics | `AnalyticsRuntime` | `getEventSeries`, `getFunnel`, `getRetention`, `getCohort` |

### Providers

Each SaaS integration is a provider package that implements one seam:

- `provider-hubspot` → registers `crm` provider on `CrmRuntime`
- `provider-attio` → registers another `crm` provider on `CrmRuntime`
- `provider-quickbooks` → registers `quickbooks` provider on `FinanceRuntime` and `RevenueRuntime`
- `provider-intercom` → registers `intercom` provider on `SupportRuntime`
- `provider-mixpanel` → registers `mixpanel` provider on `AnalyticsRuntime`
- `provider-jira` / `provider-linear` → register `jira` / `linear` providers on `ProductRuntime`

Providers register as effects and are selected per tenant by the bundle config.

### Consumers

Tool packages inject the Service Definition and expose model-facing tools. Example:

- `tool-crm` defines `query_crm`, `create_deal`, `update_contact`
- `tool-finance` defines `run_finance_report`, `get_cash_flow`
- `tool-staffx` defines `delegate_to_domain`, `query_ontology`, `summarize_signals`, `propose_action`

No consumer imports a SaaS SDK.

---

## 5. Agent model

### The Staff-X agent (top-level orchestrator)

Loaded by `preset-staffx`. It owns only orchestration tools:

| Tool | Purpose |
|---|---|
| `delegate_to_domain` | Spawn a Domain agent with a clear task and expected output schema. |
| `query_ontology` | Look up company domain definitions, owners, KPIs, thresholds. |
| `summarize_signals` | Request a digest of recent external signals. |
| `propose_action` | Formulate a recommended next step for user approval. |
| `execute_approved_action` | Run an already-approved action, usually by delegating to a Domain agent. |

Its system prompt includes the company ontology, delegation protocol, and approval protocol.

### Domain agents

One preset per function. Each Domain agent has:

- its own persona and glossary section,
- its own tool set scoped to that function,
- the correct providers activated for that tenant.

Domain agents do **not** call each other. If the Finance agent needs CRM context, it reports the gap and the Staff-X agent delegates to the CRM agent.

### Signal Monitor agent

A one-shot subagent spawned by the service for each external signal (or micro-batch). It classifies the signal, queries the ontology, and returns a structured `TriageDecision`:

```ts
{
  signalId: string
  decision: 'dismiss' | 'digest' | 'alert_staffx' | 'delegate_domain' | 'create_task'
  reason: string
  domain?: string
  taskObjective?: string
  priority: 'low' | 'medium' | 'high' | 'critical'
}
```

The service executes the decision and appends the appropriate audit event.

---

## 6. Durable tasks and fault tolerance

Long-horizon work is a first-class durable `Task` record, stored outside the session log in Postgres via `dsh-storage-domain` or a dedicated `TaskStore`.

### Task state

| Field | Purpose |
|---|---|
| `taskId` | Stable id, referenced in session events |
| `ownerSessionId` | The Staff-X session that owns it |
| `domain` | Target function (finance, crm, dev-product, ...) |
| `childSessionId` | The continuable subagent session |
| `objective` | Human-readable goal |
| `status` | `pending` / `active` / `paused_capacity` / `paused_provider` / `blocked_approval` / `failed` / `completed` |
| `checkpointSeq` | Last safely-processed session event seq |
| `retryCount` | For transient failures |
| `nextRetryAt` | Scheduled wake time |
| `deliverableRefs` | Pointers to artifacts |
| `approvalRequests` | Pending permission/approval requests |

### Failure recovery

| Failure | Detection | Recovery |
|---|---|---|
| Credit / API quota exhaustion | LLM provider error / rate limit | Mark `paused_capacity`; resume when budget restored. |
| Model downtime / rate limit | LLM provider 5xx / rate-limit | Mark `paused_provider`; exponential backoff. |
| SaaS integration error | Provider HTTP error | Tool-level retry via `dsh-jobs`; task-level retry on failure. |
| Connection disruption | Network error during tool call | `dsh-jobs` timeout/retry; task retry if activation lost. |
| Pod failure / process crash | Pod restart; boot scan of `active`/`paused_*` tasks | Resume child session from Postgres and re-activate. |
| Approval required | Permission/action approval request | Mark `blocked_approval`; resume on approval. |

### Harness primitives used

- `dsh-session-persistence-postgres` (custom provider) for session durability.
- `dsh-subagent` continuable children for long-running Domain agents.
- `dsh-goal` for same-session objective state inside a Domain agent.
- `dsh-todo` for the Domain agent's own task list.
- `dsh-jobs` for long-running tool calls.
- `dsh-schedule` for session-local reminders.
- `dsh-storage-domain` / Postgres for Task and artifact storage.

---

## 7. External signals and audit

### Ingestion channels

| Channel | Adapter | Output |
|---|---|---|
| Webhooks | Fastify route per source | Validates signature, enqueues `Signal`, returns `202`. |
| Email | IMAP/MS Graph polling or mail-service ingestion | Normalizes subject, sender, body, attachments. |
| Slack | Slack Events API handler | Normalizes message, channel, user, thread. |
| Scheduled jobs | Cron → HTTP endpoint | Creates `Signal` with `source: "scheduled"`. |

### Every signal is auditable

Every signal writes durable session events:

- `signal/received`
- `signal/triaged`
- `signal/dismissed` (with reason)
- `signal/escalated`
- `signal/tasked`

Dismissed signals remain in the audit log and are queryable via `query_signal_history`.

### Signal decision outcomes

| Decision | Action |
|---|---|
| `dismiss` | Append `signal/dismissed` with reason. |
| `digest` | Append as low-priority entry to Staff-X digest. |
| `alert_staffx` | Inject high-priority user message into Staff-X session. |
| `delegate_domain` | Create a Task and spawn a continuable Domain agent. |
| `create_task` | Create a durable Task for follow-up. |

---

## 8. Ontology and prompt system

### Static ontology

Tenant-specific configuration loaded at boot:

- Domain definitions and glossary
- Entity owners and responsible Domain agents
- KPI catalog and formulas
- Thresholds for signal priority
- Action policies (which actions require approval)

Stored as a versioned record in `dsh-storage-domain` (one per tenant).

### Dynamic ontology

Values derived from integrations or computed on demand:

| Fact type | Source |
|---|---|
| Current KPIs | Domain agents refresh on schedule/request |
| Active tasks | TaskStore |
| Recent signals | Signal audit log |
| Domain summaries | Domain agent reports |

Exposed to prompts through `ctx.systemPrompt.variable()` providers.

### Ontology service

`staff-core` defines `StaffXOntology`:

```ts
interface StaffXOntology {
  getDefinition(term: string): OntologyDefinition | undefined
  getKpi(name: string): KpiDefinition | undefined
  getOwner(domain: string): OwnerDefinition | undefined
  getThreshold(signalType: string): ThresholdDefinition | undefined
  getVariable(name: string): Promise<OntologyVariable | undefined>
  setVariable(name: string, value: unknown): Promise<void> // approval-gated if sensitive
  listDomains(): string[]
}
```

### Prompt assembly

The Staff-X agent prompt sections:

| Order | Section |
|---|---|
| -50 | Harness identity |
| 0 | Staff-X agent persona |
| 10 | Static company ontology |
| 20 | Dynamic context variables |
| 30 | Delegation protocol |
| 40 | Approval protocol |
| 100 | Tool guidance |

Domain agent prompts include their function-specific persona, glossary, tools, and current domain variables.

---

## 9. Authorization and permissions

### Permission model

Hybrid RBAC + ABAC stored in Postgres:

- **Tenant**: one company/deployment.
- **User**: authenticated human or service account.
- **Roles**: `tenant_admin`, `domain_owner:<domain>`, `operator`, `viewer`.
- **Permissions**: `finance:read`, `finance:execute`, `finance:approve`, `tenant:manage`, etc.
- **Action catalog**: static ontology entry mapping each tool/action to required permissions and default approver domain.

### Enforcement surfaces

| Surface | Enforcer |
|---|---|
| External UI / API | Express/Fastify middleware + `staff-authz` |
| Agent tool execution | `tools/pre-execute` guard or tool-body check + `staff-authz` |

### Permission request flow

1. Tool guard calls `staff-authz.requestPermission(...)`.
2. `PermissionRequest` record created in Postgres: `pending`.
3. Routed to default approver (domain owner); tenant admin can also see/overrule.
4. Session event `permission/request-created` appended.
5. Tool returns blocked result; task/turn enters `blocked_approval`.

Approvers can **approve once**, **grant permanently**, **deny**, or **overrule**. Each decision writes a Postgres audit row and a matching session event:

- `permission/approved`
- `permission/denied`
- `permission/overruled`

### Re-use of harness primitives

- `dsh-user-approval` for in-session one-shot approvals.
- `dsh-permission-presets` for coarse presets (`read-only`, `operator`, `admin`).
- `dsh-settings` for tenant-wide default policies and role mappings.

---

## 10. Web service facade

The Staff-X service is a Node HTTP server (Fastify/Express) that embeds the harness. The UI and external channels talk only to this service.

### Authentication

Gateway-terminated auth from the sidecar identity service. Headers forwarded:

- `x-user-id`
- `x-tenant-id`
- `x-roles`
- `x-permissions`

### External API

| Route | Purpose |
|---|---|
| `POST /sessions` | Create a new Staff-X session. |
| `POST /sessions/:id/messages` | Send a user message. |
| `GET /sessions/:id/events` | SSE stream of session events. |
| `GET /sessions/:id/surface` | Snapshot of conversation state. |
| `GET /sessions/:id/subagents` | List active/resumable Domain agents. |
| `POST /tasks` | Create a long-horizon task manually. |
| `GET /tasks/:id` | Task status, checkpoints, deliverables. |
| `POST /tasks/:id/followup` | Follow up with a continuable Domain agent. |
| `POST /tasks/:id/approve` | Approve a blocked task. |
| `GET /signals` | Signal feed / digest. |
| `POST /signals/:id/dismiss` | Dismiss a signal. |
| `POST /webhooks/:source` | Inbound webhooks (HubSpot, Stripe, etc.). |
| `POST /scheduled/:job` | Scheduled job trigger. |
| `GET /ontology` | Read ontology. |
| `POST /ontology` | Update static ontology (tenant admin). |
| `GET /permissions` | Current user's effective permissions. |
| `POST /permissions/requests` | Request elevated permission. |
| `POST /permissions/requests/:id/approve` | Approve/overrule permission request. |

### Event streaming

The UI connects to `GET /sessions/:id/events` via SSE. The service forwards relevant `SessionEvent`s from `ctx.sessions` in real time.

---

## 11. Platform service and deployment

### Harness instance classes

There are two kinds of Staff-X harness instances:

| Instance class | Purpose | Data plane |
|---|---|---|
| **Platform Staff-X** | Internal operations, onboarding new tenants, tenant support, platform-level questions | Owns the platform tenant data |
| **Tenant Staff-X** | One instance per customer tenant; handles that tenant's CRM, sales, finance, signals, tasks, approvals | Owns exactly one tenant's data, fully isolated from other tenants |

The Platform Staff-X instance is provisioned and managed by the platform team. It helps onboard new tenants, answers questions about the platform itself, and operates the platform's internal functions.

### Control plane vs. data plane

| Platform service | Staff-X harness service |
|---|---|
| Manages tenants, users, roles, billing | Runs the agent loop for one tenant |
| Defines base domain model, ontology templates, integration catalog | Receives tenant-specific config and boots Cordis context |
| Triggers tenant Postgres DB creation and seeding | Connects to its provisioned logical database |
| Provisions/configures harness instances (platform + per-tenant) | Executes agents, tasks, signals, approvals |
| Serves UI config and admin dashboards | Exposes runtime API to UI and external channels |
| Pushes credentials and provider settings | Consumes credentials via `dsh-credentials` |

### Tenant provisioning flow

```text
Platform service
   ├── creates tenant record
   ├── selects tenant domain config (ontology, roles, permissions, integrations)
   ├── stores OAuth/API credentials in its vault
   ├── triggers CNPG Postgres tenant DB creation script
   │       └── new logical DB created from latest DB image
   │       └── tenant info seeded (tenant_id, admin user, default roles, base ontology)
   └── generates tenant config bundle (includes DB connection string)
           │
           ▼
   Provisions Staff-X harness instance for that tenant
           │
           ▼
   Harness service boots with tenant bundle + logical DB + queue
```

When a new tenant is created, the platform service runs a database creation script against the CNPG Postgres cluster. The script creates a fresh logical database from the latest DB image, then seeds it with tenant metadata, an admin user, default roles, and the base ontology. The harness instance is started only after the DB is ready and its connection string is injected into the tenant config bundle.

### Memory / BI layer

Staff-X writes structured events to the platform's memory/BI sink:

- Task lifecycle
- Signal stream
- Permission/approval audit
- Agent usage and model calls
- Ontology changes

The BI layer owns dashboards; the harness service stays focused on execution.

### Deployment topology

- **CNPG Postgres cluster** with one logical database per tenant. The platform service creates a new logical DB for each tenant via a DB creation script using the latest DB image.
- **One harness pod/container per tenant**, plus a **Platform Staff-X harness pod** for internal platform operations.
- **Tenant data isolation**: each tenant harness instance connects only to its own logical DB; no shared schema.
- **External message queue** for signals (SQS/RabbitMQ/Kafka/Postgres-backed queue).
- **Identity gateway** terminates auth.
- **Platform service** provisions harness pods, creates tenant databases, seeds tenant info, and pushes config updates.
- **BI sink** receives event streams from harness via a plugin or sidecar.

### Upgrade path

- Pin `@deepseek-ai/dsh-*` versions in the harness service image.
- The platform service stages harness versions for the Platform Staff-X instance first, then per-tenant fleet.
- Upgrade flow: build new image → deploy to Platform Staff-X → validate → canary tenant → validate → fleet-wide rollout.
- Tenant DB schema migrations are applied by the platform service using the same DB creation/migration pipeline.

---

## 12. Testing and quality

| Layer | How to test |
|---|---|
| Service Definitions | Unit tests against the abstract interface. |
| Providers | Contract tests against SaaS sandboxes or recorded fixtures. |
| Tools | Keyless harness unit tests using in-memory sessions. |
| Presets | Snapshot tests of system prompt assembly and visible tool schemas. |
| Task durability | Simulated pod restarts; verify resume from persisted session store. |
| Signal audit | Inject signals, verify `signal/*` events and audit rows. |
| Permissions | Test allow/deny/overrule paths for each role. |
| Integration | End-to-end harness tests with mock providers. |

---

## 13. Open decisions

1. **Signal queue technology:** SQS, RabbitMQ, Kafka, or Postgres-backed queue table?
2. **Initial SaaS integrations:** Which two or three integrations (HubSpot, QuickBooks, Jira, Linear, etc.) form the first milestone?
3. **Identity gateway:** Existing gateway or new sidecar service?
4. **Platform Staff-X tenancy model:** Does the Platform Staff-X instance use the same logical DB pattern as tenants, or a dedicated platform DB?

These are implementation-phase decisions and can be resolved in the plan.
