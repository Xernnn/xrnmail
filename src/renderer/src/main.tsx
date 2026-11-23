import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { soloFrom } from '@shared/solo'
import { App } from './App'
import { Boundary } from './Common'
import { Letter } from './Letter'
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

/** A message opened from a file has a window of its own that's nothing else. */
const SOLO = soloFrom(window.location.search)

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Boundary fallback={() => <Stopped />}>
      {SOLO?.kind === 'file' ? <Letter token={SOLO.file} /> : <App />}
    </Boundary>
  </StrictMode>
)
