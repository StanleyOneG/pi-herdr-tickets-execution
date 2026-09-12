import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import type { ControllerState, ControllerStateStore } from "./contracts.js";
import { isControllerState } from "./state-validation.js";

const MAX_STATE_BYTES = 5 * 1024 * 1024;

export class JsonControllerStateStore implements ControllerStateStore {
  constructor(private readonly statePath: string) {}

  async load(): Promise<ControllerState> {
    try {
      const file = await open(this.statePath, "r");
      try {
        const metadata = await file.stat();
        if (metadata.size > MAX_STATE_BYTES) throw new Error("Controller state exceeds its storage bound");
        const parsed: unknown = JSON.parse(await file.readFile("utf8"));
        if (!isControllerState(parsed)) throw new Error("Controller state is malformed or unsupported");
        return parsed;
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, preparations: [], executionAttempts: [] };
      }
      throw error;
    }
  }

  async save(state: ControllerState): Promise<void> {
    if (!isControllerState(state)) throw new Error("Refusing to persist invalid controller state");
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
      throw new Error("Controller state exceeds its storage bound");
    }

    await mkdir(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(serialized, "utf8");
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
