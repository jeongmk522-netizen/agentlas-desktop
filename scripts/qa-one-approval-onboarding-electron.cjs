#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
const targetUrl = process.env.AGENTLAS_APPROVAL_QA_URL || "http://127.0.0.1:3100";
const expectBroken = process.argv.includes("--expect-broken");
const outputDir = path.join(os.tmpdir(), "agentlas-one-approval-onboarding-electron");

function startOriginProbe() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end("<!doctype html><title>Agentlas origin probe</title><main>origin probe</main>");
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      origin: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

async function requestApproval(desktop, timeoutMs) {
  return desktop.evaluate(async (_electron, requestedTimeoutMs) => {
    const path = process.getBuiltinModule("node:path");
    const { createRequire } = process.getBuiltinModule("node:module");
    const requireFromMain = createRequire(path.join(process.cwd(), "dist/electron/main.js"));
    const approvals = requireFromMain("./runtime/tool-approval.js");
    void approvals.requestToolApproval({
      sessionKey: `qa-session-${Date.now()}`,
      runtime: "codex",
      tool: "permission-escalation",
      detail: "QA reversible approval surface probe",
      cwd: process.cwd(),
      timeoutMs: requestedTimeoutMs,
    });
    return approvals.listPendingToolApprovals().at(-1);
  }, timeoutMs);
}

async function clearApprovals(desktop) {
  await desktop.evaluate(async () => {
    const path = process.getBuiltinModule("node:path");
    const { createRequire } = process.getBuiltinModule("node:module");
    const requireFromMain = createRequire(path.join(process.cwd(), "dist/electron/main.js"));
    const approvals = requireFromMain("./runtime/tool-approval.js");
    for (const request of approvals.listPendingToolApprovals()) {
      approvals.resolveToolApproval(request.id, "deny");
    }
  });
}

async function dismissTerminalCards(page) {
  await page.waitForTimeout(100);
  const buttons = page.locator('[data-testid="tool-approval-outcome"] button');
  for (let index = (await buttons.count()) - 1; index >= 0; index -= 1) {
    await buttons.nth(index).click().catch(() => undefined);
  }
}

async function inspectBadge(page) {
  return page.locator('[data-testid="tool-approval-badge"]').evaluate((badge) => {
    const rect = badge.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const top = document.elementFromPoint(x, y);
    const pill = badge.querySelector(":scope > button");
    const overlaps = (left, right) => (
      left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top
    );
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      badge: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      topTag: top?.tagName ?? null,
      topClass: typeof top?.className === "string" ? top.className : null,
      topTestId: top?.closest?.("[data-testid]")?.getAttribute("data-testid") ?? null,
      badgeOwnsPoint: Boolean(top && badge.contains(top)),
      pillText: pill?.textContent?.trim() ?? null,
      pillColor: pill ? getComputedStyle(pill).color : null,
      overlappedButtons: [...document.querySelectorAll('[aria-labelledby="work-onboarding-title"] button, [aria-labelledby="work-onboarding-title"] h1, [aria-labelledby="work-onboarding-title"] input')]
        .filter((button) => !badge.contains(button) && button.getClientRects().length > 0)
        .filter((button) => overlaps(rect, button.getBoundingClientRect()))
        .map((button) => (button.getAttribute("aria-label") || button.textContent || "").trim().slice(0, 80)),
    };
  });
}

