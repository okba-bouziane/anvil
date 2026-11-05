import type { PitooApi } from '../../shared/types'

declare global {
  interface Window {
    pitoo: PitooApi
  }
}
