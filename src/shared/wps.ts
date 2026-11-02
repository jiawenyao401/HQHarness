/** Native WPS setup status. Registration and an active document connection are
 * separate states; neither implies that an edit/save has been verified. */
export interface WpsStatus {
  supported: boolean
  registered: boolean
  connectedDocuments: number
  connectedComponents: string[]
  frozenDocuments: number
  needsWpsRestart: boolean
  error?: string
}
