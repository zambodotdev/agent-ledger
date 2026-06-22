# agent-ledger

> AI agent call tracking, cost analysis, and audit log. Wrap any tool or LLM call. Full ledger in memory. Export to JSON or CSV. The Stripe dashboard for your agents. Zero dependencies.

[![npm version](https://img.shields.io/npm/v/agent-ledger.svg)](https://npmjs.com/package/agent-ledger)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

Built by [Brennan Zambo](https://zambo.dev) — extracted from the observability layer running inside [zambo.dev](https://zambo.dev)'s 28-tool MCP server.

---

## What it does

Every AI team running autonomous agents has the same problem: **you don't know what they're doing or what it's costing until something breaks or the bill arrives.** `agent-ledger` wraps any async function — LLM calls, tool calls, API calls — and records every invocation in a structured ledger.

One `report()` call tells you total cost, success rate, slowest tools, which providers are being hit, and how many tokens you've burned.

---

## Install

```bash
npm install agent-ledger
```

Zero dependencies. Node.js 18+. Works in any runtime.

---

## Quick start

```typescript
import { AgentLedger } from 'agent-ledger';

const ledger = new AgentLedger();

// Wrap any async function
const trackedSearch = ledger.wrap(searchWeb, 'web_search', { costUsd: 0.001 });
const trackedAudit  = ledger.wrap(auditCode, 'code_audit', {
  provider: 'groq',
  model: 'llama-3.3-70b-versatile',
  extractCost: (result) => result.costUsd ?? null,
  extractTokens: (result) => ({ input: result.inputTokens, output: result.outputTokens }),
});

// Use exactly like the original functions
const searchResult = await trackedSearch({ query: 'AI agent payments' });
const auditResult  = await trackedAudit({ code: myCode });

// Get a full report
const report = ledger.report();

console.log(`Total calls:   ${report.total}`);
console.log(`Success rate:  ${(report.successRate * 100).toFixed(1)}%`);
console.log(`Total cost:    $${report.totalCostUsd.toFixed(4)}`);
console.log(`Avg latency:   ${report.avgDurationMs}ms`);
console.log(`Total tokens:  ${report.totalTokens.input}in / ${report.totalTokens.output}out`);
```

---

## Global singleton

```typescript
import { getLedger } from 'agent-ledger';

// Same instance anywhere in your app
const ledger = getLedger();
```

---

## Report breakdown

```typescript
const report = ledger.report();

// By tool
console.log(report.byTool['web_search']);
// { calls: 142, errors: 3, avgDurationMs: 847, totalCostUsd: 0.142 }

// By provider
console.log(report.byProvider['groq']);
// { calls: 891, totalCostUsd: 0.0087 }

// By status
console.log(report.byStatus);
// { success: 1204, error: 12, timeout: 3 }
```

Filter by time window:

```typescript
const last24h = ledger.report(Date.now() - 86_400_000);
```

---

## Export

```typescript
// JSON
import { writeFileSync } from 'fs';
writeFileSync('agent-log.json', ledger.toJSON());

// CSV (open in Excel / Sheets)
writeFileSync('agent-log.csv', ledger.toCSV());
```

CSV columns: `id, tool, startedAt, completedAt, durationMs, status, costUsd, provider, model, inputTokens, outputTokens, error, inputSummary`

---

## Manual recording

For tools you can't wrap directly:

```typescript
ledger.record({
  id: 0, // auto-assigned, but required for type
  tool: 'vector_search',
  startedAt: Date.now() - 234,
  completedAt: Date.now(),
  durationMs: 234,
  status: 'success',
  costUsd: 0.0001,
  provider: 'pinecone',
  model: 'text-embedding-3-small',
  inputTokens: 128,
  outputTokens: 0,
});
```

---

## WrapOptions

```typescript
interface WrapOptions {
  costUsd?: number;                          // static cost per call
  provider?: string;                         // e.g. 'groq', 'anthropic'
  model?: string;                            // e.g. 'llama-3.3-70b'
  extractCost?: (result) => number | null;   // dynamic cost from result
  extractTokens?: (result) => { input?, output? } | null;
  summarizeInput?: (args) => string;         // privacy — default: first 200 chars
  meta?: Record<string, unknown>;            // arbitrary metadata
  timeoutMs?: number;                        // timeout in ms (status → 'timeout')
}
```

---

## Persist to disk

```typescript
const ledger = new AgentLedger({
  persistTo: './agent-log.json',   // written after every entry
  maxEntries: 50_000,              // FIFO eviction (default: 10,000)
  onEntry: (entry) => {
    if (entry.status === 'error') alertSlack(entry);
  },
});
```

---

## With MCP tools

```typescript
import { AgentLedger } from 'agent-ledger';
import { cascade } from 'ai-cascade';

const ledger = new AgentLedger();

const trackedCascade = ledger.wrap(
  (opts) => cascade(opts),
  'llm_cascade',
  {
    extractCost:   (r) => r.costUsd,
    extractTokens: () => null,
    provider:      'multi',
  }
);

// Every LLM call now tracked automatically
const result = await trackedCascade({ providers, messages });
```

---

## Related

- [ai-cascade](https://github.com/zambodotdev/ai-cascade) — multi-provider LLM fallback (pairs perfectly)
- [mcp-shield](https://github.com/zambodotdev/mcp-shield) — security middleware for MCP servers
- [mcp-pay](https://github.com/zambodotdev/mcp-pay) — x402 billing for MCP tools
- [zambo.dev](https://zambo.dev) — 28 MCP tools with agent-ledger tracking in production

---

## License

MIT © [Brennan Zambo](https://zambo.dev)
