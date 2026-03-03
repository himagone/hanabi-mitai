import { createServer } from 'node:http';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler } from './handler.js';

const PORT = 3001;

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/api/analyze' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const event = {
          body,
          requestContext: { http: { method: 'POST' } },
        } as APIGatewayProxyEventV2;

        const result = await handler(event);
        const statusCode = typeof result === 'object' && 'statusCode' in result
          ? (result.statusCode ?? 200)
          : 200;
        const responseBody = typeof result === 'object' && 'body' in result
          ? result.body
          : JSON.stringify(result);

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Local API server running at http://localhost:${PORT}`);
  console.log(`POST http://localhost:${PORT}/api/analyze`);
});
