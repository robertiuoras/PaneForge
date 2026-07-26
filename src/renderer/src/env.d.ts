/// <reference types="vite/client" />
import type { Api, ShelfApi } from '@shared/types'

declare global {
  interface Window {
    api: Api
    /** only the floating clipboard overlay's page has this one */
    shelf: ShelfApi
  }
}

export {}
