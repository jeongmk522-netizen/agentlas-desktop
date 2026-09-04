#!/usr/bin/env node
"use strict";

const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
const rendererDist = path.join(root, "dist", "renderer");
const mainBundlePath = path.join(root, "dist", "electron", "main.js");
const mainHandlerSource = 'electron_1.ipcMain.handle("productExtensions:scienceSuiteStatus", () => (0, science_1.scienceSuiteStatus)());';
const instrumentedMainHandlerSource = `electron_1.app.__agentlasScienceOptionalTrace = { calls: [] };
electron_1.ipcMain.handle("productExtensions:scienceSuiteStatus", async () => {
    const startedAt = performance.now();
    const mode = process.env.AGENTLAS_QA_SCIENCE_STATUS_MODE || "actual";
    const processCountBefore = electron_1.app.getAppMetrics().length;
    const resourceTypesBefore = process.getActiveResourcesInfo?.() ?? [];
    const scienceViewsBefore = electron_1.BrowserWindow.getAllWindows().reduce((count, window) => count + window.contentView.children.filter((view) => /Science/i.test(view.webContents?.getTitle() || "")).length, 0);
    const originalFetch = globalThis.fetch;
    let mainNetworkCalls = 0;
    if (typeof originalFetch === "function") globalThis.fetch = (...args) => {
        mainNetworkCalls += 1;
        return originalFetch(...args);
    };
    const measurement = () => {
        const after = process.getActiveResourcesInfo?.() ?? [];
        const beforeCounts = new Map();
        for (const type of resourceTypesBefore) beforeCounts.set(type, (beforeCounts.get(type) || 0) + 1);
        const activeResourceDelta = [];
        for (const type of after) {
            const remaining = beforeCounts.get(type) || 0;
            if (remaining > 0) beforeCounts.set(type, remaining - 1);
            else activeResourceDelta.push(type);
        }
        return {
            mainNetworkCalls,
            processCountBefore,
            processCountAfter: electron_1.app.getAppMetrics().length,
            scienceViewsBefore,
            scienceViewsAfter: electron_1.BrowserWindow.getAllWindows().reduce((count, window) => count + window.contentView.children.filter((view) => /Science/i.test(view.webContents?.getTitle() || "")).length, 0),
            activeResourceDelta,
        };
    };
    try {
        if (mode === "failure") throw new Error("science-status-qa-failure");
        const result = mode === "installed"
            ? { id: "agentlas-science-suite", phase: "installed", installed: true, enabled: true, totalPackageBytes: 0, components: [] }
            : (0, science_1.scienceSuiteStatus)();
        electron_1.app.__agentlasScienceOptionalTrace.calls.push({ channel: "productExtensions:scienceSuiteStatus", ok: true, phase: result?.phase ?? null, durationMs: performance.now() - startedAt, ...measurement() });
        return result;
    }
    catch (error) {
        electron_1.app.__agentlasScienceOptionalTrace.calls.push({ channel: "productExtensions:scienceSuiteStatus", ok: false, error: error instanceof Error ? error.message : String(error), durationMs: performance.now() - startedAt, ...measurement() });
        throw error;
    }
    finally {
        if (typeof originalFetch === "function") globalThis.fetch = originalFetch;
    }
});`;
let targetUrl = process.env.AGENTLAS_SCIENCE_OPTIONAL_QA_URL || "";
const expectBroken = process.argv.includes("--expect-broken");
const skipBuild = process.argv.includes("--skip-build");
const outputDir = path.join(os.tmpdir(), "agentlas-science-optional-boundary-electron");

function buildCurrentSources() {
  if (skipBuild) return;
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["run", "build:electron"], { cwd: root, env: process.env, stdio: "inherit" });
  execFileSync(npm, ["run", "build:renderer"], { cwd: root, env: process.env, stdio: "inherit" });
}

