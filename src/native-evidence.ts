import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import type { CandidateGitState, NativeEvidencePort, NativeEvidenceRecord } from "./contracts.js";
import {
  NATIVE_EVIDENCE_STATE_FILE,
  isNativeEvidenceLifecycleBinding,
  readNativeEvidenceState,
  type NativeEvidenceLifecycleBinding,
} from "./native-evidence-state.js";

const MAX_NATIVE_EVIDENCE_BYTES = 1024 * 1024;
const EMPTY_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

export async function readProducedNativeEvidence(
  path: string,
  expected: { sessionId: string; codeStateDigest: string },
): Promise<NativeEvidenceRecord[]> {
  if (!isAbsolute(path)) throw new Error("Native evidence index path must be absolute");
  const parsed: unknown = JSON.parse((await readBoundedRegularFile(path)).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Native evidence index is malformed");
  const index = parsed as Record<string, unknown>;
  if (index.schemaVersion !== 1 || index.producer !== "herdr-worker-bridge" ||
    index.sessionId !== expected.sessionId || index.codeStateDigest !== expected.codeStateDigest ||
    !Array.isArray(index.nativeEvidence) || index.nativeEvidence.length !== 2
  ) throw new Error("Native evidence index is stale or mismatched");
  const records = index.nativeEvidence;
  if (!records.every(isNativeEvidenceRecord) ||
    !records.some((record): boolean => record.kind === "tests") ||
    !records.some((record): boolean => record.kind === "reviews") ||
    records.some((record): boolean => record.codeStateDigest !== expected.codeStateDigest)
  ) throw new Error("Native evidence index does not contain exact tests and review proofs");
  return structuredClone(records);
}

/** Resolves a retained native-skill receipt and verifies its immutable code-state binding. */
export class FileNativeEvidenceAdapter implements NativeEvidencePort {
  async verify(input: { record: NativeEvidenceRecord; candidate: CandidateGitState }): Promise<void> {
    const { record, candidate } = input;
    if (!isAbsolute(record.evidenceReference)) throw new Error("Native evidence reference must be an absolute local artifact");
    const bytes = await readBoundedRegularFile(record.evidenceReference);
    if (hash(bytes) !== record.evidenceDigest) throw new Error("Native evidence artifact digest changed");
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isReceipt(parsed) || parsed.kind !== record.kind || parsed.status !== record.status ||
      parsed.codeStateDigest !== candidate.codeStateDigest || parsed.codeStateDigest !== record.codeStateDigest ||
      parsed.completedAt !== record.completedAt || parsed.lifecycle.obligation !== record.kind ||
      parsed.lifecycle.reference !== join(dirname(dirname(record.evidenceReference)), NATIVE_EVIDENCE_STATE_FILE)
    ) throw new Error("Native evidence artifact is malformed, stale, or candidate-mismatched");
    const lifecycle = await readNativeEvidenceState(parsed.lifecycle.reference);
    const obligation = lifecycle.obligations[record.kind];
    if (lifecycle.sessionId !== parsed.lifecycle.sessionId || lifecycle.generation !== parsed.lifecycle.generation ||
      obligation.sequence !== parsed.lifecycle.sequence || obligation.status !== "passed" ||
      obligation.proof?.codeStateDigest !== parsed.codeStateDigest || obligation.proof.completedAt !== parsed.completedAt
    ) throw new Error("Native evidence obligation lifecycle is stale or unresolved");
    for (const artifact of parsed.artifacts) {
      if (!isAbsolute(artifact.reference) || artifact.reference === record.evidenceReference) {
        throw new Error("Native evidence source artifact reference is unsafe");
      }
      const retained = await readBoundedRegularFile(artifact.reference);
      if (hash(retained) !== artifact.digest || !isProducerReceipt(JSON.parse(retained.toString("utf8")), parsed, candidate)) {
        throw new Error("Native evidence source artifact is missing, changed, or candidate-mismatched");
      }
    }
  }
}

