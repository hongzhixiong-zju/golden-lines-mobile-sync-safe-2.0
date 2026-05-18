const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT || 5174);
const host = process.env.HOST || '127.0.0.1';
const root = path.resolve(__dirname, 'dist');
const types = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((request, response) => {
  let pathname = decodeURIComponent((request.url || '/').split('?')[0]);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const filePath = path.join(root, pathname);

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end('forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(root, 'index.html'), (fallbackError, fallbackData) => {
        if (fallbackError) {
          response.writeHead(404);
          response.end('not found');
          return;
        }
        response.writeHead(200, { 'Content-Type': types['.html'] });
        response.end(fallbackData);
      });
      return;
    }

    response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
    response.end(data);
  });
});

server.listen(port, host, () => {
  console.log(`Serving ${root} at http://${host}:${port}/`);
});
