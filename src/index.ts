/**
 * agent-ledger — AI agent call tracking, cost analysis, and audit log
 * Wrap any tool or LLM call. Get a full ledger of every agent action.
 * In-memory by default. Export to JSON or CSV. Zero dependencies.
 *
 * github.com/zambodotdev/agent-ledger
 * zambo.dev/opensource
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type EntryStatus = 'success' | 'error' | 'timeout';

export interface LedgerEntry {
  /** Auto-incremented numeric ID */
  id: number;
  /** Tool or function name */
  tool: string;
  /** When the call started (Unix ms) */
  startedAt: number;
  /** When the call completed (Unix ms) */
  completedAt: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Outcome */
  status: EntryStatus;
  /** Estimated cost in USD (null if unknown) */
  costUsd: number | null;
  /** LLM provider used (if applicable) */
  provider?: string;
  /** Model used (if applicable) */
  model?: string;
  /** Input token count (if applicable) */
  inputTokens?: number;
  /** Output token count (if applicable) */
  outputTokens?: number;
  /** Sanitized input summary (first 200 chars, no PII) */
  inputSummary?: string;
  /** Error message if status === 'error' */
  error?: string;
  /** Arbitrary metadata */
  meta?: Record<string, unknown>;
}

export interface WrapOptions {
  /** Estimated cost in USD per call (static, for tools without token tracking) */
  costUsd?: number;
  /** LLM provider name */
  provider?: string;
  /** LLM model name */
  model?: string;
  /** Function to extract cost from the result (dynamic) */
  extractCost?: (result: unknown) => number | null;
  /** Function to extract token counts from the result */
  extractTokens?: (result: unknown) => { input?: number; output?: number } | null;
  /** Summarize the input before recording (for privacy). Default: first 200 chars. */
  summarizeInput?: (args: unknown) => string;
  /** Arbitrary metadata to attach to every entry */
  meta?: Record<string, unknown>;
  /** Timeout in ms — if exceeded, status becomes 'timeout' */
  timeoutMs?: number;
}

export interface LedgerOptions {
  /** Maximum entries to keep in memory (FIFO eviction, default: 10000) */
  maxEntries?: number;
  /** Persist entries to this JSON file path after every write */
  persistTo?: string;
  /** Called after every new entry is recorded */
  onEntry?: (entry: LedgerEntry) => void;
}

export interface Report {
  /** Total recorded entries */
  total: number;
  /** Entries by status */
  byStatus: Record<EntryStatus, number>;
  /** Entries by tool name */
  byTool: Record<string, { calls: number; errors: number; avgDurationMs: number; totalCostUsd: number }>;
  /** Entries by provider */
  byProvider: Record<string, { calls: number; totalCostUsd: number }>;
  /** Total estimated cost across all entries */
  totalCostUsd: number;
  /** Average call duration in ms */
  avgDurationMs: number;
  /** Success rate 0–1 */
  successRate: number;
  /** Period covered */
  period: { from: number; to: number };
  /** Total tokens used */
  totalTokens: { input: number; output: number };
}

// ── Main class ────────────────────────────────────────────────────────────

export class AgentLedger {
  private entries: LedgerEntry[] = [];
  private nextId = 1;
  private opts: LedgerOptions;

  constructor(options: LedgerOptions = {}) {
    this.opts = options;
  }

