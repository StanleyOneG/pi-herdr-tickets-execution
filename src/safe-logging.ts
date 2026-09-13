import { createHash } from "node:crypto";

export type GateTermination = "completed" | "output-limit" | "timeout" | "signal";

export interface SafeGateEvidenceInput {
  command: string;
  candidateCommit: string;
  exitCode: number;
  output: string;
  termination: GateTermination;
}

/** Builds allowlisted gate metadata; arbitrary command output is digested but never retained. */
export function safeGateEvidence(input: SafeGateEvidenceInput): {
  serialized: string;
  outputDigest: string;
} {
  const outputDigest = hash(input.output);
  const metadata = {
    schemaVersion: 1,
    candidateCommit: input.candidateCommit,
    commandDigest: hash(input.command),
    exitCode: input.exitCode,
    outputDigest,
    outputBytes: Buffer.byteLength(input.output, "utf8"),
    outputLines: input.output.length === 0 ? 0 : input.output.split("\n").length,
    outputOmitted: true,
    termination: input.termination,
  };
  return { serialized: `${JSON.stringify(metadata)}\n`, outputDigest };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
