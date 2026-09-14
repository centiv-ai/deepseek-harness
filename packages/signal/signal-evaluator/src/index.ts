/**
 * @centiv/dsh-signal-evaluator — Centiv signal evaluator plugin.
 *
 * A Cordis plugin that provides a ``signalEvaluator`` service for processing
 * reasoning tasks through the DSH agent system. Each task is dispatched to a
 * configured LLM provider (LiteLLM proxy) via the DSH agent infrastructure,
 * and the LLM response is parsed into structured ``SignalCandidate`` objects.
 *
 * The plugin can be mounted in any DSH bundle that provides the core agent,
 * session, and LLM services. It exposes a synchronous ``evaluate()`` method
 * that creates transient per-task agents inside the Cordis runtime, avoiding
 * the overhead of HTTP client management while keeping all LLM traffic inside
 * the DSH's unified provider registration.
 *
 * @module @centiv/dsh-signal-evaluator
 */

import { randomUUID } from 'node:crypto'
import type { Context, Service } from '@deepseek-ai/cordis'
import { Schema } from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

// ─────────────────────────────────────────────────────────────────────────────
// Types mirroring the Python side (centiv.signals.registry)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reference to a subject (company, contact, deal, etc.).
 */
export interface SubjectRef {
  subject_type: string
  subject_id: string
  display_name?: string | null
}

/**
 * A piece of evidence attached to a reasoning task.
 */
export interface EvidenceRef {
  kind: string
  ref: string
  payload?: Record<string, unknown> | null
  source_meta?: Record<string, unknown> | null
}

/**
 * A single reasoning task for the LLM to evaluate.
 */
export interface ReasoningTask {
  reasoning_task_id: string
  rule_id: string
  rule_version: string
  signal_type_slug: string
  signal_type_version: string
  subject: SubjectRef
  evidence: EvidenceRef[]
  tool_scopes: string[]
  budget: Record<string, unknown>
  policy_snapshot_id?: string | null
  output_schema?: Record<string, unknown> | null
  rubric?: Record<string, unknown> | null
}

/**
 * A signal candidate produced by the LLM.
 */
export interface SignalCandidate {
  signal_type_slug: string
  signal_type_version: string
  subject: SubjectRef
  severity: string
  urgency?: string | null
  relevance?: string | null
  confidence: number
  evidence: EvidenceRef[]
  title_template: string
  body_template: string
  template_inputs?: Record<string, unknown> | null
  fingerprint_hint?: string | null
  rubric_scores?: Record<string, unknown> | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plugin configuration.
 */
export interface Config {
  /** LLM provider route (registered in the DSH provider registry). */
  provider: string
  /** Model ID to use for evaluation. */
  model: string
  /** Maximum tokens per response. */
  maxTokens: number
  /** Temperature for response generation. */
  temperature: number
}

export const Config: Schema<Config> = Schema.object({
  provider: Schema.string()
    .default('openai')
    .description('LLM provider route registered in the DSH provider registry'),
  model: Schema.string()
    .default('gpt-4o-mini')
    .description('Model ID for evaluation'),
  maxTokens: Schema.natural()
    .default(2048)
    .description('Maximum output tokens per response'),
  temperature: Schema.percent()
    .default(0.1)
    .description('Response temperature (low for deterministic output)'),
})

// ─────────────────────────────────────────────────────────────────────────────
// Signal evaluator service
// ─────────────────────────────────────────────────────────────────────────────

declare module '@deepseek-ai/cordis' {
  interface Services {
    /** Signal evaluation service — process reasoning tasks and return candidates. */
    signalEvaluator: SignalEvaluator
  }
}

/**
 * Configuration for a single evaluation batch.
 */
export interface EvaluationConfig {
  /** The batch of reasoning tasks to evaluate. */
  tasks: ReasoningTask[]
  /** Evidence pool for cross-reference lookup. */
  evidencePool?: Record<string, unknown>
  /** Total deadline in ms for the batch. */
  timeoutMs?: number
}

/**
 * Result of a single task evaluation.
 */
export interface TaskEvaluationResult {
  reasoning_task_id: string
  success: boolean
  candidate?: SignalCandidate | null
  error?: string | null
  durationMs: number
}

/**
 * Result of an evaluation batch.
 */
export interface EvaluationResult {
  batch_id: string
  results: TaskEvaluationResult[]
  total_duration_ms: number
}

/**
 * Signal evaluation service provided by this plugin.
 *
 * Expects the DSH runtime to have:
 * - ``agents`` registered (for per-task agent creation)
 * - ``sessions`` registered (for flushing agent state)
 * - ``agentDefaultModel`` registered (for picking the provider/model)
 * - ``loader`` registered (for awaiting sibling plugin composition)
 */
export class SignalEvaluator implements Service {
  static inject = ['agents', 'sessions', 'agentDefaultModel', 'loader']

