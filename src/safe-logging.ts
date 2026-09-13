import { createHash } from "node:crypto";

export type GateTermination = "completed" | "output-limit" | "timeout" | "signal";

export interface SafeGateEvidenceInput {
  command: string;
  candidateCommit: string;
  exitCode: number;
  output: string;
  termination: GateTermination;
}

/** Builds allowlisted gate metadata; arbitrary output is omitted while safe diagnostic categories are retained. */
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
    diagnostics: safeDiagnostics(input.output),
    termination: input.termination,
  };
  return { serialized: `${JSON.stringify(metadata)}\n`, outputDigest };
}

function safeDiagnostics(output: string): {
  compilerErrorCodes: string[];
  testFailureTypes: string[];
  testSummary: Partial<Record<"tests" | "suites" | "pass" | "fail" | "cancelled" | "skipped" | "todo", number>>;
} {
  const compilerErrorCodes = [...new Set(output.match(/\b(?:TS\d{4,5}|CS\d{4}|E\d{4})\b/g) ?? [])].slice(0, 50);
  const allowedFailureTypes = new Set(["testCodeFailure", "hookFailed", "cancelledByParent", "subtestsFailed"]);
  const testFailureTypes = [...output.matchAll(/^\s*failureType:\s*['"]([A-Za-z][A-Za-z0-9_-]{0,63})['"]\s*$/gm)]
    .map((match): string => match[1]!)
    .filter((value, index, values): boolean => allowedFailureTypes.has(value) && values.indexOf(value) === index)
    .slice(0, 20);
  const observed = new Map<string, number>();
  for (const match of output.matchAll(/^\s*#?\s*(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gmi)) {
    const value = Number(match[2]);
    if (Number.isSafeInteger(value)) observed.set(match[1]!.toLowerCase(), value);
  }
  const testSummary: Partial<Record<"tests" | "suites" | "pass" | "fail" | "cancelled" | "skipped" | "todo", number>> = {};
  for (const key of ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"] as const) {
    const value = observed.get(key);
    if (value !== undefined) testSummary[key] = value;
  }
  return { compilerErrorCodes, testFailureTypes, testSummary };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
