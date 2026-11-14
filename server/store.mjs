// Small file store under data/: JSON documents (atomic write) and JSONL logs.
import { mkdir, readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export async function initStore(dir) {
  await mkdir(dir, { recursive: true });
  const locks = new Map();
  const path = (name) => join(dir, name);

  async function readJson(name, fallback) {
    try { return JSON.parse(await readFile(path(name), "utf8")); } catch { return structuredClone(fallback); }
  }
  async function writeJson(name, value) {
    const file = path(name);
    await mkdir(dirname(file), { recursive: true });
    const prev = locks.get(file) || Promise.resolve();
    const next = prev.then(async () => {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
      await rename(tmp, file);
    });
    locks.set(file, next.catch(() => {}));
    return next;
  }
  // read-modify-write under the same per-file queue
  async function update(name, fallback, fn) {
    const file = path(name);
    const prev = locks.get(file) || Promise.resolve();
    let result;
    const next = prev.then(async () => {
      let cur;
      try { cur = JSON.parse(await readFile(file, "utf8")); } catch { cur = structuredClone(fallback); }
      const out = await fn(cur);
      const value = out === undefined ? cur : out;
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
      await rename(tmp, file);
      result = value;
    });
    locks.set(file, next.catch(() => {}));
    await next;
    return result;
  }
  async function append(name, record) {
    const file = path(name);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(record) + "\n", { mode: 0o600 });
  }
  async function tail(name, limit = 200, filter = () => true) {
    let text = "";
    try { text = await readFile(path(name), "utf8"); } catch { return []; }
    const out = [];
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i]) continue;
      try { const rec = JSON.parse(lines[i]); if (filter(rec)) out.push(rec); } catch {}
    }
    return out;
  }
  return { dir, path, readJson, writeJson, update, append, tail };
}
