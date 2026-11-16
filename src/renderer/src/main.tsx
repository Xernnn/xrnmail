import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Boundary } from './Common'
import './style.css'

/** Whatever goes wrong drawing the window, it never just goes white: it says so, and draws itself again. */
function Stopped(): ReactNode {
  return (
    <div className="stopped" role="alert">
      <p>xrnmail couldn't draw this window.</p>
      <button type="button" className="pill" onClick={() => window.location.reload()}>Draw it again</button>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Boundary fallback={() => <Stopped />}>
      <App />
    </Boundary>
  </StrictMode>
)
