#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

if (process.env.AGENTLAS_CHAT_FILE_QA_SEED === "1") {
  const { app } = require("electron");
  const input = JSON.parse(process.env.AGENTLAS_CHAT_FILE_QA_INPUT || "{}");
  const userData = path.resolve(input.userData);
  app.setPath("userData", userData);
  app.whenReady().then(() => {
    const dbStore = require(path.join(root, "dist/electron/store/db.js"));
    dbStore.initStore({});
    require(path.join(root, "dist/electron/architecture/seed.js")).seedBuiltinAgents();
    const chats = require(path.join(root, "dist/electron/store/chats.js"));
    const access = require(path.join(root, "dist/electron/fs/access.js"));
    const attachments = require(path.join(root, "dist/electron/store/chat-message-attachments.js"));
    const make = (originSurface, title, paths) => {
      const chat = chats.createChat({ title, originSurface, taskMode: "conversation" });
      const files = paths.map((filePath) => {
        const stat = fs.lstatSync(filePath);
        const kind = stat.isDirectory() ? "directory" : "file";
        return {
          grant: access.grantPath(filePath, { durable: false, exactFile: kind === "file" }),
          name: path.basename(filePath),
          mediaType: kind === "directory" ? "application/vnd.agentlas.directory+json" : "application/octet-stream",
          size: kind === "file" ? stat.size : 0,
          kind,
        };
      });
      const snapshot = attachments.persistChatFileSnapshot({ chatId: chat.id, files });
      chats.appendChatMessage(chat.id, "user", `Review these local items.\n\n<!-- agentlas-chat-files:v1:${snapshot.groupId} -->`);
      chats.appendChatMessage(chat.id, "assistant", "The attached items remain bound to this conversation and open in the in-app file rail.");
      return { chat, snapshot };
    };
    const work = make("work", "Work file experience QA", input.workPaths);
    const one = make("one", "One file experience QA", input.onePaths);
    const simple = chats.createChat({ title: "One short answer QA", originSurface: "one", taskMode: "conversation" });
    chats.appendChatMessage(simple.id, "user", "Reply with one short line.");
    chats.appendChatMessage(simple.id, "assistant", "SHORT_INLINE_OK");
    chats.appendChatMessage(simple.id, "assistant", "SHORT_INLINE_FOLLOWUP");
    const taskforce = require(path.join(root, "dist/electron/one/taskforces.js")).createOneTaskforce({
      title: "One avatar Taskforce QA",
      description: "Renderer-only avatar grouping fixture",
      memberAgentIds: [],
    });
    chats.appendChatMessage(taskforce.chatId, "user", "Summarize in one line.");
    chats.appendChatMessage(taskforce.chatId, "assistant", "TASKFORCE_AVATAR_OK");
    const oneAttachments = require(path.join(root, "dist/electron/one/attachments.js"));
    fs.mkdirSync(path.resolve(input.runFolder), { recursive: true });
    const runFolder = fs.realpathSync.native(path.resolve(input.runFolder));
    const onePrompt = `Review these local items.\n\n<!-- agentlas-chat-files:v1:${one.snapshot.groupId} -->`;
    const onePrepared = oneAttachments.prepareOneAttachments({
      chatId: one.chat.id,
      userPrompt: onePrompt,
      attachments: input.onePaths.map((filePath) => {
        const stat = fs.lstatSync(filePath);
        return {
          grant: access.grantPath(filePath, { durable: false, exactFile: stat.isFile() }),
          displayName: path.basename(filePath),
          claimedMediaType: stat.isDirectory() ? "application/vnd.agentlas.directory+json" : "application/octet-stream",
          claimedSize: stat.isFile() ? stat.size : 0,
        };
      }),
    });
    const oneClaimed = oneAttachments.claimOneAttachments({
      ref: onePrepared.ref,
      chatId: one.chat.id,
      userPrompt: onePrompt,
      runId: `qa-file-${Date.now()}`,
      resultFolder: runFolder,
    });
    const folderClaim = { kinds: oneClaimed.receipt.attachments.map((item) => item.kind), totalBytes: oneClaimed.receipt.totalBytes, runtimeContextBound: oneClaimed.runtimeContext.includes("project folder") };
    oneAttachments.releaseOneAttachmentRun(onePrepared.ref);
    let collisionCode = null;
    try {
      const duplicate = input.workPaths[0];
      const stat = fs.statSync(duplicate);
      const grant = access.grantPath(duplicate, { durable: false, exactFile: true });
      attachments.persistChatFileSnapshot({
        chatId: work.chat.id,
        files: [0, 1].map(() => ({ grant, name: path.basename(duplicate), mediaType: "text/plain", size: stat.size, kind: "file" })),
      });
    } catch (error) {
      collisionCode = error?.code || null;
    }
    const probeCode = (filePath, kind = "file", mutate) => {
      try {
        const stat = fs.lstatSync(filePath);
        let grant = access.grantPath(filePath, { durable: false, exactFile: kind === "file" });
        if (mutate) grant = mutate(grant);
        attachments.persistChatFileSnapshot({ chatId: work.chat.id, files: [{ grant, name: path.basename(filePath), mediaType: "application/octet-stream", size: kind === "file" ? stat.size : 0, kind }] });
        return null;
      } catch (error) {
        return error?.code || null;
      }
    };
    const unsupportedCode = probeCode(input.unsupportedPath);
    const tooLargeCode = probeCode(input.largePath);
    const pathTooLongCode = probeCode(input.longFolderPath, "directory");
    const permissionCode = probeCode(input.workPaths[0], "file", (grant) => ({ ...grant, scope: { kind: "capability", token: crypto.randomUUID() } }));
    const missingGrant = access.grantPath(input.missingPath, { durable: false, exactFile: true });
    fs.unlinkSync(input.missingPath);
    let missingCode = null;
    try {
      attachments.persistChatFileSnapshot({ chatId: work.chat.id, files: [{ grant: missingGrant, name: "moved.txt", mediaType: "text/plain", size: 5, kind: "file" }] });
    } catch (error) {
      missingCode = error?.code || null;
    }
    chats.appendChatMessage(work.chat.id, "assistant", `[Missing file](${input.missingPath})`);
    process.stdout.write(`${JSON.stringify({ work, one, simple, taskforce, folderClaim, collisionCode, unsupportedCode, tooLargeCode, pathTooLongCode, permissionCode, missingCode })}\n`);
    app.quit();
  }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    app.exit(1);
  });
} else {
  const { _electron: electron } = require("playwright");
  const XLSX = require("styled-exceljs");

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-chat-files-qa-"));
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-chat-files-fixtures-"));
  const textPath = path.join(fixtures, "evidence note.txt");
  fs.writeFileSync(textPath, "Agentlas common file experience\n");
  const xlsxPath = path.join(fixtures, "portfolio.xlsx");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["asset", "value"], ["Agentlas", 42]]), "Evidence");
  fs.writeFileSync(xlsxPath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  const folderPath = path.join(fixtures, "project folder");
  fs.mkdirSync(path.join(folderPath, "nested"), { recursive: true });
  fs.writeFileSync(path.join(folderPath, "README.md"), "# Folder attachment\n");
  fs.writeFileSync(path.join(folderPath, "nested", "data.json"), "{\"ok\":true}\n");
  const unsupportedPath = path.join(fixtures, "unsupported.bin");
  fs.writeFileSync(unsupportedPath, "unsupported");
  const largePath = path.join(fixtures, "too-large.pdf");
  const largeFd = fs.openSync(largePath, "w");
  fs.ftruncateSync(largeFd, 65 * 1024 * 1024);
  fs.closeSync(largeFd);
  const missingPath = path.join(fixtures, "moved.txt");
  fs.writeFileSync(missingPath, "moved");
  const longFolderPath = path.join(fixtures, "long-folder");
  let longLeaf = longFolderPath;
  for (const suffix of ["a", "b", "c", "d"]) {
    longLeaf = path.join(longLeaf, `${suffix}-${"x".repeat(195)}`);
    fs.mkdirSync(longLeaf, { recursive: true });
  }
  fs.writeFileSync(path.join(longLeaf, "entry.txt"), "long path");

  const electronBinary = path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const seed = spawnSync(electronBinary, [__filename], {
    cwd: root,
    env: {
      ...process.env,
      AGENTLAS_CHAT_FILE_QA_SEED: "1",
      AGENTLAS_CHAT_FILE_QA_INPUT: JSON.stringify({ userData, runFolder: path.join(fixtures, "one-run"), workPaths: [textPath, xlsxPath], onePaths: [textPath, folderPath], unsupportedPath, largePath, missingPath, longFolderPath }),
      AGENTLAS_STORE_PATH: path.join(userData, "agentlas.sqlite"),
      AGENTLAS_E2E: "1",
      AGENTLAS_E2E_AUTH: "1",
      AGENTLAS_ALLOW_MULTI_INSTANCE: "1",
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (seed.status !== 0) throw new Error(seed.stderr || seed.stdout);
  const seeded = JSON.parse(seed.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
  assert.equal(seeded.collisionCode, "collision", "duplicate attachment collision must be explicit");
  assert.equal(seeded.unsupportedCode, "unsupported", "unsupported type must be explicit");
  assert.equal(seeded.tooLargeCode, "too_large", "large attachment must be explicit");
  assert.equal(seeded.pathTooLongCode, "path_too_long", "long folder path must be explicit");
  assert.equal(seeded.permissionCode, "permission", "permission failure must be explicit");
  assert.equal(seeded.missingCode, "missing", "moved or missing attachment must be explicit");
  assert.deepEqual(seeded.folderClaim.kinds, ["file", "directory"], "One must claim a file and folder without weakening the exact-grant boundary");
  assert.equal(seeded.folderClaim.runtimeContextBound, true, "One folder must be bound into the verified runtime context");

  const proofDir = path.join(root, "output", "playwright", "one-work-file-experience");
  fs.rmSync(proofDir, { recursive: true, force: true });
  fs.mkdirSync(proofDir, { recursive: true });
  const expectedSha = crypto.createHash("sha256").update(fs.readFileSync(xlsxPath)).digest("hex");

  const ownedElectronPids = () => {
    const marker = `--user-data-dir=${userData}`;
    const listed = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    if (listed.status !== 0) return [];
    return listed.stdout.split(/\r?\n/).flatMap((line) => {
      if (!line.includes(marker)) return [];
      const match = line.trim().match(/^(\d+)\s/);
      return match ? [Number(match[1])] : [];
    });
  };

  const stopOwnedElectronProcesses = () => {
    for (const pid of ownedElectronPids()) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
  };

  (async () => {
    let desktop;
    const errors = [];
    const measurements = [];
    try {
      desktop = await electron.launch({
        args: [root, `--user-data-dir=${userData}`],
        cwd: root,
        env: {
          ...process.env,
          AGENTLAS_STORE_PATH: path.join(userData, "agentlas.sqlite"),
          AGENTLAS_E2E: "1",
          AGENTLAS_E2E_AUTH: "1",
          AGENTLAS_ALLOW_MULTI_INSTANCE: "1",
          AGENTLAS_DISABLE_RUNTIME_PROBES: "1",
          AGENTLAS_DISABLE_DAEMON: "1",
          AGENTLAS_QA_SKIP_AGENT_MATERIALIZATION: "1",
          NODE_ENV: "development",
          ELECTRON_START_URL: `agentlas://app/one?chat=${encodeURIComponent(seeded.one.chat.id)}`,
          ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        },
        timeout: 60_000,
      });
      const page = await desktop.firstWindow({ timeout: 60_000 });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) errors.push(message.text());
      });
      const setSize = (width) => desktop.evaluate(({ BrowserWindow }, nextWidth) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setMinimumSize(320, 600);
        win.setSize(nextWidth, 820);
        win.show();
        win.focus();
      }, width);
      const measure = async (surface, width) => {
        await setSize(width);
        await page.waitForTimeout(180);
        const value = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: innerHeight }));
        assert.ok(value.scrollWidth <= value.width + 1, `${surface} overflows at ${width}px: ${JSON.stringify(value)}`);
        measurements.push({ surface, requestedWidth: width, ...value });
      };

      const waitForAppLocation = async (pathname, paramName, paramValue, timeout = 60_000) => {
        const deadline = Date.now() + timeout;
        let lastUrl = page.url();
        while (Date.now() < deadline) {
          if (page.isClosed()) throw new Error(`Electron application exited while waiting for ${pathname}`);
          lastUrl = page.url();
          try {
            const current = new URL(lastUrl);
            if (current.pathname === pathname && (!paramName || current.searchParams.get(paramName) === paramValue)) return;
          } catch { /* keep polling until the app commits a valid URL */ }
          await page.waitForTimeout(100);
        }
        throw new Error(`Timed out waiting for ${pathname}; last URL was ${lastUrl}`);
      };
      const navigateApp = async (target, pathname, paramName, paramValue) => {
        try {
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });
        } catch (error) {
          if (!/net::ERR_UNEXPECTED/.test(String(error?.message || error))) throw error;
        }
        await waitForAppLocation(pathname, paramName, paramValue);
      };

      await waitForAppLocation("/one", "chat", seeded.one.chat.id);
      await page.locator('[data-chat-file-cards="true"] button').first().waitFor({ timeout: 60_000 });
      await setSize(1240);
      await page.evaluate(() => {
        localStorage.setItem("agentlas.one.context-rail-width.v2", "200");
        localStorage.setItem("agentlas.one.context-rail-open.v2", "false");
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator('[data-chat-file-cards="true"] button').first().waitFor({ timeout: 60_000 });
      const oneEvidenceCard = page.locator('[data-chat-file-cards="true"] button').filter({ hasText: "evidence note.txt" }).first();
      await oneEvidenceCard.click();
      const oneRail = page.locator('[data-one-runtime-artifacts="true"]');
      await oneRail.waitFor({ state: "visible", timeout: 10_000 });
      await page.waitForFunction(() => {
        const rail = document.querySelector('[data-one-runtime-artifacts="true"]');
        return rail instanceof HTMLElement && rail.getBoundingClientRect().width >= 540;
      });
      await page.waitForTimeout(800);
      const oneReadable200 = await oneRail.boundingBox();
      assert.ok(oneReadable200 && oneReadable200.width >= 540, `One file view must temporarily widen a saved 200px rail: ${JSON.stringify(oneReadable200)}`);
      assert.equal(await page.evaluate(() => localStorage.getItem("agentlas.one.context-rail-width.v2")), "200", "One temporary file width must not overwrite a 200px preference");
      await page.screenshot({ path: path.join(proofDir, "one-file-readable-from-200.png"), fullPage: true });
      await page.locator('[data-chat-file-tabs="true"] button[aria-label*="닫기"], [data-chat-file-tabs="true"] button[aria-label^="Close"]').first().click();
      await page.waitForFunction(() => {
        const rail = document.querySelector('[data-one-runtime-artifacts="true"]');
        return rail instanceof HTMLElement && rail.getBoundingClientRect().width <= 202;
      });
      await page.evaluate(() => localStorage.setItem("agentlas.one.context-rail-width.v2", "324"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator('[data-chat-file-cards="true"] button').first().waitFor({ timeout: 60_000 });
      await oneEvidenceCard.click();
      await page.waitForFunction(() => {
        const rail = document.querySelector('[data-one-runtime-artifacts="true"]');
        return rail instanceof HTMLElement && rail.getBoundingClientRect().width >= 540;
      });
      await page.waitForTimeout(800);
      const oneReadable324 = await oneRail.boundingBox();
      assert.ok(oneReadable324 && oneReadable324.width >= 540, `One file view must temporarily widen a saved 324px rail: ${JSON.stringify(oneReadable324)}`);
      assert.equal(await page.evaluate(() => localStorage.getItem("agentlas.one.context-rail-width.v2")), "324", "One temporary file width must not overwrite a 324px preference");
      await page.screenshot({ path: path.join(proofDir, "one-file-readable-from-324.png"), fullPage: true });
      await page.locator('[data-chat-file-tabs="true"] button[aria-label*="닫기"], [data-chat-file-tabs="true"] button[aria-label^="Close"]').first().click();

      const oneCards = page.locator('[data-chat-file-cards="true"] button');
      assert.equal(await oneCards.count(), 2, "One must restore two attachment cards");
      const firstOneFileId = await oneCards.nth(0).getAttribute("data-chat-file-id");
      assert.ok(firstOneFileId, "One first attachment must expose a stable file id");
      await oneCards.nth(0).click();
      await oneCards.nth(1).click();
      await page.waitForFunction(() => document.querySelectorAll('[data-chat-file-tabs="true"] [role="tab"]').length === 2);
      assert.equal(await page.locator('[data-chat-file-tabs="true"] [role="tab"]').count(), 2, "One must open two file tabs");
      await oneCards.nth(0).click();
      await page.waitForFunction((fileId) => document.querySelector('[data-chat-file-viewer="true"]')?.getAttribute("data-chat-file-tab-id")?.endsWith(`:${fileId}`) === true, firstOneFileId);
      assert.equal(await page.locator('[data-chat-file-tabs="true"] [role="tab"]').count(), 2, "same One file must reactivate instead of duplicating");
      const oneTabId = await page.locator('[data-chat-file-viewer="true"]').getAttribute("data-chat-file-tab-id");
      assert.ok(oneTabId && oneTabId.includes(seeded.one.snapshot.groupId), "One tab id must retain the exact group binding");
      const oneViewerText = await page.locator('[data-chat-file-viewer="true"]').innerText();
      assert.ok(seeded.one.snapshot.files.some((file) => oneViewerText.includes(file.sha256)), `One viewer must expose the exact SHA-256: ${oneViewerText.slice(0, 600)}`);
      const tabs = page.locator('[data-chat-file-tabs="true"] [role="tab"]');
      await tabs.first().focus();
      await tabs.first().press("ArrowRight");
      assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true", "keyboard navigation must select the next file tab");
      const closeButtons = page.locator('[data-chat-file-tabs="true"] button[aria-label*="닫기"], [data-chat-file-tabs="true"] button[aria-label^="Close"]');
      await closeButtons.first().click();
      assert.equal(await page.locator('[data-chat-file-tabs="true"] [role="tab"]').count(), 1, "One file tab must close");
      await oneCards.nth(0).click();
      await page.waitForFunction(() => document.querySelectorAll('[data-chat-file-tabs="true"] [role="tab"]').length === 2);
      assert.equal(await page.locator('[data-chat-file-tabs="true"] [role="tab"]').count(), 2, "closed One file must reopen");

      const composer = page.locator('[data-drag-active] textarea').last();
      await composer.fill("조합 중");
      const messageCountBeforeIme = await page.locator("article").count();
      await composer.evaluate((element) => {
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "중" }));
        const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", isComposing: true });
        Object.defineProperty(event, "keyCode", { get: () => 229 });
        element.dispatchEvent(event);
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "중" }));
      });
      assert.equal(await page.locator("article").count(), messageCountBeforeIme, "IME composition Enter must not submit");
      await composer.evaluate((element) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(["drop"], "drop.txt", { type: "text/plain" }));
        const dock = element.closest('[data-drag-active]');
        if (!dock) throw new Error("One composer drop target is missing");
        const event = new Event("dragenter", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: transfer });
        dock.dispatchEvent(event);
      });
      await page.locator('[data-drag-active="true"], [data-chat-drop-overlay="true"]').first().waitFor({ state: "visible", timeout: 5_000 });
      await composer.evaluate((element) => {
        const dock = element.closest('[data-drag-active]');
        if (!dock) throw new Error("One composer drop target is missing");
        const event = new Event("dragleave", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: new DataTransfer() });
        dock.dispatchEvent(event);
      });
      for (const width of [390, 768, 1024, 1240]) await measure("one", width);
      await page.screenshot({ path: path.join(proofDir, "one.png"), fullPage: true });

      await page.evaluate(() => localStorage.setItem("agentlas.chat.right_panel_width", "320"));
      const workUrl = `agentlas://app/workspace/task?id=${encodeURIComponent(seeded.work.chat.id)}`;
      await navigateApp(workUrl, "/workspace/task", "id", seeded.work.chat.id);
      await page.locator('[data-chat-file-cards="true"] button').first().waitFor({ timeout: 60_000 });
      const workCards = page.locator('[data-chat-file-cards="true"] button');
      assert.equal(await workCards.count(), 2, "Work must restore two attachment cards");
      const workCloseButtons = page.locator('[data-chat-file-tabs="true"] button[aria-label*="닫기"], [data-chat-file-tabs="true"] button[aria-label^="Close"]');
      while (await workCloseButtons.count()) {
        const before = await workCloseButtons.count();
        await workCloseButtons.first().click();
        await page.waitForFunction((expected) => document.querySelectorAll('[data-chat-file-tabs="true"] button[aria-label*="닫기"], [data-chat-file-tabs="true"] button[aria-label^="Close"]').length < expected, before);
      }
      await page.waitForFunction(() => {
        const rail = document.querySelector(".chat-right-panel");
        return !(rail instanceof HTMLElement) || rail.getBoundingClientRect().width <= 322;
      });
      const workEvidenceCard = workCards.filter({ hasText: "evidence note.txt" }).first();
      await workEvidenceCard.click();
      const workRail = page.locator(".chat-right-panel");
      await workRail.waitFor({ state: "visible", timeout: 10_000 });
      await page.waitForFunction(() => {
        const rail = document.querySelector(".chat-right-panel");
        return rail instanceof HTMLElement && rail.getBoundingClientRect().width >= 440;
      });
      const workReadable320 = await workRail.boundingBox();
      assert.ok(workReadable320 && workReadable320.width >= 440, `Work file view must temporarily widen a saved 320px rail: ${JSON.stringify(workReadable320)}`);
      assert.equal(await page.evaluate(() => localStorage.getItem("agentlas.chat.right_panel_width")), "320", "Work temporary file width must not overwrite a 320px preference");
      const workComposerAlignment = await page.evaluate(() => {
        const folderRow = document.querySelector('[data-chat-folder-row="true"]');
        const composer = document.querySelector(".chat-input-shell");
        if (!(folderRow instanceof HTMLElement) || !(composer instanceof HTMLElement)) return null;
        return { folderLeft: folderRow.getBoundingClientRect().left, composerLeft: composer.getBoundingClientRect().left };
      });
      assert.ok(workComposerAlignment, "Work folder row and composer must both be rendered");
      assert.ok(Math.abs(workComposerAlignment.folderLeft - workComposerAlignment.composerLeft) <= 1, `Work folder row and composer left edges must align: ${JSON.stringify(workComposerAlignment)}`);
      await page.screenshot({ path: path.join(proofDir, "work-file-readable-from-320.png"), fullPage: true });
      while (await workCloseButtons.count()) {
        const before = await workCloseButtons.count();
        await workCloseButtons.first().click();
        await page.waitForFunction((expected) => document.querySelectorAll('[data-chat-file-tabs="true"] button[aria-label*="닫기"], [data-chat-file-tabs="true"] button[aria-label^="Close"]').length < expected, before);
      }
      await page.waitForFunction(() => {
        const rail = document.querySelector(".chat-right-panel");
        return rail instanceof HTMLElement && rail.getBoundingClientRect().width <= 322;
      });
      const initialWorkTabCount = await page.locator('[data-chat-file-tabs="true"] [role="tab"]').count();
      await workCards.nth(0).click();
      await page.waitForFunction((expected) => document.querySelectorAll('[data-chat-file-tabs="true"] [role="tab"]').length === expected, initialWorkTabCount + 1);
      await workCards.nth(1).click();
      await page.waitForFunction((expected) => document.querySelectorAll('[data-chat-file-tabs="true"] [role="tab"]').length === expected, initialWorkTabCount + 2);
      assert.equal(await page.locator('[data-chat-file-tabs="true"] [role="tab"]').count(), initialWorkTabCount + 2, "Work must open two file tabs");
      await workCards.nth(0).click();
      assert.equal(await page.locator('[data-chat-file-tabs="true"] [role="tab"]').count(), initialWorkTabCount + 2, "same Work file must reactivate instead of duplicating");
      await page.getByRole("link", { name: "Missing file" }).click();
      await page.locator('[data-file-unavailable="true"]').waitFor({ state: "visible", timeout: 10_000 });
      for (const width of [390, 768, 1024, 1240]) await measure("work", width);
      await page.screenshot({ path: path.join(proofDir, "work.png"), fullPage: true });

      await navigateApp("agentlas://app/one", "/one");
      await navigateApp(`agentlas://app/one?chat=${encodeURIComponent(seeded.one.chat.id)}`, "/one", "chat", seeded.one.chat.id);
      await page.locator('[data-chat-file-cards="true"] button').first().waitFor({ timeout: 60_000 });
      await page.locator('[data-chat-file-cards="true"] button').first().click();
      await page.waitForFunction(() => document.querySelectorAll('[data-chat-file-tabs="true"] [role="tab"]').length === 1);
      assert.equal(await page.locator('[data-chat-file-tabs="true"] [role="tab"]').count(), 1, "One chat re-entry must restore the binding and reopen the selected file");
      const reenteredTabId = await page.locator('[data-chat-file-viewer="true"]').getAttribute("data-chat-file-tab-id");
      assert.equal(reenteredTabId, oneTabId, "One re-entry must preserve the stable tab identity");

      // Opening a file in chat A writes the rail-open convenience bit. A direct
      // switch to chat B must still close that auto-open file rail, and a short
      // no-output answer must stay inline instead of inheriting an empty 0/0 rail.
      await navigateApp(`agentlas://app/one?chat=${encodeURIComponent(seeded.simple.id)}`, "/one", "chat", seeded.simple.id);
      await page.getByText("SHORT_INLINE_OK", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
      await page.getByText("SHORT_INLINE_FOLLOWUP", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
      await page.waitForTimeout(500);
      assert.equal(await page.locator('[data-one-runtime-artifacts="true"]').count(), 0, "a short text-only One answer must not inherit chat A's auto-open file rail");
      assert.equal(await page.locator('[data-one-message-avatar="true"]').count(), 1, "the first direct assistant message must render one real portrait");
      assert.equal(await page.locator('[data-one-message-avatar="spacer"]').count(), 1, "a consecutive direct assistant message must retain only the portrait alignment spacer");
      assert.equal(await page.locator('article[data-role="user"] [data-one-message-avatar]').count(), 0, "user messages must never borrow an agent portrait");
      await page.screenshot({ path: path.join(proofDir, "one-short-answer-inline.png"), fullPage: true });

      await navigateApp(`agentlas://app/one?chat=${encodeURIComponent(seeded.taskforce.chatId)}`, "/one", "chat", seeded.taskforce.chatId);
      await page.getByText("TASKFORCE_AVATAR_OK", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
      assert.equal(await page.locator('article[data-taskforce="true"][data-role="assistant"] [data-one-message-avatar="true"]').count(), 1, "a Taskforce assistant group must render One's portrait");
      assert.equal(await page.locator('article[data-taskforce="true"][data-role="user"] [data-one-message-avatar]').count(), 0, "Taskforce user messages must not render an agent portrait");
      await page.screenshot({ path: path.join(proofDir, "one-taskforce-avatar.png"), fullPage: true });

      assert.deepEqual(errors, [], `renderer errors: ${errors.join("\n")}`);
      const proof = {
        ok: true,
        fixtures: [textPath, xlsxPath, folderPath].map((target) => ({ path: target, size: fs.statSync(target).size, sha256: fs.statSync(target).isFile() ? crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") : seeded.one.snapshot.files.find((file) => file.kind === "directory")?.sha256 })),
        bindings: { one: seeded.one.snapshot, work: seeded.work.snapshot },
        stableTabId: oneTabId,
        folderClaim: seeded.folderClaim,
        measurements,
        readableWidths: {
          oneFrom200: oneReadable200?.width,
          oneFrom324: oneReadable324?.width,
          workFrom320: workReadable320?.width,
        },
        workComposerAlignment,
        shortAnswerStayedInline: true,
        avatarContract: { directGroupPortraits: 1, directGroupSpacers: 1, taskforcePortraits: 1, userPortraits: 0 },
        collisionCode: seeded.collisionCode,
        errorCodes: {
          collision: seeded.collisionCode,
          unsupported: seeded.unsupportedCode,
          tooLarge: seeded.tooLargeCode,
          pathTooLong: seeded.pathTooLongCode,
          permission: seeded.permissionCode,
          missing: seeded.missingCode,
        },
      };
      fs.writeFileSync(path.join(proofDir, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({ ok: true, stableTabId: oneTabId, measurements: measurements.length, proof: path.join(proofDir, "proof.json") })}\n`);
    } finally {
      await desktop?.close().catch(() => undefined);
      stopOwnedElectronProcesses();
    }
  })().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
