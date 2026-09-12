import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import type { ControllerState, ControllerStateStore } from "./contracts.js";

export class JsonControllerStateStore implements ControllerStateStore {
  constructor(private readonly statePath: string) {}

  async load(): Promise<ControllerState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as ControllerState;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.preparations) || !Array.isArray(parsed.executionAttempts)) {
        throw new Error("Unsupported controller state");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, preparations: [], executionAttempts: [] };
      }
      throw error;
    }
  }

  async save(state: ControllerState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.statePath);
      renamed = true;
      await this.syncDirectory();
    } finally {
      if (!renamed) await this.removeTemporary(temporary);
    }
  }

  private async removeTemporary(temporary: string): Promise<void> {
    try {
      await unlink(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async syncDirectory(): Promise<void> {
    try {
      const directory = await open(dirname(this.statePath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  }
}
