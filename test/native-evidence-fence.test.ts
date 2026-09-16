import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  NativeEvidenceFence,
  nativeEvidenceFenceDirectory,
} from "../src/native-evidence-fence.js";

async function fixture(): Promise<{ root: string; statePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "herdr-native-fence-"));
  return { root, statePath: join(root, "obligation-state.json") };
}

test("a lifecycle fence serializes contenders without deleting another owner", async (): Promise<void> => {
  const { root, statePath } = await fixture();
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve): void => { releaseFirst = resolve; });
  let firstAcquired!: () => void;
  const acquired = new Promise<void>((resolve): void => { firstAcquired = resolve; });
  const order: string[] = [];
  const first = new NativeEvidenceFence({ generateToken: (): string => "first-owner" });
  let waitingObserved = false;
  let firstOperation!: Promise<void>;
  const second = new NativeEvidenceFence({
    generateToken: (): string => "second-owner",
    wait: async (): Promise<void> => {
      if (!waitingObserved) {
        waitingObserved = true;
        order.push("waiting");
        releaseFirst();
      }
      await firstOperation;
    },
  });
  try {
    firstOperation = first.run(statePath, async (): Promise<void> => {
      order.push("first");
      firstAcquired();
      await firstHeld;
    });
    await acquired;
    const secondOperation = second.run(statePath, async (): Promise<void> => { order.push("second"); });

    await Promise.all([firstOperation, secondOperation]);

    assert.deepEqual(order, ["first", "waiting", "second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a lifecycle fence leaves an owner-mismatched directory in place", async (): Promise<void> => {
  const { root, statePath } = await fixture();
  const fence = new NativeEvidenceFence({ generateToken: (): string => "expected-owner" });
  try {
    await assert.rejects(
      fence.run(statePath, async (): Promise<void> => {
        await writeFile(join(nativeEvidenceFenceDirectory(statePath), "owner.json"), `${JSON.stringify({
          schemaVersion: 1,
          token: "different-owner",
          pid: process.pid,
        })}\n`);
      }),
      /ownership changed/i,
    );

    assert.equal(JSON.parse(await readFile(join(nativeEvidenceFenceDirectory(statePath), "owner.json"), "utf8")).token, "different-owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded lifecycle fence contention fails closed and preserves the existing owner", async (): Promise<void> => {
  const { root, statePath } = await fixture();
  let now = 0;
  const first = new NativeEvidenceFence({ generateToken: (): string => "first-owner" });
  const second = new NativeEvidenceFence({
    deadlineMs: 2,
    now: (): number => now,
    wait: async (): Promise<void> => { now += 1; },
    generateToken: (): string => "second-owner",
  });
  try {
    await first.run(statePath, async (): Promise<void> => {
      await assert.rejects(second.run(statePath, async (): Promise<void> => {}), /contention deadline/i);
      const owner = JSON.parse(await readFile(join(nativeEvidenceFenceDirectory(statePath), "owner.json"), "utf8")) as { token: string };
      assert.equal(owner.token, "first-owner");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