function rendererAsset(rawUrl) {
  const pathname = decodeURIComponent(new URL(rawUrl || "/", "http://127.0.0.1").pathname);
  const nestedNext = pathname.match(/^\/.+\/(_next\/.+)$/);
  const relative = (nestedNext ? nestedNext[1] : pathname.replace(/^\/+/, "")) || "index.html";
  if (relative.split("/").some((segment) => segment === "..")) return path.join(rendererDist, "404.html");
  const direct = path.join(rendererDist, relative);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!path.extname(relative)) {
    const html = path.join(rendererDist, `${relative}.html`);
    if (fs.existsSync(html) && fs.statSync(html).isFile()) return html;
  }
  return path.join(rendererDist, "404.html");
}

function startRendererServer() {
  assert.ok(fs.existsSync(path.join(rendererDist, "dashboard.html")), "renderer build is missing dashboard.html");
  assert.ok(fs.existsSync(path.join(rendererDist, "one.html")), "renderer build is missing one.html");
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const file = rendererAsset(request.url);
      const mime = {
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".ico": "image/x-icon",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".txt": "text/plain; charset=utf-8",
        ".webp": "image/webp",
        ".woff2": "font/woff2",
      };
      response.writeHead(path.basename(file) === "404.html" ? 404 : 200, {
        "cache-control": "no-store",
        "content-type": mime[path.extname(file)] || "application/octet-stream",
      });
      fs.createReadStream(file).pipe(response);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function closeRendererServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function instrumentMainBundle() {
  const original = fs.readFileSync(mainBundlePath, "utf8");
  assert.ok(original.includes(mainHandlerSource), "compiled Science suite handler changed; rebuild or update the QA hook");
  fs.writeFileSync(mainBundlePath, original.replace(mainHandlerSource, instrumentedMainHandlerSource));
  return () => fs.writeFileSync(mainBundlePath, original);
}

  async function findRenderer(desktop, pathname, timeoutMs = 60_000) {
    assert.ok(targetUrl, "renderer server URL must be initialized before Electron launch");
    const deadline = Date.now() + timeoutMs;
    let seen = [];
    while (Date.now() < deadline) {
      seen = [];
      for (const page of desktop.windows()) {
        if (page.isClosed()) continue;
        try {
          const url = new URL(page.url());
          seen.push(url.href);
          if (url.origin === new URL(targetUrl).origin && url.pathname === pathname) {
            await page.waitForFunction(() => Boolean(window.agentlas), null, { timeout: 1_000 });
            return page;
          }
        } catch {
          // Startup replaces its placeholder renderer. Keep scanning.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`renderer ${pathname} did not become ready; saw ${JSON.stringify(seen)}`);
  }

  async function trace(desktop) {
    return desktop.evaluate(({ app }) => structuredClone(app.__agentlasScienceOptionalTrace));
  }

  async function waitForTrace(desktop, minimum, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await trace(desktop);
      if (current.calls.length >= minimum) return current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return trace(desktop);
  }

  async function launch(mode) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), `agentlas-science-optional-${mode}-`));
    const extensionRoot = path.join(userData, "extension-packages");
    fs.mkdirSync(extensionRoot, { recursive: true });
    const restoreMainBundle = instrumentMainBundle();
    try {
      const desktop = await electron.launch({
        args: [root, `--user-data-dir=${userData}`],
        cwd: root,
        env: {
          ...process.env,
          AGENTLAS_QA_SCIENCE_STATUS_MODE: mode,
          AGENTLAS_E2E: "1",
          AGENTLAS_E2E_AUTH: "1",
          AGENTLAS_ALLOW_MULTI_INSTANCE: "1",
          AGENTLAS_QA_USER_DATA_DIR: userData,
          AGENTLAS_STORE_PATH: path.join(userData, "agentlas.sqlite"),
          AGENTLAS_PRODUCT_EXTENSION_ROOT_DIR: extensionRoot,
          AGENTLAS_DISABLE_RUNTIME_PROBES: "1",
          AGENTLAS_DISABLE_DAEMON: "1",
          NODE_ENV: "development",
          ELECTRON_START_URL: `${targetUrl}/dashboard`,
          ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        },
        timeout: 30_000,
      });
      return { desktop, userData, extensionRoot, restoreMainBundle };
    } catch (error) {
      restoreMainBundle();
      throw error;
    }
  }

  async function prepareDashboard(run) {
    const page = await findRenderer(run.desktop, "/dashboard");
    await page.evaluate(() => {
      window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
      window.localStorage.removeItem("agentlas.work.firstRunOnboarding.v3.phase");
    });
    await page.locator(".sidenav").waitFor({ state: "visible", timeout: 30_000 });
    const later = page.getByRole("button", { name: /나중에 보기|Later/ });
    for (let attempt = 0; attempt < 2 && await later.isVisible().catch(() => false); attempt += 1) {
      await later.click();
      await page.waitForTimeout(80);
    }
    return page;
  }

  async function inspect(page) {
    return page.evaluate(() => {
      const nav = document.querySelector(".sidenav");
      const rect = nav?.getBoundingClientRect();
      const scienceLabels = [...document.querySelectorAll("button, [role=menuitem]")]
        .filter((node) => /Science/i.test(node.textContent || "") || /Science/i.test(node.getAttribute("aria-label") || ""))
        .map((node) => (node.getAttribute("aria-label") || node.textContent || "").trim());
      return {
        pathname: window.location.pathname,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        nav: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
        canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        updateCards: document.querySelectorAll(".sidenav-update-card").length,
        alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => (node.textContent || "").trim()),
        workVisible: document.body.innerText.includes("Agentlas Work"),
        scienceLabels,
      };
    });
  }

  async function openModeMenu(page) {
    const trigger = page.getByRole("button", { name: /Agentlas (?:One|Work)/ }).first();
    await trigger.click();
    await page.getByRole("menu").waitFor({ state: "visible", timeout: 5_000 });
  }

  async function runActual() {
    const run = await launch("actual");
    try {
      let page = await prepareDashboard(run);
      const initialTrace = await waitForTrace(run.desktop, expectBroken ? 2 : 1);
      const initial = await inspect(page);
      const scienceFiles = fs.existsSync(path.join(run.userData, "extensions", "agentlas-science"))
        ? fs.readdirSync(path.join(run.userData, "extensions", "agentlas-science"))
        : [];
      assert.equal(initial.scienceLabels.length, 0, "uninstalled discovery-off Work must not expose Science");
      assert.equal(scienceFiles.includes("science.sqlite"), false, "Work must not initialize the Science store");
      if (expectBroken) {
        assert.ok(initialTrace.calls.length >= 2, `expected duplicate Work status IPC, got ${JSON.stringify(initialTrace)}`);
      } else {
        assert.equal(initialTrace.calls.length, 1, `Work must share one status query: ${JSON.stringify(initialTrace)}`);
        const probe = initialTrace.calls[0];
        assert.equal(probe.mainNetworkCalls, 0, "status probe must not perform Main network work");
        assert.equal(probe.processCountAfter, probe.processCountBefore, "status probe must not start a process");
        assert.equal(probe.scienceViewsAfter, probe.scienceViewsBefore, "status probe must not mount a Science view");
        assert.deepEqual(probe.activeResourceDelta, [], "status probe must not create an active runtime resource");
        assert.ok(probe.durationMs < 25, `status probe must stay cheap: ${probe.durationMs}ms`);
      }

      const viewports = [];
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 768, height: 820 },
        { width: 1024, height: 820 },
        { width: 1240, height: 820 },
      ]) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(100);
        const state = await inspect(page);
        assert.equal(state.scienceLabels.length, 0, `Science must stay hidden at ${viewport.width}px`);
        assert.equal(state.canScrollX, false, `Work must not gain horizontal page scroll at ${viewport.width}px`);
        assert.ok(state.nav && state.nav.left >= 0 && state.nav.right <= viewport.width,
          `navigation must fit ${viewport.width}px: ${JSON.stringify(state.nav)}`);
        await page.screenshot({ path: path.join(outputDir, `uninstalled-work-${viewport.width}.png`) });
        viewports.push(state);
      }

      await openModeMenu(page);
      const one = page.getByRole("menuitem").filter({ hasText: /^One/ });
      await one.click();
      await page.waitForURL((url) => url.pathname === "/one", { timeout: 30_000 });
      await page.getByRole("button", { name: /Agentlas One/ }).first().waitFor({ timeout: 30_000 });
      await openModeMenu(page);
      await page.getByRole("menuitem").filter({ hasText: /^Work/ }).click();
      await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 30_000 });
      page = await findRenderer(run.desktop, "/dashboard");
      await page.locator(".sidenav").waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForTimeout(250);
      const afterCycle = await trace(run.desktop);
      if (!expectBroken) assert.equal(afterCycle.calls.length, 1, `One/Work remounts must reuse status: ${JSON.stringify(afterCycle)}`);
      return { initialTrace, afterCycle, scienceFiles, viewports };
    } finally {
      await run.desktop.close().catch(() => undefined);
      run.restoreMainBundle();
      fs.rmSync(run.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }

  async function runFailure() {
    const run = await launch("failure");
    try {
      const page = await prepareDashboard(run);
      const failedTrace = await waitForTrace(run.desktop, expectBroken ? 2 : 1);
      const state = await inspect(page);
      assert.equal(state.workVisible, true, "failed status IPC must leave Agentlas Work visible");
      assert.equal(state.scienceLabels.length, 0, "failed status IPC must not expose Science");
      assert.equal(state.updateCards, 0, "failed Science status must not create an updater card");
      assert.deepEqual(state.alerts, [], "failed Science status must not create a Work alert");
      await openModeMenu(page);
      assert.equal(await page.getByRole("menuitem").filter({ hasText: /^One/ }).count(), 1,
        "failed status IPC must leave One navigation usable");
      if (!expectBroken) assert.equal(failedTrace.calls.length, 1, `status failure must be shared: ${JSON.stringify(failedTrace)}`);
      return { failedTrace, state };
    } finally {
      await run.desktop.close().catch(() => undefined);
      run.restoreMainBundle();
      fs.rmSync(run.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }

  async function runInstalled() {
    const run = await launch("installed");
    try {
      const page = await prepareDashboard(run);
      const installedTrace = await waitForTrace(run.desktop, expectBroken ? 2 : 1);
      await page.getByRole("button", { name: /Agentlas Science 열기|Open Agentlas Science/ }).waitFor({ timeout: 10_000 });
      await openModeMenu(page);
      const scienceMenuItem = page.getByRole("menuitem").filter({ hasText: /^Science/ });
      assert.equal(await scienceMenuItem.count(), 1, "installed users must retain the Science product-menu entry");
      assert.match(await scienceMenuItem.innerText(), /Science/);
      if (!expectBroken) assert.equal(installedTrace.calls.length, 1, `installed status must be shared: ${JSON.stringify(installedTrace)}`);
      return { installedTrace };
    } finally {
      await run.desktop.close().catch(() => undefined);
      run.restoreMainBundle();
      fs.rmSync(run.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }

  async function main() {
    assert.match(
      fs.readFileSync(path.join(root, "renderer", "lib", "science-install-entry.ts"), "utf8"),
      /export const SCIENCE_INSTALL_DISCOVERY_ENABLED = false;/,
      "this QA requires Science install discovery to remain disabled",
    );
    buildCurrentSources();
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });
    let rendererServer = null;
    try {
      if (!targetUrl) {
        rendererServer = await startRendererServer();
        targetUrl = rendererServer.baseUrl;
      }
      const actual = await runActual();
      const failure = await runFailure();
      const installed = await runInstalled();
      console.log(JSON.stringify({
        expectBroken,
        discoveryEnabled: false,
        rendererOrigin: targetUrl,
        rendererServerOwned: Boolean(rendererServer),
        actual,
        failure,
        installed,
        outputDir,
      }, null, 2));
    } finally {
      await closeRendererServer(rendererServer?.server);
    }
  }

  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