async function findDashboardWindow(desktop, timeout = 60_000, origin = targetUrl) {
  const deadline = Date.now() + timeout;
  const seenUrls = new Set();
  while (Date.now() < deadline) {
    for (const candidate of desktop.windows()) {
      if (candidate.isClosed()) continue;
      try {
        seenUrls.add(candidate.url());
        if (candidate.url().startsWith(origin)) {
          await candidate.waitForFunction(() => Boolean(window.agentlas), null, { timeout: 1_000 });
          return candidate;
        }
      } catch {
        // Startup replaces its placeholder renderer. Re-scan until the Main bridge is stable.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Electron did not expose a stable dashboard renderer window; saw ${JSON.stringify([...seenUrls])}`);
}

async function waitForDashboardElement(desktop, selector, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const page = await findDashboardWindow(desktop, Math.min(5_000, deadline - Date.now()));
      await page.locator(selector).waitFor({ state: "visible", timeout: Math.min(3_000, deadline - Date.now()) });
      return page;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Timed out waiting for ${selector}`);
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-approval-qa-"));
  fs.mkdirSync(outputDir, { recursive: true });
  let desktop;
  let originProxy;
  const launch = (origin = targetUrl) => electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env,
      AGENTLAS_E2E: "1",
      AGENTLAS_E2E_AUTH: "1",
      AGENTLAS_ALLOW_MULTI_INSTANCE: "1",
      AGENTLAS_QA_USER_DATA_DIR: userData,
      AGENTLAS_STORE_PATH: path.join(userData, "agentlas.sqlite"),
      NODE_ENV: "development",
      ELECTRON_START_URL: `${origin}/dashboard`,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
    timeout: 30_000,
  });
  try {
    desktop = await launch();
    let page = await waitForDashboardElement(desktop, '[aria-labelledby="work-onboarding-title"]');
    const approval = await requestApproval(desktop, 30_000);
    assert.ok(approval?.id, "Main must create a real pending approval");
    page = await waitForDashboardElement(desktop, '[data-testid="tool-approval-badge"]');
    const badge = page.locator('[data-testid="tool-approval-badge"]');
    const occlusion = await inspectBadge(page);
    await page.screenshot({ path: path.join(outputDir, "onboarding-approval-badge.png") });
    const viewportMatrix = [];
    if (!expectBroken) {
      for (const cell of [
        { width: 390, height: 844 },
        { width: 768, height: 820 },
        { width: 1024, height: 820 },
        { width: 1240, height: 820 },
      ]) {
        await page.setViewportSize(cell);
        await page.waitForTimeout(180);
        const measured = await inspectBadge(page);
        viewportMatrix.push(measured);
        assert.ok(measured.badge.left >= 0 && measured.badge.right <= measured.viewport.width,
          `badge must fit ${cell.width}px: ${JSON.stringify(measured)}`);
        assert.ok(measured.badge.top >= 0 && measured.badge.bottom <= measured.viewport.height,
          `badge must stay visible ${cell.width}px: ${JSON.stringify(measured)}`);
        assert.equal(measured.badgeOwnsPoint, true, `badge must own its point at ${cell.width}px`);
        assert.ok(measured.pillText?.length, `badge label must remain present at ${cell.width}px`);
        assert.notEqual(measured.pillColor, "rgb(255, 255, 255)", `badge label must remain visible at ${cell.width}px`);
        assert.deepEqual(measured.overlappedButtons, [], `badge must not cover another control at ${cell.width}px`);
        await page.screenshot({ path: path.join(outputDir, `onboarding-approval-${cell.width}.png`) });
      }
    }
    let clickWorked = true;
    try {
      await badge.getByRole("button").click({ timeout: 1_500 });
    } catch {
      clickWorked = false;
    }

    if (expectBroken) {
      assert.equal(occlusion.badgeOwnsPoint, false, "expected the current onboarding defect to occlude the badge");
      assert.equal(clickWorked, false, "expected a real pointer click to be intercepted");
    } else {
      assert.equal(occlusion.badgeOwnsPoint, true, `badge is still occluded: ${JSON.stringify(occlusion)}`);
      assert.equal(clickWorked, true, "approval badge must accept a real pointer click during onboarding");
      await page.locator('[data-testid="tool-approval-card"]').waitFor({ timeout: 3_000 });
    }
    await clearApprovals(desktop);
    await dismissTerminalCards(page);

    let keyboard = null;
    if (!expectBroken) {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      page = await waitForDashboardElement(desktop, '[aria-labelledby="work-onboarding-title"]');
      await requestApproval(desktop, 30_000);
      page = await waitForDashboardElement(desktop, '[data-testid="tool-approval-badge"]');
      const trigger = page.locator('[data-testid="tool-approval-badge"] > button');
      await trigger.focus();
      const focused = await trigger.evaluate((button) => document.activeElement === button);
      await page.keyboard.press("Enter");
      await page.locator('[data-testid="tool-approval-card"]').waitFor({ timeout: 3_000 });
      keyboard = { focused, enterOpenedCard: true };
      assert.equal(focused, true, "approval badge must receive keyboard focus above onboarding");
      await clearApprovals(desktop);
      await dismissTerminalCards(page);

      const close = page.getByRole("button", { name: /나중에 보기|Later/ });
      await close.click();
      const search = page.locator("#onboarding-site-search");
      await search.waitFor({ timeout: 10_000 });
      await search.focus();
      await page.keyboard.insertText("노션");
      assert.equal(await search.inputValue(), "노션", "Korean IME text must remain in the onboarding search field");
      assert.ok(await page.locator('[aria-labelledby="work-onboarding-title"]').isVisible(), "IME input must not advance onboarding");
      await close.click();
      await page.locator('[aria-labelledby="work-onboarding-title"]').waitFor({ state: "detached", timeout: 10_000 });
      assert.equal(await page.evaluate(() => window.localStorage.getItem("agentlas.work.firstRunOnboarding.v3")), "1");
    }

    if (expectBroken) await page.evaluate(() => {
      window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
      window.localStorage.removeItem("agentlas.work.firstRunOnboarding.v3.phase");
    });
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    page = await findDashboardWindow(desktop);
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);

    let persistence = null;
    if (!expectBroken) {
      const sameOriginReentry = !(await page.locator('[aria-labelledby="work-onboarding-title"]').isVisible().catch(() => false));
      await page.goto(`${targetUrl}/one`, { waitUntil: "domcontentloaded" });
      const productMenu = page.getByRole("button", { name: /Agentlas One/ }).first();
      await productMenu.waitFor({ timeout: 30_000 });
      await productMenu.click();
      await page.getByRole("menuitem").filter({ hasText: /Work/ }).click();
      await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 30_000 });
      await page.waitForTimeout(750);
      const sameOriginModeSwitch = !(await page.locator('[aria-labelledby="work-onboarding-title"]').isVisible().catch(() => false));
      await desktop.close();
      originProxy = await startOriginProbe();
      const alternateOrigin = originProxy.origin;
      desktop = await launch(alternateOrigin);
      page = await findDashboardWindow(desktop, 60_000, alternateOrigin);
      const changedDevOriginHasNoCompletionFlag = await page.evaluate(() => (
        window.localStorage.getItem("agentlas.work.firstRunOnboarding.v3") === null
      ));
      await desktop.close();
      desktop = await launch();
      page = await findDashboardWindow(desktop);
      await page.waitForTimeout(750);
      const fullRestartSameProfile = !(await page.locator('[aria-labelledby="work-onboarding-title"]').isVisible().catch(() => false));
      const originalOriginRemainsComplete = fullRestartSameProfile;
      persistence = { sameOriginReentry, sameOriginModeSwitch, changedDevOriginHasNoCompletionFlag, originalOriginRemainsComplete, fullRestartSameProfile };
      assert.deepEqual(persistence, {
        sameOriginReentry: true,
        sameOriginModeSwitch: true,
        changedDevOriginHasNoCompletionFlag: true,
        originalOriginRemainsComplete: true,
        fullRestartSameProfile: true,
      });
    }

    const expiring = await requestApproval(desktop, 1_200);
    assert.ok(expiring?.id, "Main must create an expiring approval");
    page = await waitForDashboardElement(desktop, '[data-testid="tool-approval-badge"]');
    await page.locator('[data-testid="tool-approval-badge"] button').click();
    await page.locator('[data-testid="tool-approval-card"]').waitFor({ timeout: 5_000 });
    await page.locator('[data-testid="tool-approval-outcome"]').waitFor({ timeout: 5_000 });
    const expiry = await page.evaluate(() => ({
      outcome: document.querySelector('[data-testid="tool-approval-outcome"]')?.textContent ?? "",
      choices: document.querySelectorAll('[data-testid="tool-approval-card"] [data-ask-option]').length,
      expiredState: document.querySelector('[data-testid="tool-approval-card"]')?.getAttribute("data-approval-state"),
    }));
    await page.screenshot({ path: path.join(outputDir, "expired-approval-card.png") });

    if (expectBroken) {
      assert.ok(expiry.choices > 0, "expected stale-looking choices to remain on the expired card");
    } else {
      assert.equal(expiry.choices, 0, "expired approval must not retain dead action choices");
      assert.equal(expiry.expiredState, "expired", "expired approval must expose an explicit terminal visual state");
    }

    console.log(JSON.stringify({ expectBroken, occlusion, viewportMatrix, clickWorked, keyboard, persistence, expiry, outputDir }, null, 2));
  } finally {
    if (desktop) await desktop.close().catch(() => undefined);
    if (originProxy) {
      originProxy.server.closeAllConnections?.();
      await new Promise((resolve) => originProxy.server.close(resolve));
    }
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
