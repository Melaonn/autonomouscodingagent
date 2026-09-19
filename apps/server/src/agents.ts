import type { AgentResult, Backend, JobResult, Run } from '../../../shared/types.js';
import type { z } from 'zod';
import type { Runner } from './runner.js';
export function textFrom(result: JobResult, backend: Backend) {
  let text = '';
  for (const line of result.stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (backend === 'codex' && event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text || text;
    } catch { /* streamed tools may write non-JSON diagnostics */ }
  }
  return text || result.stdout;
}
export function jsonFrom(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { /* find a complete trailing object */ }
  for (let start = cleaned.indexOf('{'); start >= 0; start = cleaned.indexOf('{', start + 1)) {
    try { return JSON.parse(cleaned.slice(start)); } catch { /* continue */ }
  }
  throw new Error('Agent did not return a JSON object');
}
export class Agents {
  constructor(private runner: Runner) {}
  async structured<T>(run: Run, backend: Backend, phase: string, prompt: string, schema: z.ZodType<T>, timeoutSeconds = run.limits.agentMinutes * 60): Promise<{ value: T; result: AgentResult }> {
    let correction = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const job = await this.runner.agent({ runId: run.id, backend, phase, timeoutSeconds, prompt: `${prompt}\n\nReturn only a valid JSON object. Do not wrap it in Markdown.${correction}` });
      const result: AgentResult = { exitCode: job.exitCode, logs: `${job.stderr}\n${job.stdout}`, text: textFrom(job, backend), usage: { inputTokens: 0, outputTokens: 0, costUsd: null } };
      if (job.exitCode) throw new Error(`${backend} ${phase} failed with exit ${job.exitCode}: ${job.stderr.slice(-1000)}`);
      try { const raw = jsonFrom(result.text); const value = schema.parse(raw); result.structured = value; return { value, result }; }
      catch (error) { correction = `\nYour prior response failed schema validation: ${error instanceof Error ? error.message : String(error)}. Return a corrected complete JSON object.`; }
    }
    throw new Error(`${backend} returned invalid structured output twice`);
  }
  async implement(run: Run, prompt: string) {
    const result = await this.runner.agent({ runId: run.id, backend: run.backend, phase: 'coding', timeoutSeconds: run.limits.agentMinutes * 60,
      prompt: `${prompt}\n\nImplement the requested change in the repository. Inspect existing code first. Do not modify .github/workflows or .sdlc. Run focused checks where useful. Do not claim the task is verified; the control plane makes that decision.` });
    if (result.exitCode) throw new Error(`Implementation agent failed with exit ${result.exitCode}: ${result.stderr.slice(-1000)}`);
    return result;
  }
}
