import { analyze, scorePoint } from './index.js';

export type WorkerRequest =
  | { kind: 'analyze'; payload: Parameters<typeof analyze>[0] }
  | { kind: 'score-point'; payload: Parameters<typeof scorePoint>[0] };

// 並列に処理しないのは、建物・土地利用のキャッシュがモジュール変数で、
// 2件の要求が交互に進むと互いの取得結果を上書きするため
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { kind, payload } = e.data;
  const [reply] = e.ports;
  queue = queue.then(async () => {
    try {
      const result = kind === 'analyze' ? await analyze(payload) : await scorePoint(payload);
      reply.postMessage({ result });
    } catch (err) {
      reply.postMessage({ error: err instanceof Error ? err.message : '処理でエラーが発生しました' });
    }
  });
};
