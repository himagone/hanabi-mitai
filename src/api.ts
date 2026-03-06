import type { AnalyzeRequest, AnalyzeResponse, ScorePointRequest, ScorePointResponse } from './types.js';

const API_BASE = import.meta.env.DEV
  ? '/api'
  : 'https://fl267a9ued.execute-api.ap-northeast-1.amazonaws.com/api';

export async function analyzePosition(
  request: AnalyzeRequest,
): Promise<AnalyzeResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (err) {
    throw new Error(
      `APIサーバーに接続できません。Lambda ローカルサーバー (port 3001) が起動しているか確認してください。` +
      (err instanceof Error ? `\n${err.message}` : ''),
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = `HTTP ${response.status}`;
    try {
      const json = JSON.parse(text);
      if (json.error) message = json.error;
    } catch {
      if (text) message += `: ${text.slice(0, 200)}`;
    }
    throw new Error(message);
  }

  return response.json();
}

export async function scorePoint(
  request: ScorePointRequest,
): Promise<ScorePointResponse> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/score-point`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (err) {
    throw new Error(
      `APIサーバーに接続できません。Lambda ローカルサーバー (port 3001) が起動しているか確認してください。` +
      (err instanceof Error ? `\n${err.message}` : ''),
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = `HTTP ${response.status}`;
    try {
      const json = JSON.parse(text);
      if (json.error) message = json.error;
    } catch {
      if (text) message += `: ${text.slice(0, 200)}`;
    }
    throw new Error(message);
  }

  return response.json();
}
