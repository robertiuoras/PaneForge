export interface PaneAnswerIdentity {
  paneId: string
  expectedConversationId: string
  requestId: string
}
export interface PaneAnswerRequest extends PaneAnswerIdentity {
  text: string
  toolUseId: string
  questionCount: number
}
export interface PaneAnswerReceipt extends PaneAnswerIdentity {
  state: 'waiting' | 'submitted' | 'confirmed' | 'uncertain' | 'rejected'
  acceptedAt: number
  submittedAt?: number
  confirmedAt?: number
  transcriptAt?: number
  reason?: string
}
