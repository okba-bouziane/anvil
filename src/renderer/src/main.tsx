import { Component, type ReactNode } from 'react'
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

/** Saved work is on disk or in the recovery copy, so reloading is the safe way out of a broken screen. */
class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h1>Something broke in this window</h1>
        <p>Reload to keep working. Your files and chats are saved.</p>
        <button className="primary" onClick={() => window.location.reload()}>Reload</button>
        <pre>{this.state.error.message}</pre>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(<CrashScreen><App /></CrashScreen>)