  /**
   * Wrap any async function to automatically record call metadata.
   *
   * @example
   * const trackedAnalyze = ledger.wrap(analyzeCode, 'analyze_code', {
   *   costUsd: 0.005,
   *   provider: 'groq',
   *   model: 'llama-3.3-70b-versatile',
   * });
   *
   * const result = await trackedAnalyze(args);
   * // Entry recorded automatically regardless of success or failure
   */
  wrap<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    toolName: string,
    options: WrapOptions = {},
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs): Promise<TResult> => {
      const startedAt = Date.now();
      const inputSummary = options.summarizeInput
        ? options.summarizeInput(args)
        : String(JSON.stringify(args)).slice(0, 200);

      let result: TResult;
      let status: EntryStatus = 'success';
      let errorMsg: string | undefined;
      let costUsd: number | null = options.costUsd ?? null;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;

      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        const race = options.timeoutMs
          ? Promise.race([
              fn(...args),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  timedOut = true;
                  reject(new Error(`Timeout after ${options.timeoutMs}ms`));
                }, options.timeoutMs);
              }),
            ])
          : fn(...args);

        result = await race;
        if (timer) clearTimeout(timer);

        // Try to extract dynamic cost / tokens from result
        if (options.extractCost) {
          const dynCost = options.extractCost(result);
          if (dynCost !== null) costUsd = dynCost;
        }
        if (options.extractTokens) {
          const tokens = options.extractTokens(result);
          if (tokens) {
            inputTokens = tokens.input;
            outputTokens = tokens.output;
          }
        }
      } catch (e) {
        if (timer) clearTimeout(timer);
        status = timedOut ? 'timeout' : 'error';
        errorMsg = (e as Error).message;
        result = undefined as unknown as TResult;
        // Still record the failed call
      }

      const completedAt = Date.now();
      const entry: LedgerEntry = {
        id: this.nextId++,
        tool: toolName,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        status,
        costUsd,
        provider: options.provider,
        model: options.model,
        inputTokens,
        outputTokens,
        inputSummary,
        error: errorMsg,
        meta: options.meta,
      };

      this.record(entry);

      if (status !== 'success') {
        throw new Error(errorMsg);
      }

      return result;
    };
  }

  /**
   * Manually record a pre-built entry (for tools you can't wrap directly).
   */
  record(entry: LedgerEntry): void {
    const maxEntries = this.opts.maxEntries ?? 10_000;

    if (this.entries.length >= maxEntries) {
      this.entries.shift(); // FIFO eviction
    }

    this.entries.push(entry);
    this.opts.onEntry?.(entry);

    if (this.opts.persistTo) {
      this.persistAsync(this.opts.persistTo);
    }
  }

  /**
   * Get all recorded entries, optionally filtered.
   */
  getEntries(filter?: {
    tool?: string;
    status?: EntryStatus;
    provider?: string;
    since?: number;
    limit?: number;
  }): LedgerEntry[] {
    let result = [...this.entries];

    if (filter?.tool) result = result.filter(e => e.tool === filter.tool);
    if (filter?.status) result = result.filter(e => e.status === filter.status);
    if (filter?.provider) result = result.filter(e => e.provider === filter.provider);
    if (filter?.since) result = result.filter(e => e.startedAt >= filter.since!);
    if (filter?.limit) result = result.slice(-filter.limit);

    return result;
  }

  /**
   * Generate a usage report across all recorded entries.
   *
   * @example
   * const report = ledger.report();
   * console.log(`Total cost: $${report.totalCostUsd.toFixed(4)}`);
   * console.log(`Success rate: ${(report.successRate * 100).toFixed(1)}%`);
   * console.log(`Avg latency: ${report.avgDurationMs}ms`);
   */
  report(since?: number): Report {
    const entries = since
      ? this.entries.filter(e => e.startedAt >= since)
      : this.entries;

    const byStatus: Record<EntryStatus, number> = { success: 0, error: 0, timeout: 0 };
    const byTool: Report['byTool'] = {};
    const byProvider: Report['byProvider'] = {};
    let totalCostUsd = 0;
    let totalDuration = 0;
    let totalInput = 0;
    let totalOutput = 0;

    for (const e of entries) {
      byStatus[e.status]++;
      totalDuration += e.durationMs;
      if (e.costUsd !== null) totalCostUsd += e.costUsd;
      if (e.inputTokens) totalInput += e.inputTokens;
      if (e.outputTokens) totalOutput += e.outputTokens;

      // By tool
      if (!byTool[e.tool]) {
        byTool[e.tool] = { calls: 0, errors: 0, avgDurationMs: 0, totalCostUsd: 0 };
      }
      const toolStats = byTool[e.tool];
      toolStats.calls++;
      if (e.status !== 'success') toolStats.errors++;
      toolStats.avgDurationMs = Math.round(
        (toolStats.avgDurationMs * (toolStats.calls - 1) + e.durationMs) / toolStats.calls,
      );
      if (e.costUsd !== null) toolStats.totalCostUsd += e.costUsd;

      // By provider
      if (e.provider) {
        if (!byProvider[e.provider]) byProvider[e.provider] = { calls: 0, totalCostUsd: 0 };
        byProvider[e.provider].calls++;
        if (e.costUsd !== null) byProvider[e.provider].totalCostUsd += e.costUsd;
      }
    }

    const first = entries[0];
    const last = entries[entries.length - 1];

    return {
      total: entries.length,
      byStatus,
      byTool,
      byProvider,
      totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
      avgDurationMs: entries.length ? Math.round(totalDuration / entries.length) : 0,
      successRate: entries.length ? byStatus.success / entries.length : 1,
      period: {
        from: first?.startedAt ?? Date.now(),
        to: last?.completedAt ?? Date.now(),
      },
      totalTokens: { input: totalInput, output: totalOutput },
    };
  }

  /**
   * Export all entries as a CSV string.
   *
   * @example
   * import { writeFileSync } from 'fs';
   * writeFileSync('agent-log.csv', ledger.toCSV());
   */
  toCSV(): string {
    const headers = [
      'id', 'tool', 'startedAt', 'completedAt', 'durationMs',
      'status', 'costUsd', 'provider', 'model', 'inputTokens',
      'outputTokens', 'error', 'inputSummary',
    ];

    const rows = this.entries.map(e => [
      e.id,
      e.tool,
      new Date(e.startedAt).toISOString(),
      new Date(e.completedAt).toISOString(),
      e.durationMs,
      e.status,
      e.costUsd ?? '',
      e.provider ?? '',
      e.model ?? '',
      e.inputTokens ?? '',
      e.outputTokens ?? '',
      (e.error ?? '').replace(/,/g, ';'),
      (e.inputSummary ?? '').replace(/,/g, ';').replace(/\n/g, ' '),
    ].join(','));

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Export all entries as a JSON string.
   */
  toJSON(): string {
    return JSON.stringify({ entries: this.entries, generatedAt: Date.now() }, null, 2);
  }

  /** Clear all entries (does not reset ID counter) */
  clear(): void {
    this.entries = [];
  }

  /** Number of entries currently in memory */
  get size(): number {
    return this.entries.length;
  }

  private persistAsync(filePath: string): void {
    // Fire-and-forget write — Node.js only, no-op in browser/Deno
    const data = this.toJSON();
    void Promise.resolve().then(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const req = (globalThis as any)['require'] as ((m: string) => { writeFile: (p: string, d: string, cb: () => void) => void }) | undefined;
        if (typeof req === 'function') {
          req('fs').writeFile(filePath, data, () => { /* silent */ });
        }
      } catch { /* browser / Deno / non-Node */ }
    });
  }
}

// ── Singleton convenience ──────────────────────────────────────────────────

let _defaultLedger: AgentLedger | null = null;

/**
 * Get or create the default global ledger instance.
 * Useful when you want a single ledger across your entire app.
 *
 * @example
 * import { getLedger } from 'agent-ledger';
 *
 * const ledger = getLedger();
 * const trackedSearch = ledger.wrap(searchWeb, 'web_search', { costUsd: 0.001 });
 */
export function getLedger(options?: LedgerOptions): AgentLedger {
  if (!_defaultLedger) {
    _defaultLedger = new AgentLedger(options);
  }
  return _defaultLedger;
}

/** Reset the global default ledger (useful for testing) */
export function resetLedger(): void {
  _defaultLedger = null;
}
