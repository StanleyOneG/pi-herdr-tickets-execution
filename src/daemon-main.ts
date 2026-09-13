import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PreparationController } from "./controller.js";
import { FileWorkerBridgeTransport } from "./file-worker-bridge.js";
import { LocalGateCheckAdapter } from "./gate-checks.js";
import { RealGitWorktreeAdapter } from "./git-worktrees.js";
import { ExecFileHerdrCommandExecutor, HerdrWorkerRuntime } from "./herdr-runtime.js";
import { LocalControllerDaemon, localDaemonPaths, readOrCreateToken } from "./local-daemon.js";
import { FileNativeEvidenceAdapter } from "./native-evidence.js";
import { formatPreparationPreview } from "./presentation.js";
import { LocalSetupRuntime } from "./setup-runtime.js";
import { JsonControllerStateStore } from "./state-store.js";

export async function runDaemon(argv: string[]): Promise<void> {
  const statePath = requiredArgument(argv, "--state");
  const paths = localDaemonPaths(statePath);
  const token = await readOrCreateToken(paths.tokenPath);
  const actor = Symbol("local daemon actor");
  const bridge = new FileWorkerBridgeTransport(paths.workerBridgeDirectory);
  const worker = new HerdrWorkerRuntime({ executor: new ExecFileHerdrCommandExecutor(), bridge });
  const controller = new PreparationController(new JsonControllerStateStore(statePath), {
    actorCapability: actor,
    now: (): Date => new Date(),
    generateId: (): string => randomUUID(),
    formatPreview: formatPreparationPreview,
    execution: {
      owner: { instanceId: randomUUID(), pid: process.pid },
      git: new RealGitWorktreeAdapter(),
      worker,
      setup: new LocalSetupRuntime(),
      acceptance: {
        reviewer: worker,
        checks: new LocalGateCheckAdapter(paths.evidenceDirectory),
        nativeEvidence: new FileNativeEvidenceAdapter(),
      },
    },
  });
  const daemon = new LocalControllerDaemon(controller, actor, paths.socketPath, token, worker);
  await daemon.start();

  const stop = async (): Promise<void> => {
    await daemon.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", (): void => { void stop(); });
  process.once("SIGTERM", (): void => { void stop(); });
}

function requiredArgument(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return resolve(value);
}