function isNativeEvidenceRecord(value: unknown): value is NativeEvidenceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.kind === "tests" || record.kind === "reviews") && record.status === "passed" &&
    typeof record.codeStateDigest === "string" && /^[a-f0-9]{64}$/i.test(record.codeStateDigest) &&
    typeof record.evidenceReference === "string" && isAbsolute(record.evidenceReference) && record.evidenceReference.length <= 4_096 &&
    typeof record.evidenceDigest === "string" && /^[a-f0-9]{64}$/i.test(record.evidenceDigest) &&
    typeof record.completedAt === "string" && Number.isFinite(Date.parse(record.completedAt));
}

function isReceipt(value: unknown): value is {
  schemaVersion: 2;
  kind: "tests" | "reviews";
  status: "passed";
  codeStateDigest: string;
  completedAt: string;
  artifacts: Array<{ reference: string; digest: string }>;
  lifecycle: NativeEvidenceLifecycleBinding;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return Object.keys(receipt).length === 7 && receipt.schemaVersion === 2 &&
    (receipt.kind === "tests" || receipt.kind === "reviews") && receipt.status === "passed" &&
    typeof receipt.codeStateDigest === "string" && /^[a-f0-9]{64}$/i.test(receipt.codeStateDigest) &&
    typeof receipt.completedAt === "string" && Number.isFinite(Date.parse(receipt.completedAt)) &&
    isNativeEvidenceLifecycleBinding(receipt.lifecycle) &&
    Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0 && receipt.artifacts.length <= 20 &&
    receipt.artifacts.every((artifact): boolean => typeof artifact === "object" && artifact !== null &&
      Object.keys(artifact).length === 2 && typeof artifact.reference === "string" && artifact.reference.length <= 4_096 &&
      typeof artifact.digest === "string" && /^[a-f0-9]{64}$/i.test(artifact.digest));
}

function isProducerReceipt(
  value: unknown,
  manifest: { kind: "tests" | "reviews"; status: "passed"; codeStateDigest: string; completedAt: string },
  candidate: CandidateGitState,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const hasReviewArtifacts = Object.hasOwn(receipt, "reviewArtifacts");
  const hasWorkflowReceipt = Object.hasOwn(receipt, "workflowReceipt");
  const hasReviewBinding = Object.hasOwn(receipt, "reviewBinding");
  const reviewArtifactsValid = !hasReviewArtifacts || (receipt.kind === "reviews" &&
    Array.isArray(receipt.reviewArtifacts) && receipt.reviewArtifacts.length === 2 &&
    receipt.reviewArtifacts.every(isRetainedReviewArtifact) &&
    new Set(receipt.reviewArtifacts.map((artifact): unknown => (artifact as Record<string, unknown>).role)).size === 2 &&
    new Set(receipt.reviewArtifacts.map((artifact): unknown => (artifact as Record<string, unknown>).workflowKey)).size === 2);
  const workflowReceipt = receipt.workflowReceipt as Record<string, unknown> | undefined;
  const workflowReceiptValid = !hasWorkflowReceipt || (receipt.kind === "reviews" && workflowReceipt !== undefined &&
    !Array.isArray(workflowReceipt) && Object.keys(workflowReceipt).length === 2 &&
    typeof workflowReceipt.reference === "string" && isAbsolute(workflowReceipt.reference) && workflowReceipt.reference.length <= 4_096 &&
    typeof workflowReceipt.digest === "string" && /^[a-f0-9]{64}$/i.test(workflowReceipt.digest));
  const reviewBindingValid = !hasReviewBinding || (receipt.kind === "reviews" &&
    isReviewBinding(receipt.reviewBinding, receipt.reviewArtifacts, candidate, manifest));
  return Object.keys(receipt).length === 7 + Number(hasReviewArtifacts) + Number(hasWorkflowReceipt) + Number(hasReviewBinding) &&
    hasReviewArtifacts === hasWorkflowReceipt && hasWorkflowReceipt === hasReviewBinding &&
    receipt.schemaVersion === 1 && receipt.producer === "pi-native-skill" &&
    receipt.kind === manifest.kind && receipt.status === manifest.status && receipt.codeStateDigest === manifest.codeStateDigest &&
    receipt.completedAt === manifest.completedAt && Array.isArray(receipt.executionReferences) &&
    receipt.executionReferences.length > 0 && receipt.executionReferences.length <= 20 &&
    receipt.executionReferences.every((reference): boolean => typeof reference === "string" &&
      reference.trim().length > 0 && reference.length <= 4_096) && reviewArtifactsValid && workflowReceiptValid && reviewBindingValid;
}

