import { describe, expect, it } from 'vitest';
import {
  pairedRunSchema,
  parseHarnessState,
  parseNativeReviewOutput,
  parseThreadId,
} from '../apps/server/src/paired-runner.js';

describe('paired benchmark runner', () => {
  it('requires exactly one prompt source for every task', () => {
    const base = {
      name: 'test',
      harnessRevision: 'a'.repeat(40),
      model: 'same-model',
      reasoningEffort: 'low',
      outputDirectory: 'output',
      harness: {
        instructionsFile: 'AGENTS.md',
        mcpCommand: 'chat-main.js',
        serverUrl: 'http://127.0.0.1:4310',
        tokenEnvironmentVariable: 'LOCAL_MCP_TOKEN',
      },
      tasks: [
        {
          id: 'task-1',
          prompt: 'Implement the requested behavior',
          promptFile: 'task.txt',
          baseSha: 'b'.repeat(40),
          baselineRoot: 'baseline',
          harnessRoot: 'harness',
        },
      ],
    };
    expect(pairedRunSchema.safeParse(base).success).toBe(false);
    delete (base.tasks[0] as { promptFile?: string }).promptFile;
    expect(pairedRunSchema.safeParse(base).success).toBe(true);
  });

  it('extracts the persisted Codex thread identifier', () => {
    expect(
      parseThreadId(
        `${JSON.stringify({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' })}\n`,
      ),
    ).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53');
  });

  it('tracks the latest governed state and verification attempt', () => {
    const event = (tool: string, payload: unknown) =>
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          server: 'sdlc',
          tool,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        },
      });
    const jsonl = [
      event('sdlc_start', { runId: 'run-1', status: 'running', attempt: 0 }),
      event('sdlc_verify', { runId: 'run-1', status: 'repairing', attempt: 1 }),
      event('sdlc_verify', { runId: 'run-1', status: 'needs_review', attempt: 2 }),
    ].join('\n');
    expect(parseHarnessState(jsonl)).toEqual({ runId: 'run-1', status: 'needs_review', attempt: 2 });
  });

  it('accepts structured review findings and explicit no-finding prose', () => {
    const review = {
      summary: 'A nested case is missing.',
      findings: [
        {
          id: 'R1',
          severity: 'high',
          file: 'src/rule.ts',
          line: 10,
          description: 'Nested elements remain incorrect.',
          correction: 'Handle the ancestor case.',
          criterionId: null,
        },
      ],
    };
    expect(parseNativeReviewOutput(JSON.stringify(review))).toEqual(review);
    expect(parseNativeReviewOutput('No regressions are evident in the diff.')).toEqual({
      summary: 'No regressions are evident in the diff.',
      findings: [],
    });
    expect(() => parseNativeReviewOutput('The nested case is broken.')).toThrow(
      'Native review did not return structured findings',
    );
  });
});
