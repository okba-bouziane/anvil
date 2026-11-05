(function () {
  const FACE = '<svg viewBox="0 0 34 30" aria-hidden="true"><path d="M4 11L4.500 3c.1-1.200 1.400-1.700 2.300-.8L13 7zM30 11l-.5-8c-.1-1.200-1.400-1.700-2.300-.8L21 7z" fill="#f6a04d"/><ellipse cx="17" cy="16" rx="15" ry="13" fill="#f6a04d"/><g class="cat-eyes"><circle cx="10.500" cy="15" r="3.300" fill="#2fc06c"/><circle cx="23.500" cy="15" r="3.300" fill="#2fc06c"/><g class="cat-pupil"><circle cx="10.500" cy="15" r="2" fill="#201a16"/><circle cx="23.500" cy="15" r="2" fill="#201a16"/><circle cx="11.300" cy="14" r=".7" fill="#fff"/><circle cx="24.300" cy="14" r=".7" fill="#fff"/></g></g><path d="M15.500 20q1.500 1.500 3 0" stroke="#7a4220" stroke-width="1" fill="none" stroke-linecap="round"/><ellipse cx="6" cy="20" rx="2.500" ry="1.400" fill="#ff8f9a" opacity=".7"/><ellipse cx="28" cy="20" rx="2.500" ry="1.400" fill="#ff8f9a" opacity=".7"/></svg>'
  const WALK = '<svg viewBox="0 0 48 30" aria-hidden="true"><path class="cat-tail" d="M9 19C3 16 3 9 7 5" stroke="#f6a04d" stroke-width="5" fill="none" stroke-linecap="round"/><rect class="cat-leg" x="11" y="20" width="5" height="9" rx="2.500" fill="#d9772a"/><rect class="cat-leg b" x="26" y="20" width="5" height="9" rx="2.500" fill="#d9772a"/><rect x="8" y="11" width="28" height="14" rx="7" fill="#f6a04d"/><rect class="cat-leg b" x="14" y="20" width="5" height="9" rx="2.500" fill="#f6a04d"/><rect class="cat-leg" x="29" y="20" width="5" height="9" rx="2.500" fill="#f6a04d"/><path d="M27 8L28 1.500c.2-1 1.200-1.200 2-.5L35 5zM43 8L42 1.500c-.2-1-1.200-1.200-2-.5L35 5z" fill="#f6a04d"/><ellipse cx="35" cy="12" rx="10" ry="9" fill="#f6a04d"/><circle cx="31" cy="11.500" r="2.300" fill="#2fc06c"/><circle cx="39" cy="11.500" r="2.300" fill="#2fc06c"/><circle cx="31.300" cy="11.500" r="1.350" fill="#201a16"/><circle cx="39.300" cy="11.500" r="1.350" fill="#201a16"/><path d="M34 15q1 1 2 0" stroke="#7a4220" stroke-width=".9" fill="none" stroke-linecap="round"/></svg>'
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  document.querySelectorAll('[data-logo]').forEach((slot) => { slot.innerHTML = FACE })

  const peek = document.querySelector('.nav .cat-peek')
  const word = document.querySelector('.nav .brand .word')
  if (peek && word) {
    peek.innerHTML = FACE
    // The cat only walks once per visit. Other pages open with it already sitting there.
    let walked = false
    try { walked = sessionStorage.getItem('pitoo-walked') === '1' } catch { /* private mode */ }
    if (reduce || walked) peek.classList.add('out')
    else {
      const box = word.getBoundingClientRect()
      const track = document.createElement('div')
      track.className = 'cat-track'
      track.setAttribute('aria-hidden', 'true')
      track.style.top = `${box.bottom - 27}px`
      track.style.width = `${box.left}px`
      track.innerHTML = `<div class="cat-walker">${WALK}</div>`
      document.body.append(track)
      const walker = track.firstChild
      // The same pace on every screen: the cat reaches the name, then disappears behind it.
      walker.style.setProperty('--cat-end', `${box.left}px`)
      walker.style.setProperty('--cat-time', `${Math.max(1.2, (box.left + 44) / 62)}s`)
      walker.addEventListener('animationend', (e) => {
        if (e.animationName !== 'cat-cross') return
        track.remove()
        setTimeout(() => peek.classList.add('out'), 250)
        try { sessionStorage.setItem('pitoo-walked', '1') } catch { /* private mode */ }
      })
      setTimeout(() => walker.classList.add('go'), 500)
    }
    // Point at the name and the cat ducks behind it, then looks again.
    word.closest('a').addEventListener('pointerenter', () => {
      if (reduce) return
      peek.classList.remove('out')
      setTimeout(() => peek.classList.add('out'), 520)
    })
  }
  if (!reduce) {
    const faces = () => document.querySelectorAll('.cat-peek svg, [data-logo] svg')
    document.addEventListener('pointermove', (e) => {
      faces().forEach((svg) => {
        const box = svg.getBoundingClientRect()
        if (!box.width) return
        const dx = e.clientX - (box.left + box.width / 2)
        const dy = e.clientY - (box.top + box.height / 2)
        const d = Math.hypot(dx, dy) || 1
        const pupil = svg.querySelector('.cat-pupil')
        if (pupil) pupil.style.transform = `translate(${(dx / d * 1.1).toFixed(2)}px,${(dy / d * 1.1).toFixed(2)}px)`
      })
    }, { passive: true })
  }
})()