  constructor(
    private ctx: Context,
    private config: Config,
  ) {
    ctx.provide('signalEvaluator', this)
  }

  start(): void {
    this.ctx.logger.info(
      `signal-evaluator started: provider=${this.config.provider} model=${this.config.model}`,
    )
  }

  /**
   * Build a system prompt for a reasoning task.
   */
  private buildTaskPrompt(task: ReasoningTask): string {
    const evidenceBlock = task.evidence.length > 0
      ? `\nEvidence:\n${task.evidence
        .map(e => `  [${e.kind}] ${e.ref}${e.payload ? `: ${JSON.stringify(e.payload)}` : ''}`)
        .join('\n')}`
      : '\nNo evidence provided.'

    const schemaBlock = task.output_schema && Object.keys(task.output_schema).length > 0
      ? `\nOutput schema:\n${JSON.stringify(task.output_schema, null, 2)}`
      : ''

    const rubricBlock = task.rubric && Object.keys(task.rubric).length > 0
      ? `\nRubric:\n${JSON.stringify(task.rubric, null, 2)}`
      : ''

    return [
      'You are a signal evaluation agent for Centiv\'s revenue operations platform.',
      'Analyze the following signal type and subject and determine if a signal should be raised.',
      '',
      `Signal type: ${task.signal_type_slug} (v${task.signal_type_version})`,
      `Rule: ${task.rule_id} (v${task.rule_version})`,
      `Subject: ${task.subject.subject_type}/${task.subject.subject_id}${task.subject.display_name ? ` (${task.subject.display_name})` : ''}`,
      `Task ID: ${task.reasoning_task_id}`,
      '',
      evidenceBlock,
      schemaBlock,
      rubricBlock,
      '',
      'Your task is to analyze the evidence and produce a structured SignalCandidate JSON object.',
      'The JSON must have the following shape:',
      '{',
      '  "signal_type_slug": string,',
      '  "signal_type_version": string,',
      '  "subject": { "subject_type": string, "subject_id": string },',
      '  "severity": "critical" | "high" | "medium" | "low",',
      '  "urgency": "critical" | "high" | "medium" | "low",',
      '  "confidence": number (0.0 to 1.0),',
      '  "title_template": string,',
      '  "body_template": string,',
      '  "template_inputs": object',
      '}',
      '',
      'Return ONLY the JSON object, no markdown fences, no commentary.',
    ].join('\n')
  }

  /**
   * Evaluate a single reasoning task through the DSH agent system.
   */
  private async evaluateTask(
    task: ReasoningTask,
    defaultModel: { currentSelection: () => { provider: string; model: string } },
    agents: {
      create: (opts: unknown) => Promise<{
        agent: {
          session: {
            seq: number
            events: unknown[]
            followup: (msg: unknown) => void
            whenIdle: () => Promise<void>
          }
        }
      }>
    },
  ): Promise<TaskEvaluationResult> {
    const startedAt = Date.now()

    try {
      const prompt = this.buildTaskPrompt(task)
      const _selection = defaultModel.currentSelection()

      // Create a transient agent for this task using DSH's agent system
      const { agent } = await agents.create({
        sessionId: SessionId(`eval-${task.reasoning_task_id}-${randomUUID()}`),
        meta: {},
        agentOptions: {
          provider: this.config.provider,
          model: this.config.model,
        },
      })

      await agent.whenIdle()
      const firstSeq = agent.session.seq

      // Send the prompt to the agent
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      // Collect the response
      let responseText = ''
      for (const event of agent.session.events) {
        if (event.type === 'assistant/message' && event.seq >= firstSeq) {
          const joined = event.data.message.content
            .filter((block: { type: string }) => block.type === 'text')
            .map((block: { text: string }) => block.text)
            .join('')
          if (joined !== '') responseText = joined
        }
      }

      // Parse the response
      const candidate = this.parseCandidate(responseText, task)
      const durationMs = Date.now() - startedAt

      return {
        reasoning_task_id: task.reasoning_task_id,
        success: candidate !== null,
        candidate,
        durationMs,
      }
    } catch (error) {
      const durationMs = Date.now() - startedAt
      return {
        reasoning_task_id: task.reasoning_task_id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs,
      }
    }
  }

