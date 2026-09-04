/// <reference types="vite/client" />
import type { Api } from '@shared/types'

declare global {
  interface Window {
    api: Api
    /** only the floating clipboard overlay's page has this one */
  }
}

export {}
