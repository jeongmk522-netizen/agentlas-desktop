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
    process.stdout.write(`${JSON.stringify({ work, one, folderClaim, collisionCode, unsupportedCode, tooLargeCode, pathTooLongCode, permissionCode, missingCode })}\n`);
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
      AGENTLAS_CHAT_FILE_QA_INPUT: JSON.stringify({ userData, runFolder: path.join(fixtures, "one-run"), workPaths: [textPath, xlsxPath], onePaths: [xlsxPath, folderPath], unsupportedPath, largePath, missingPath, longFolderPath }),
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

      await page.waitForURL((url) => url.pathname === "/one", { timeout: 60_000 });
      await page.locator('[data-chat-file-cards="true"] button').first().waitFor({ timeout: 60_000 });
      const oneCards = page.locator('[data-chat-file-cards="true"] button');
      assert.equal(await oneCards.count(), 2, "One must restore two attachment cards");
      await oneCards.nth(0).click();
      await oneCards.nth(1).click();
      assert.equal(await page.locator('[data-chat-file-tabs="true"] [role="tab"]').count(), 2, "One must open two file tabs");
      await oneCards.nth(0).click();
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

      const workUrl = `agentlas://app/workspace/task?id=${encodeURIComponent(seeded.work.chat.id)}`;
      await page.goto(workUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.locator('[data-chat-file-cards="true"] button').first().waitFor({ timeout: 60_000 });
      const workCards = page.locator('[data-chat-file-cards="true"] button');
      assert.equal(await workCards.count(), 2, "Work must restore two attachment cards");
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

      await page.goto(`agentlas://app/one`, { waitUntil: "domcontentloaded" });
      await page.goto(`agentlas://app/one?chat=${encodeURIComponent(seeded.one.chat.id)}`, { waitUntil: "domcontentloaded" });
      await page.locator('[data-chat-file-cards="true"] button').first().waitFor({ timeout: 60_000 });
      await page.locator('[data-chat-file-cards="true"] button').first().click();
      assert.equal(await page.locator('[data-chat-file-tabs="true"] [role="tab"]').count(), 1, "One chat re-entry must restore the binding and reopen the selected file");
      const reenteredTabId = await page.locator('[data-chat-file-viewer="true"]').getAttribute("data-chat-file-tab-id");
      assert.equal(reenteredTabId, oneTabId, "One re-entry must preserve the stable tab identity");

      assert.deepEqual(errors, [], `renderer errors: ${errors.join("\n")}`);
      const proof = {
        ok: true,
        fixtures: [textPath, xlsxPath, folderPath].map((target) => ({ path: target, size: fs.statSync(target).size, sha256: fs.statSync(target).isFile() ? crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") : seeded.one.snapshot.files.find((file) => file.kind === "directory")?.sha256 })),
        bindings: { one: seeded.one.snapshot, work: seeded.work.snapshot },
        stableTabId: oneTabId,
        folderClaim: seeded.folderClaim,
        measurements,
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
    }
  })().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