  /**
   * Parse a JSON signal candidate from LLM response text.
   */
  private parseCandidate(text: string, task: ReasoningTask): SignalCandidate | null {
    // Strip markdown code fences if present
    const cleaned = text
      .replace(/^```(?:json)?\s*/gm, '')
      .replace(/\s*```$/gm, '')
      .trim()

    try {
      const parsed = JSON.parse(cleaned)

      // Validate required fields
      if (!parsed.signal_type_slug || !parsed.severity) return null

      return {
        signal_type_slug: parsed.signal_type_slug || task.signal_type_slug,
        signal_type_version: parsed.signal_type_version || task.signal_type_version,
        subject: {
          subject_type: parsed.subject?.subject_type || task.subject.subject_type,
          subject_id: parsed.subject?.subject_id || task.subject.subject_id,
        },
        severity: parsed.severity || 'medium',
        urgency: parsed.urgency || null,
        relevance: parsed.relevance || null,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        evidence: parsed.evidence || [],
        title_template: parsed.title_template || '',
        body_template: parsed.body_template || '',
        template_inputs: parsed.template_inputs || null,
        fingerprint_hint: parsed.fingerprint_hint || null,
        rubric_scores: parsed.rubric_scores || null,
      }
    } catch {
      // JSON parse failure
      return null
    }
  }

  /**
   * Evaluate a batch of reasoning tasks.
   *
   * Each task is processed through its own transient DSH agent.
   * Tasks are evaluated sequentially to respect rate limits.
   */
  async evaluate(config: EvaluationConfig): Promise<EvaluationResult> {
    const startedAt = Date.now()
    const batchId = `eval-batch-${randomUUID()}`

    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    const defaultModel = this.ctx.get('agentDefaultModel')
    const loader = this.ctx.get('loader')

    if (!agents || !sessions || !defaultModel || !loader) {
      throw new Error('signal-evaluator: required services (agents, sessions, agentDefaultModel, loader) not available')
    }

    // Wait for sibling plugins to finish composing
    await loader.await()

    this.ctx.logger.info(
      `evaluating batch ${batchId}: ${config.tasks.length} tasks, provider=${this.config.provider} model=${this.config.model}`,
    )

    const results: TaskEvaluationResult[] = []
    for (const task of config.tasks) {
      const result = await this.evaluateTask(task, defaultModel, agents)
      results.push(result)
      this.ctx.logger.debug(
        `task ${task.reasoning_task_id}: ${result.success ? 'ok' : 'fail'}${result.candidate ? ` severity=${result.candidate.severity}` : ''} ${result.durationMs}ms`,
      )
    }

    const totalDurationMs = Date.now() - startedAt
    const succeeded = results.filter(r => r.success).length

    this.ctx.logger.info(
      `batch ${batchId}: ${succeeded}/${results.length} succeeded in ${totalDurationMs}ms`,
    )

    return {
      batch_id: batchId,
      results,
      total_duration_ms: totalDurationMs,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin entry point
// ─────────────────────────────────────────────────────────────────────────────

export const name = 'signal-evaluator'

export const inject = ['agents', 'sessions', 'agentDefaultModel', 'loader']

/**
 * Mount the signal evaluator service.
 */
export function apply(ctx: Context, config: Config): void {
  const service = new SignalEvaluator(ctx, config)
  service.start()
}
