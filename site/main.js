(function () {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const $ = (s, root = document) => root.querySelector(s)
  const $$ = (s, root = document) => [...root.querySelectorAll(s)]

  /* A slow, quiet field of dots behind the headline. It stops whenever it's off screen. */
  ;(function field() {
    const canvas = $('#field')
    const hero = $('#hero')
    const ctx = canvas.getContext('2d')
    let w = 0, h = 0, dpr = 1, dots = [], raf = 0, last = 0, start = 0, visible = false
    const pointer = { x: -999, y: -999 }
    const smooth = (a, b, x) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
      return t * t * (3 - 2 * t)
    }
    function build() {
      const box = canvas.getBoundingClientRect()
      w = box.width
      h = box.height
      dpr = Math.min(devicePixelRatio || 1, 1.5)
      canvas.width = w * dpr
      canvas.height = h * dpr
      const cell = w < 700 ? 20 : 17
      dots = []
      for (let y = cell / 2; y < h; y += cell) {
        for (let x = cell / 2; x < w; x += cell) {
          // Clear behind the text, and gone by the bottom, where the product window begins.
          const fromCenter = Math.hypot((x - w / 2) / (w * 0.42), (y - h * 0.46) / (h * 0.42))
          const keep = smooth(0.62, 1.15, fromCenter) * (1 - smooth(h * 0.62, h, y))
          if (keep > 0.01) dots.push({ x, y, keep })
        }
      }
    }
    function paint(t) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = 'rgb(190,182,168)'
      for (const d of dots) {
        const wave = Math.sin(d.x * 0.0062 + t * 0.26) + Math.sin(d.y * 0.0091 - t * 0.19) + Math.sin((d.x + d.y) * 0.0041 + t * 0.13)
        const level = Math.max(0, (wave + 1.1) / 4)
        const near = Math.max(0, 1 - Math.hypot(d.x - pointer.x, d.y - pointer.y) / 180)
        ctx.globalAlpha = Math.min(0.7, (level * level * 0.75 + 0.03) * d.keep + near * near * 0.32)
        const size = 1.3 + level * 1.1
        ctx.fillRect(d.x, d.y, size, size)
      }
      ctx.globalAlpha = 1
    }
    function frame(ms) {
      raf = requestAnimationFrame(frame)
      if (ms - last < 40) return
      last = ms
      if (!start) start = ms
      paint((ms - start) / 1000)
    }
    build()
    if (reduce) return paint(0)
    const run = () => {
      cancelAnimationFrame(raf)
      if (visible && !document.hidden) raf = requestAnimationFrame(frame)
    }
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      run()
    }, { threshold: 0.02 }).observe(hero)
    document.addEventListener('visibilitychange', run)
    let resizeTimer = 0
    addEventListener('resize', () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(build, 150)
    })
    hero.addEventListener('pointermove', (e) => {
      const box = canvas.getBoundingClientRect()
      pointer.x = e.clientX - box.left
      pointer.y = e.clientY - box.top
    }, { passive: true })
    hero.addEventListener('pointerleave', () => { pointer.x = pointer.y = -999 })
  })()

  /* Scroll: the top line and the story rail fill as you read. */
  const progress = $('#progress')
  const nav = $('.nav')
  const rail = $('#rail')
  const railBox = $('#story-steps')
  const win = $('#window')
  let ticking = false
  const onScroll = () => {
    ticking = false
    const max = document.documentElement.scrollHeight - innerHeight
    progress.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`
    nav.classList.toggle('stuck', scrollY > 8)
    const box = railBox.getBoundingClientRect()
    rail.style.transform = `scaleY(${Math.min(1, Math.max(0, (innerHeight * 0.55 - box.top) / box.height))})`
  }
  addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true
      requestAnimationFrame(onScroll)
    }
  }, { passive: true })
  addEventListener('resize', onScroll)
  onScroll()

  /* The pinned story swaps the screenshot beside each step. */
  const shots = $$('.story-frame .shot')
  const stepObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      $$('.story-step').forEach((s) => s.classList.toggle('on', s === entry.target))
      const index = Number(entry.target.dataset.shot)
      shots.forEach((img, i) => img.classList.toggle('on', i === index))
    }
  }, { rootMargin: '-45% 0px -45% 0px' })
  $$('.story-step').forEach((s) => stepObserver.observe(s))
  $('.story-step')?.classList.add('on')

  /* Each feature's picture rises in once, when it arrives. */
  const arrive = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      entry.target.classList.add('in')
      arrive.unobserve(entry.target)
    }
  }, { threshold: 0.2 })
  $$('.feature').forEach((f) => arrive.observe(f))

  /* Hero demo: a replay of a real run. */
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const color = (s) => esc(s)
    .replace(/\b(import|from|export|function|const|return|interface)\b/g, '<span class="k">$1</span>')
    .replace(/\b(number|Line)\b/g, '<span class="t">$1</span>')
    .replace(/\b(roundCents|subtotal|total)(?=\()/g, '<span class="f">$1</span>')
    .replace(/('[^']*')/g, '<span class="s">$1</span>')
  const base = [
    "import { roundCents } from './money.js'",
    '',
    'export function subtotal(lines: Line[]): number {',
    '  return roundCents(lines.reduce((sum, l) => sum + l.price * l.quantity, 0))',
    '}'
  ]
  const added = [
    '',
    'export function total(lines: Line[], taxRate: number): number {',
    '  const sub = subtotal(lines)',
    '  const tax = roundCents(sub * taxRate)',
    '  return roundCents(sub + tax)',
    '}'
  ]
  const code = $('#code')
  const steps = $('#steps')
  const live = $('#live')
  const wifi = $('#wifi')
  let timer = 0
  let offline = false
  let state = 'writing'
  let writing = false

  function draw(lines, hunk, cursor) {
    code.innerHTML = ''
    const all = state === 'undone' ? base : base.concat(lines)
    all.forEach((text, i) => {
      const row = document.createElement('div')
      row.className = `ln${i >= base.length && state !== 'kept' ? ' add' : ''}`
      if (i < all.length - 1 || !cursor) row.style.animation = 'none'
      row.dataset.n = String(i + 1)
      const body = document.createElement('span')
      body.innerHTML = color(text)
      row.appendChild(body)
      if (cursor && i === all.length - 1) {
        const c = document.createElement('span')
        c.className = 'cursor'
        row.appendChild(c)
      }
      if (hunk && i === base.length + 1) {
        const box = document.createElement('div')
        box.className = 'hunk'
        box.innerHTML = '<button class="keep" type="button">Keep</button><button class="undo" type="button">Undo</button>'
        $('.keep', box).onclick = () => finish('kept')
        $('.undo', box).onclick = () => finish('undone')
        row.appendChild(box)
      }
      code.appendChild(row)
    })
  }
  const stepsHtml = {
    read: '<div class="step"><i></i><b>Read</b> src/invoice.ts</div>',
    edit: '<div class="step"><i></i><b>Edit</b> src/invoice.ts</div>',
    ok: '<div class="step ok">TypeScript found no errors.</div>'
  }
  function status(speed) {
    live.innerHTML = speed ? `Writing <b>${speed}</b> tokens/s` : ''
  }
  function finish(result) {
    clearTimeout(timer)
    writing = false
    $('#win-logo')?.classList.remove('working')
    state = result
    draw(added, false, false)
    steps.innerHTML = stepsHtml.read + stepsHtml.edit + stepsHtml.ok + `<div class="step note">${result === 'kept' ? 'Kept. The change is in your file.' : 'Undone. The file is back as it was.'} <button type="button" id="again">Play again</button></div>`
    $('#again').onclick = play
    status('')
  }
  function play() {
    clearTimeout(timer)
    state = 'writing'
    writing = true
    $('#win-logo')?.classList.add('working')
    steps.innerHTML = stepsHtml.read
    if (reduce) {
      steps.innerHTML = stepsHtml.read + stepsHtml.edit + stepsHtml.ok
      writing = false
      draw(added, true, false)
      return
    }
    draw([], false, false)
    let line = 0
    let col = 0
    const shown = []
    const tick = () => {
      if (line >= added.length) {
        writing = false
        $('#win-logo')?.classList.remove('working')
        steps.innerHTML = stepsHtml.read + stepsHtml.edit + stepsHtml.ok
        draw(shown, true, false)
        status('')
        return
      }
      const target = added[line]
      col = Math.min(target.length, col + 3)
      shown[line] = target.slice(0, col)
      draw(shown, false, true)
      status('24.5')
      if (col >= target.length) {
        line++
        col = 0
      }
      timer = setTimeout(tick, 42)
    }
    timer = setTimeout(() => {
      steps.innerHTML = stepsHtml.read + stepsHtml.edit
      tick()
    }, 700)
  }
  wifi.onclick = () => {
    offline = !offline
    wifi.setAttribute('aria-checked', String(offline))
    $('#wifi-label').textContent = offline ? 'Wi-Fi off' : 'Wi-Fi on'
    $('#where').textContent = offline ? 'Wi-Fi off. Still working, and your code stays here.' : 'Stays on this computer'
    win.classList.toggle('offline', offline)
    if (!writing && (state === 'kept' || state === 'undone')) play()
  }
  draw([], false, false)
  const heroSeen = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      heroSeen.disconnect()
      setTimeout(play, reduce ? 0 : 900)
    }
  }, { threshold: 0.2 })
  heroSeen.observe(code)

  /* Put the visitor's own system first, and point the main button at it. */
  const ua = navigator.userAgent
  const os = /Windows/.test(ua) ? 'windows' : /Linux|X11/.test(ua) && !/Android/.test(ua) ? 'linux' : /Macintosh/.test(ua) ? 'mac' : null
  if (os) {
    const row = $(`.os[data-os="${os}"]`)
    row.classList.add('yours')
    const link = $('.btn', row)
    link.classList.add('primary')
    const hero = $('#hero-download')
    hero.textContent = `Download for ${{ mac: 'Mac', windows: 'Windows', linux: 'Linux' }[os]}`
    if (os !== 'mac') hero.href = link.href
  }
})()
