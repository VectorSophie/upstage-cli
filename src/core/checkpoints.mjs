import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";

const MAX_HISTORY = 50;

function randomHex(bytes = 2) {
  return randomBytes(bytes).toString("hex");
}

export class CheckpointManager {
  constructor(baseDir = join(process.cwd(), ".upstage", "checkpoints")) {
    this.baseDir = baseDir;
    this.history = []; // [{ id, checkpointPath }]
  }

  async _ensureDir() {
    if (!existsSync(this.baseDir)) {
      await mkdir(this.baseDir, { recursive: true });
    }
  }

  async save(filePath) {
    await this._ensureDir();

    let content = null;
    if (existsSync(filePath)) {
      content = await readFile(filePath, "utf8");
    }

    const id = `ckpt_${Date.now()}_${randomHex(2)}`;
    const checkpointPath = join(this.baseDir, `${id}.json`);

    const record = {
      id,
      filePath,
      relativePath: relative(process.cwd(), filePath),
      content,
      timestamp: Date.now(),
      size: content ? content.length : 0
    };

    await writeFile(checkpointPath, JSON.stringify(record, null, 2), "utf8");

    this.history.push({ id, checkpointPath });

    // Trim oldest if over limit
    if (this.history.length > MAX_HISTORY) {
      const oldest = this.history.shift();
      try {
        await unlink(oldest.checkpointPath);
      } catch (_e) {
        // ignore
      }
    }

    return record;
  }

  async undo() {
    if (this.history.length === 0) {
      return null;
    }

    const entry = this.history.pop();

    let record;
    try {
      const raw = await readFile(entry.checkpointPath, "utf8");
      record = JSON.parse(raw);
    } catch (_e) {
      return null;
    }

    if (record.content === null) {
      // File was new when checkpointed — delete it to restore
      try {
        await unlink(record.filePath);
      } catch (_e) {
        // already gone
      }
    } else {
      await writeFile(record.filePath, record.content, "utf8");
    }

    try {
      await unlink(entry.checkpointPath);
    } catch (_e) {
      // ignore
    }

    return { id: record.id, filePath: record.filePath, restored: true };
  }

  async list(limit = 10) {
    return this.history.slice(-limit).reverse();
  }

  async clear() {
    for (const entry of this.history) {
      try {
        await unlink(entry.checkpointPath);
      } catch (_e) {
        // ignore
      }
    }
    this.history = [];
  }
}
