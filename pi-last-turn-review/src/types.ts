export type ReviewMode = 'last-turn' | 'git-changes'

// Kept in comment payloads so existing review comments retain their scope field.
export type ReviewScope = 'review'

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed'

export interface ReviewFileComparison {
  status: ChangeStatus
  oldPath: string | null
  newPath: string | null
  displayPath: string
  hasOriginal: boolean
  hasModified: boolean
}

export interface ReviewFile {
  id: string
  path: string
  comparison: ReviewFileComparison
}

export interface ReviewFileContents {
  originalContent: string
  modifiedContent: string
}

export type CommentSide = 'original' | 'modified' | 'file'

export interface DiffReviewComment {
  id: string
  fileId: string
  scope: ReviewScope
  side: CommentSide
  startLine: number | null
  endLine: number | null
  body: string
}

export interface ReviewSubmitPayload {
  type: 'submit'
  overallComment: string
  comments: DiffReviewComment[]
}

export interface ReviewCancelPayload {
  type: 'cancel'
}

export interface ReviewRendererErrorPayload {
  type: 'renderer-error'
  message: string
}

export interface ReviewCopyTextPayload {
  type: 'copy-text'
  text: string
}

export interface ReviewRequestFilePayload {
  type: 'request-file'
  requestId: string
  fileId: string
  scope: ReviewScope
}

export type ReviewWindowMessage =
  | ReviewSubmitPayload
  | ReviewCancelPayload
  | ReviewRendererErrorPayload
  | ReviewCopyTextPayload
  | ReviewRequestFilePayload

export interface AnnotateComment {
  id: string
  line: number
  body: string
}

export interface AnnotateSubmitPayload {
  type: 'submit'
  overallComment: string
  comments: AnnotateComment[]
}

export interface AnnotateCancelPayload {
  type: 'cancel'
}

export interface AnnotateRendererErrorPayload {
  type: 'renderer-error'
  message: string
}

export interface AnnotateCopyTextPayload {
  type: 'copy-text'
  text: string
}

export type AnnotateWindowMessage =
  | AnnotateSubmitPayload
  | AnnotateCancelPayload
  | AnnotateRendererErrorPayload
  | AnnotateCopyTextPayload

export interface AnnotateWindowData {
  title: string
  sourceLabel: string
  sourceHint: string
  text: string
  theme: ReviewTheme
}

export interface ReviewFileDataMessage {
  type: 'file-data'
  requestId: string
  fileId: string
  scope: ReviewScope
  originalContent: string
  modifiedContent: string
}

export interface ReviewFileErrorMessage {
  type: 'file-error'
  requestId: string
  fileId: string
  scope: ReviewScope
  message: string
}

export type ReviewHostMessage = ReviewFileDataMessage | ReviewFileErrorMessage

export interface ReviewTheme {
  appearance: 'dark' | 'light'
  bg: string
  panel: string
  hover: string
  active: string
  badge: string
  border: string
  text: string
  strong: string
  muted: string
  dim: string
  accent: string
  success: string
  error: string
  warning: string
  diffAdded: string
  diffRemoved: string
}

export interface ReviewWindowData {
  title: string
  repoRoot: string
  mode: ReviewMode
  scopeLabel: string
  scopeHint: string
  theme: ReviewTheme
  files: ReviewFile[]
}
