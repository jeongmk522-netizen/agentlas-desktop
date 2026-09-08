"use strict";
/*
 * 빌드된 화면(dist/renderer)을 정적으로 띄우는 공용 조각.
 *
 * ★같은 서버 코드를 도구마다 복사해 왔는데, 그중 하나에서 "없는 파일에 스트림을 열면
 *   서버가 통째로 죽는다" 를 고친 적이 있다. 사본은 그 수리를 못 받는다. 그래서 하나로.
 */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

function resolveDistDir(root) {
  return process.env.UI_QA_DIST ? path.resolve(process.env.UI_QA_DIST) : path.join(root, "dist", "renderer");
}

function resolveAsset(distDir, rawUrl) {
  let p = decodeURIComponent((rawUrl || "/").split("?")[0]);
  const nested = p.match(/^\/.+\/(_next\/.+)$/);
  if (nested) p = `/${nested[1]}`;
  if (p === "/") p = "/index.html";
  const direct = path.join(distDir, p.replace(/^\//, ""));
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!path.extname(p)) {
    const html = path.join(distDir, `${p.replace(/^\//, "")}.html`);
    if (fs.existsSync(html)) return html;
  }
  return path.join(distDir, "404.html");
}

function startStaticRenderer(distDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = resolveAsset(distDir, req.url);
      // 없는 것은 404 로 답하고 계속한다 — 공유 체크아웃에서 dist 가 순회 도중 다시 만들어진다.
      if (!fs.existsSync(file)) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      const stream = fs.createReadStream(file);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** 빌드된 모든 화면(또는 고른 몇 개). */
function builtScreens(distDir) {
  return fs.readdirSync(distDir, { recursive: true })
    .filter((name) => typeof name === "string" && name.endsWith(".html") && !name.startsWith("404"))
    .map((name) => ({ label: name.replace(/\.html$/, ""), url: `/${name}`, wait: "body" }));
}

module.exports = { MIME, resolveDistDir, resolveAsset, startStaticRenderer, builtScreens };
