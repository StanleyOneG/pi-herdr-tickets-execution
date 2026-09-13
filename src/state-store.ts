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
      let serialized: string;
      try {
        const metadata = await file.stat();
        if (metadata.size > MAX_STATE_BYTES) throw new Error("Controller state exceeds its storage bound");
        serialized = await file.readFile("utf8");
      } finally {
        await file.close();
      }
      const migrated = migrateLegacyApprovedIntegrations(JSON.parse(serialized) as unknown);
      if (!isControllerState(migrated.value)) throw new Error("Controller state is malformed or unsupported");
      if (migrated.changed) await this.save(migrated.value);
      return migrated.value;
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

function migrateLegacyApprovedIntegrations(value: unknown): { value: unknown; changed: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, changed: false };
  const state = value as Record<string, unknown>;
  if (state.schemaVersion !== 1 || !Array.isArray(state.preparations)) return { value, changed: false };
  let changed = false;
  for (const item of state.preparations) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const preparation = item as Record<string, unknown>;
    if (preparation.stage !== "approved" || preparation.batchIntegration !== undefined ||
      !preparation.proposal || typeof preparation.proposal !== "object" || Array.isArray(preparation.proposal)
    ) continue;
    const target = (preparation.proposal as Record<string, unknown>).target;
    if (!target || typeof target !== "object" || Array.isArray(target)) continue;
    const baseCommit = (target as Record<string, unknown>).baseCommit;
    if (typeof baseCommit !== "string" || baseCommit.length === 0 || baseCommit.length > 4_096) continue;
    preparation.batchIntegration = { head: baseCommit, sequence: 0 };
    changed = true;
  }
  return { value, changed };
}
