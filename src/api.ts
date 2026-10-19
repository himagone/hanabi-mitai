import type { AnalyzeRequest, AnalyzeResponse, ScorePointRequest, ScorePointResponse } from './types.js';
import type { WorkerRequest } from './analysis/worker.js';

const worker = new Worker(new URL('./analysis/worker.ts', import.meta.url), { type: 'module' });

function call<T>(request: WorkerRequest): Promise<T> {
  const { port1, port2 } = new MessageChannel();
  worker.postMessage(request, [port2]);
  return new Promise<T>((resolve, reject) => {
    port1.onmessage = ({ data }) => (data.error !== undefined ? reject(new Error(data.error)) : resolve(data.result));
  });
}

export function analyzePosition(request: AnalyzeRequest): Promise<AnalyzeResponse> {
  return call({ kind: 'analyze', payload: request });
}

export function scorePoint(request: ScorePointRequest): Promise<ScorePointResponse> {
  return call({ kind: 'score-point', payload: request });
}
