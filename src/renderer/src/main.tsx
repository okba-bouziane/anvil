import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// The editor cancels requests as you type, and reports each one this way. They aren't errors.
window.addEventListener('unhandledrejection', (e) => {
  if ((e.reason as Error)?.name === 'Canceled') e.preventDefault()
})

createRoot(document.getElementById('root')!).render(<App />)
