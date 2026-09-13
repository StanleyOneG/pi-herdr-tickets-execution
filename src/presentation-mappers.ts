import type { AcceptCandidateRequest, NativeEvidenceRecord } from "./contracts.js";

/** Maps an untrusted acceptance DTO into a detached application command. */
export function mapAcceptCandidateCommand(value: unknown): AcceptCandidateRequest {
  if (!isObjectWithKeys(value, ["attemptId", "candidateDigest", "nativeEvidence"]) ||
    !boundedText(value.attemptId) || !digestText(value.candidateDigest) ||
    !Array.isArray(value.nativeEvidence) || value.nativeEvidence.length < 2 || value.nativeEvidence.length > 20
  ) throw new Error("Malformed acceptance command DTO");
  const nativeEvidence = value.nativeEvidence.map(mapNativeEvidence);
  return { attemptId: value.attemptId, candidateDigest: value.candidateDigest, nativeEvidence };
}

function mapNativeEvidence(value: unknown): NativeEvidenceRecord {
  if (!isObjectWithKeys(value, ["kind", "status", "codeStateDigest", "evidenceReference", "evidenceDigest", "completedAt"]) ||
    (value.kind !== "tests" && value.kind !== "reviews") || value.status !== "passed" ||
    !digestText(value.codeStateDigest) || !boundedText(value.evidenceReference) || !digestText(value.evidenceDigest) ||
    typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))
  ) throw new Error("Malformed native evidence DTO");
  return {
    kind: value.kind,
    status: value.status,
    codeStateDigest: value.codeStateDigest,
    evidenceReference: value.evidenceReference,
    evidenceDigest: value.evidenceDigest,
    completedAt: value.completedAt,
  };
}

function isObjectWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key): boolean => key in value);
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4_096;
}

function digestText(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
