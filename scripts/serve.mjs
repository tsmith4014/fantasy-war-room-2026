import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3] ?? 4173);
const prefix = "/fantasy-war-room-2026/";
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
]);

if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be an integer from 1024 to 65535.");

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/" || url.pathname === prefix.slice(0, -1)) {
      response.writeHead(302, { Location: prefix });
      response.end();
      return;
    }
    if (!url.pathname.startsWith(prefix)) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const relative = decodeURIComponent(url.pathname.slice(prefix.length)) || "index.html";
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Invalid path");
    const data = await fs.readFile(target);
    response.writeHead(200, {
      "Content-Type": mime.get(path.extname(target)) ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(data);
  } catch (error) {
    const status = error?.code === "ENOENT" || error?.code === "EISDIR" ? 404 : 400;
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(status === 404 ? "Not found" : "Bad request");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Serving ${root} at http://127.0.0.1:${port}${prefix}`);
});
