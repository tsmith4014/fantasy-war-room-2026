import fs from "node:fs/promises";
import path from "node:path";

export function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function fetchTextOnce(url, { timeoutMs = 20_000, headers = {}, maxBytes = 50_000_000 } = {}) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json,text/csv,application/rss+xml,application/xml,text/xml,text/plain;q=0.9,*/*;q=0.5",
      "user-agent": "FantasyWarRoom2026/1.0 (personal, non-commercial research; source-attributed)",
      ...headers,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error(`${url} exceeds the ${maxBytes}-byte limit`);
  if (!response.body) throw new Error(`${url} returned no response body`);
  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maxBytes) {
      await reader.cancel("response exceeded byte limit").catch(() => {});
      throw new Error(`${url} exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks, receivedBytes).toString("utf8");
  return { text, finalUrl: response.url, contentType: response.headers.get("content-type") ?? "" };
}

export async function fetchJsonOnce(url, options) {
  const { text, ...metadata } = await fetchTextOnce(url, options);
  try {
    return { value: JSON.parse(text), ...metadata };
  } catch {
    throw new Error(`${url} did not return valid JSON`);
  }
}

export async function retryOptional(operation, { attempts = 2, delayMs = 300 } = {}) {
  if (typeof operation !== "function") throw new Error("retryOptional requires an operation");
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 4) throw new Error("retryOptional attempts must be an integer from 1 to 4");
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 5_000) throw new Error("retryOptional delay must be between 0 and 5000 milliseconds");
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

export async function withFileLock(lockPath, callback) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let lockHandle;
  try {
    try {
      lockHandle = await fs.open(lockPath, "wx");
      await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    } catch (error) {
      if (error?.code === "EEXIST") {
        const lockDetails = await fs.readFile(lockPath, "utf8").catch(() => "unreadable lock");
        throw new Error(`Another data refresh holds ${lockPath}: ${lockDetails.trim()}`);
      }
      throw error;
    }
    return await callback();
  } finally {
    await lockHandle?.close().catch(() => {});
    if (lockHandle) await fs.unlink(lockPath).catch(() => {});
  }
}

/**
 * Serialize publishers, reject stale writers, stage all files, and use atomic
 * per-file renames. Runtime rename failures roll back from same-directory
 * backups; the manifest is deliberately published after the JSON payloads.
 */
export async function writeAtomicBundle(entries, {
  lockPath = path.join(path.dirname(entries[0][0]), ".refresh-data.lock"),
  expectedSnapshotPath,
  expectedSnapshotId,
  lockHeld = false,
} = {}) {
  const token = `.refresh-${process.pid}-${Date.now()}`;
  const staged = [];
  const backups = [];
  const published = [];
  let lockHandle;
  try {
    if (!lockHeld) {
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      try {
        lockHandle = await fs.open(lockPath, "wx");
        await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      } catch (error) {
        if (error?.code === "EEXIST") {
          const lockDetails = await fs.readFile(lockPath, "utf8").catch(() => "unreadable lock");
          throw new Error(`Another data publication holds ${lockPath}: ${lockDetails.trim()}`);
        }
        throw error;
      }
    }
    if (expectedSnapshotPath) {
      const current = await readJsonIfPresent(expectedSnapshotPath);
      const currentSnapshotId = current?.snapshotId ?? null;
      if (currentSnapshotId !== (expectedSnapshotId ?? null)) {
        throw new Error(`Data snapshot changed during refresh (${expectedSnapshotId ?? "none"} -> ${currentSnapshotId ?? "none"}); refusing a stale publication`);
      }
    }
    for (const [target, contents] of entries) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}${token}`;
      await fs.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
      staged.push({ target, temporary });
    }
    for (const { target } of staged) {
      const backup = `${target}${token}.backup`;
      try {
        await fs.copyFile(target, backup, fs.constants.COPYFILE_EXCL);
        backups.push({ target, backup, existed: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        backups.push({ target, backup, existed: false });
      }
    }
    for (const { target, temporary } of staged) {
      await fs.rename(temporary, target);
      published.push(target);
    }
    await Promise.allSettled(backups.filter(({ existed }) => existed).map(({ backup }) => fs.unlink(backup)));
  } catch (error) {
    const rollbackErrors = [];
    for (const { target, backup, existed } of backups.slice().reverse()) {
      if (!published.includes(target)) continue;
      try {
        if (existed) await fs.rename(backup, target);
        else await fs.unlink(target);
      } catch (rollbackError) {
        rollbackErrors.push(`${target}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    await Promise.allSettled(staged.map(({ temporary }) => fs.unlink(temporary)));
    await Promise.allSettled(backups.map(({ backup }) => fs.unlink(backup)));
    if (rollbackErrors.length) throw new Error(`${error instanceof Error ? error.message : String(error)}; rollback failures: ${rollbackErrors.join("; ")}`);
    throw error;
  } finally {
    await lockHandle?.close().catch(() => {});
    if (lockHandle) await fs.unlink(lockPath).catch(() => {});
  }
}
