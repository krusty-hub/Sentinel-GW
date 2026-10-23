import http from 'node:http';

export function createMockUpstreamServer(port: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });

      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Mock-Upstream': 'true',
        });
        res.end(
          JSON.stringify({
            status: 'success',
            received_url: req.url,
            received_method: req.method,
            body: body ? JSON.parse(body) : undefined,
          })
        );
      });
    });

    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith('upstream.ts')) {
  const port = parseInt(process.env.PORT || '4000', 10);
  createMockUpstreamServer(port).then(() => {
    console.log(`[Mock Upstream] Running on port ${port}`);
  });
}
