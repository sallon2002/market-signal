// 미리보기용 아주 작은 정적 서버: node tools/serve.js [포트]
// 시작할 때 거시 지표를 한 번 모으고, 켜져 있는 동안 30분마다 다시 모은다.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const root = path.join(__dirname, "..");
const port = Number(process.argv[2]) || 4180;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const collect = () => execFile(process.execPath, [path.join(__dirname, "collect.js")], (err, out, errOut) => console.log(err ? errOut : out.trim()));
collect();
setInterval(collect, 30 * 60 * 1000);

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(root, url === "/" ? "index.html" : url);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end("not found");
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  })
  .listen(port, () => console.log(`http://localhost:${port}`));