function isReviewBinding(
  value: unknown,
  artifactsValue: unknown,
  candidate: CandidateGitState,
  manifest: { codeStateDigest: string },
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(artifactsValue)) return false;
  const binding = value as Record<string, unknown>;
  if (Object.keys(binding).length !== 6 || typeof binding.launchHead !== "string" ||
    !/^[a-f0-9]{40}$/i.test(binding.launchHead) || binding.launchCodeStateDigest !== manifest.codeStateDigest ||
    binding.launchCodeStateDigest !== candidate.codeStateDigest || typeof binding.launchStatusDigest !== "string" ||
    !/^[a-f0-9]{64}$/i.test(binding.launchStatusDigest) ||
    binding.launchDirty !== (binding.launchStatusDigest !== EMPTY_SHA256) ||
    binding.effectiveBase !== candidate.sourceBase || !/^[a-f0-9]{40}$/i.test(String(binding.effectiveBase)) ||
    !/^[a-f0-9]{40}$/i.test(candidate.head) || !Array.isArray(binding.axes) || binding.axes.length !== 2
  ) return false;
  const artifacts = artifactsValue.map((artifact): Record<string, unknown> | undefined =>
    artifact && typeof artifact === "object" && !Array.isArray(artifact) ? artifact as Record<string, unknown> : undefined);
  const roles = new Set<string>();
  const keys = new Set<string>();
  const resolvedBases = new Set<string>();
  const validAxes = binding.axes.every((axisValue): boolean => {
    if (!axisValue || typeof axisValue !== "object" || Array.isArray(axisValue)) return false;
    const axis = axisValue as Record<string, unknown>;
    if (Object.keys(axis).length !== 4 || (axis.role !== "standards" && axis.role !== "spec") ||
      roles.has(axis.role) || typeof axis.workflowKey !== "string" || keys.has(axis.workflowKey) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(axis.workflowKey) ||
      typeof axis.taskDigest !== "string" || !/^[a-f0-9]{64}$/i.test(axis.taskDigest) ||
      typeof axis.resolvedBase !== "string" || !/^[a-f0-9]{40}$/i.test(axis.resolvedBase) ||
      !artifacts.some((artifact): boolean => artifact?.role === axis.role && artifact?.workflowKey === axis.workflowKey)
    ) return false;
    roles.add(axis.role);
    keys.add(axis.workflowKey);
    resolvedBases.add(axis.resolvedBase);
    return true;
  });
  return validAxes && roles.has("standards") && roles.has("spec") && resolvedBases.size === 1;
}

function isRetainedReviewArtifact(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  return Object.keys(artifact).length === 7 && (artifact.role === "standards" || artifact.role === "spec") &&
    typeof artifact.workflowKey === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(artifact.workflowKey) &&
    typeof artifact.reviewerSession === "string" && isAbsolute(artifact.reviewerSession) && artifact.reviewerSession.length <= 4_096 &&
    typeof artifact.reference === "string" && isAbsolute(artifact.reference) && artifact.reference.length <= 4_096 &&
    typeof artifact.digest === "string" && /^[a-f0-9]{64}$/i.test(artifact.digest) &&
    (artifact.verdict === "OK" || artifact.verdict === "OK with notes") &&
    typeof artifact.report === "string" && artifact.report.length > 0 &&
    createHash("sha256").update(artifact.report).digest("hex") === artifact.digest;
}

async function readBoundedRegularFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_NATIVE_EVIDENCE_BYTES) {
      throw new Error("Native evidence artifact is not a bounded regular file");
    }
    const bytes = Buffer.alloc(MAX_NATIVE_EVIDENCE_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead === 0 || bytesRead > MAX_NATIVE_EVIDENCE_BYTES) {
      throw new Error("Native evidence artifact is empty or exceeds its bound");
    }
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function hash(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
