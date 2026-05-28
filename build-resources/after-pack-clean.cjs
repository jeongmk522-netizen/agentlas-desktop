const { rm } = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

async function removeAppleDoubleFiles(root) {
  let removed = 0;
  const queue = [root];

  while (queue.length > 0) {
    const dir = queue.pop();
    let entries;

    try {
      entries = await require("node:fs/promises").readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.name.startsWith("._")) {
        await rm(fullPath, { force: true, recursive: true });
        removed += 1;
        continue;
      }

      if (entry.isDirectory()) {
        queue.push(fullPath);
      }
    }
  }

  return removed;
}

exports.default = async function afterPackClean(context) {
  if (process.platform !== "darwin") {
    return;
  }

  try {
    await execFileAsync("/usr/bin/dot_clean", ["-m", context.appOutDir]);
  } catch {
    // dot_clean is best effort; recursive unlink below is the release gate.
  }

  const removed = await removeAppleDoubleFiles(context.appOutDir);
  if (removed > 0) {
    console.log(`[afterPack] removed ${removed} AppleDouble metadata files before code signing`);
  }
};
