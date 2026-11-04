import type { AnvilApi } from '../../shared/types'

declare global {
  interface Window {
    anvil: AnvilApi
  }
}
