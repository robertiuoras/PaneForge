/** Durable, agent-authored handoffs for human review. */
export type ReviewKind = "result" | "decision" | "blocked" | "closed";
export type ReviewProof = "measured" | "claimed" | "unverified";
export interface ReviewLink {
  label: string;
  url: string;
}
export interface ReviewInput {
  id: string;
  sessionId: string;
  nativeSessionId?: string;
  kind: ReviewKind;
  report: string;
  prompt?: string;
  lane?: string;
  proof: ReviewProof;
  evidence?: string[];
  links?: ReviewLink[];
  completedAt?: string;
  capturedAt?: string;
  closeSession?: boolean;
  notify?: boolean;
  workPreserved?: boolean;
  noRemainingWork?: boolean;
}
export interface ReviewRecord extends ReviewInput {
  nativeSessionId: string;
  prompt: string;
  title: string;
  provider: string;
  cwd: string;
  reportPath: string;
  createdAt: string;
  closedAt?: string;
  reviewedAt?: string;
  attention: boolean;
  closeBlocked?: string;
  payloadHash?: string;
  noticeSentAt?: string;
}
