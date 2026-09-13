import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { NativeEvidencePort, NativeEvidenceRecord } from "./contracts.js";

const MAX_NATIVE_EVIDENCE_BYTES = 1024 * 1024;

/** Resolves a retained native-skill receipt and verifies its immutable code-state binding. */
export class FileNativeEvidenceAdapter implements NativeEvidencePort {
  async verify(input: { record: NativeEvidenceRecord; candidate: { codeStateDigest: string } }): Promise<void> {
    const { record, candidate } = input;
    if (!isAbsolute(record.evidenceReference)) throw new Error("Native evidence reference must be an absolute local artifact");
    const bytes = await readFile(record.evidenceReference);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_NATIVE_EVIDENCE_BYTES) {
      throw new Error("Native evidence artifact is empty or exceeds its bound");
    }
    if (hash(bytes) !== record.evidenceDigest) throw new Error("Native evidence artifact digest changed");
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isReceipt(parsed) || parsed.kind !== record.kind || parsed.status !== record.status ||
      parsed.codeStateDigest !== candidate.codeStateDigest || parsed.codeStateDigest !== record.codeStateDigest ||
      parsed.completedAt !== record.completedAt
    ) throw new Error("Native evidence artifact is malformed, stale, or candidate-mismatched");
    for (const artifact of parsed.artifacts) {
      if (!isAbsolute(artifact.reference) || artifact.reference === record.evidenceReference) {
        throw new Error("Native evidence source artifact reference is unsafe");
      }
      const retained = await readFile(artifact.reference);
      if (retained.byteLength === 0 || retained.byteLength > MAX_NATIVE_EVIDENCE_BYTES || hash(retained) !== artifact.digest) {
        throw new Error("Native evidence source artifact is missing, changed, or exceeds its bound");
      }
    }
  }
}

function isReceipt(value: unknown): value is {
  schemaVersion: 1;
  kind: "tests" | "reviews";
  status: "passed";
  codeStateDigest: string;
  completedAt: string;
  artifacts: Array<{ reference: string; digest: string }>;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return Object.keys(receipt).length === 6 && receipt.schemaVersion === 1 &&
    (receipt.kind === "tests" || receipt.kind === "reviews") && receipt.status === "passed" &&
    typeof receipt.codeStateDigest === "string" && /^[a-f0-9]{64}$/i.test(receipt.codeStateDigest) &&
    typeof receipt.completedAt === "string" && Number.isFinite(Date.parse(receipt.completedAt)) &&
    Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0 && receipt.artifacts.length <= 20 &&
    receipt.artifacts.every((artifact): boolean => typeof artifact === "object" && artifact !== null &&
      Object.keys(artifact).length === 2 && typeof artifact.reference === "string" && artifact.reference.length <= 4_096 &&
      typeof artifact.digest === "string" && /^[a-f0-9]{64}$/i.test(artifact.digest));
}

function hash(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
