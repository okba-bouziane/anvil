import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// The editor cancels work as you type or close a view, and reports it as an error. Neither of these is one.
const harmless = (reason: unknown) => {
  const error = reason as Error | undefined
  return error?.name === 'Canceled' || error?.message === 'no diff result available'
}
window.addEventListener('unhandledrejection', (e) => {
  if (harmless(e.reason)) e.preventDefault()
})
window.addEventListener('error', (e) => {
  if (harmless(e.error)) e.preventDefault()
})

// The terminal measures its font once, when it opens, so have the font ready by then.
void document.fonts.load("12px 'JetBrains Mono'")

createRoot(document.getElementById('root')!).render(<App />)
