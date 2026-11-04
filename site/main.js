(function () {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const $ = (s, root = document) => root.querySelector(s)
  const $$ = (s, root = document) => [...root.querySelectorAll(s)]

  /* Sparks rise from behind the app window, the one thing only a forge would have. */
  function sparks(canvas, rate, spawnY) {
    if (!canvas || reduce) return
    const ctx = canvas.getContext('2d')
    const list = []
    let w = 0
    let h = 0
    let visible = false
    let raf = 0
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const size = () => {
      w = canvas.offsetWidth
      h = canvas.offsetHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const spawn = () => {
      const fromCenter = (Math.random() - 0.5) * Math.random() * 2
      list.push({
        x: w / 2 + fromCenter * w * 0.46,
        y: spawnY(h),
        vx: (Math.random() - 0.5) * 0.8 + fromCenter * 0.7,
        vy: -(Math.random() * 2.6 + 0.8),
        life: 1,
        decay: Math.random() * 0.007 + 0.003,
        r: Math.random() * 1.5 + 0.5,
        wobble: Math.random() * 6.28
      })
    }
    const frame = () => {
      raf = requestAnimationFrame(frame)
      ctx.clearRect(0, 0, w, h)
      for (let i = 0; i < rate; i++) if (Math.random() < 0.5 && list.length < 120) spawn()
      ctx.globalCompositeOperation = 'lighter'
      for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i]
        s.wobble += 0.04
        s.x += s.vx + Math.sin(s.wobble) * 0.35
        s.y += s.vy
        s.vy *= 0.997
        s.life -= s.decay
        if (s.life <= 0 || s.y < -10) {
          list.splice(i, 1)
          continue
        }
        const a = s.life * s.life
        ctx.beginPath()
        ctx.fillStyle = `rgba(190,180,255,${a})`
        ctx.shadowColor = '#8f83ff'
        ctx.shadowBlur = 12
        ctx.arc(s.x, s.y, s.r, 0, 6.3)
        ctx.fill()
        ctx.beginPath()
        ctx.strokeStyle = `rgba(160,150,255,${a * 0.5})`
        ctx.lineWidth = s.r * 0.7
        ctx.moveTo(s.x, s.y)
        ctx.lineTo(s.x - s.vx * 3, s.y - s.vy * 3)
        ctx.stroke()
      }
    }
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      cancelAnimationFrame(raf)
      if (visible) {
        size()
        frame()
      }
    }).observe(canvas)
    addEventListener('resize', () => { if (visible) size() })
  }
  sparks($('#sparks'), 1, (h) => Math.min(h * 0.6, 780) + Math.random() * 120)
  sparks($('#sparks2'), 1, (h) => h)

  /* Scroll: the window flattens toward you, and the bar at the top fills. */
  const win = $('#window')
  const stage = $('#stage')
  const progress = $('#progress')
  let ticking = false
  const onScroll = () => {
    ticking = false
    const max = document.documentElement.scrollHeight - innerHeight
    progress.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`
    if (reduce) return
    const rect = stage.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, 1 - (rect.top - innerHeight * 0.14) / (innerHeight * 0.7)))
    win.style.setProperty('--tilt', `${(1 - t) * 20}deg`)
    win.style.setProperty('--zoom', String(0.94 + t * 0.06))
  }
  addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true
      requestAnimationFrame(onScroll)
    }
  }, { passive: true })
  onScroll()

  /* Reveal sections as they arrive, one after another. */
  const showAll = (el) => el.classList.add('in')
  const reveals = $$('.reveal')
  $$('.bento,.stat-grid,.oses').forEach((group) => $$('.reveal', group).forEach((el, i) => el.style.setProperty('--i', i)))
  if (reduce || !('IntersectionObserver' in window)) reveals.forEach(showAll)
  else {
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          showAll(entry.target)
          seen.unobserve(entry.target)
        }
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' })
    reveals.forEach((el) => seen.observe(el))
  }

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

  /* Cards light up where the pointer is. */
  $$('.card').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect()
      card.style.setProperty('--x', `${e.clientX - r.left}px`)
      card.style.setProperty('--y', `${e.clientY - r.top}px`)
    })
  })

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

  /* Works-with strip */
  const names = ['MLX', 'Ollama', 'LM Studio', 'Anthropic', 'OpenAI', 'TypeScript', 'JavaScript', 'Git', 'npm']
  $('#marquee').innerHTML = [...names, ...names].map((n) => `<span>${n}</span>`).join('') + [...names, ...names].map((n) => `<span>${n}</span>`).join('')

  /* Commit tree card */
  const commits = [
    { lanes: [[0, 0]], dot: 0, msg: 'Merge the checkout flow', ref: 'main', who: 'Amina' },
    { lanes: [[0, 0], [0, 1]], dot: 0, msg: 'Round tax to cents', who: 'Yacine' },
    { lanes: [[0, 0], [1, 1]], dot: 1, msg: 'Add discount codes', ref: 'checkout', who: 'Amina' },
    { lanes: [[0, 0], [1, 1]], dot: 0, msg: 'Fix the invoice total', who: 'Sara' },
    { lanes: [[0, 0], [1, 0]], dot: 1, msg: 'Start the checkout flow', who: 'Amina' },
    { lanes: [[0, 0]], dot: 0, msg: 'Add invoices', who: 'Yacine' }
  ]
  const palette = ['#7c7ff5', '#34d399']
  const x = (l) => 8 + l * 16
  $('#graph').innerHTML = commits.map((c, i) => `
    <div class="graph-row" style="--r:${i}">
      <svg width="42" height="32">
        ${c.lanes.map(([a, b]) => `<path style="--r:${i}" d="M${x(a)} 0 V8 C${x(a)} 20 ${x(b)} 14 ${x(b)} 32" fill="none" stroke="${palette[Math.max(a, b)]}" stroke-width="1.6"/>`).join('')}
        <circle cx="${x(c.dot)}" cy="16" r="4.2" fill="${palette[c.dot]}" stroke="#101016" stroke-width="2"/>
      </svg>
      ${c.ref ? `<span class="ref">${c.ref}</span>` : ''}
      <span class="msg">${c.msg}</span>
      <span class="who">${c.who}</span>
    </div>`).join('')

  /* Terminal card */
  const typing = $('#typing')
  const script = [
    ['p', '$ '], ['t', 'npm test\n'], ['o', 'Tests  17 passed (17)\n'],
    ['p', '$ '], ['t', 'git status\n'], ['o', 'On branch checkout\nnothing to commit\n'],
    ['p', '$ '], ['t', 'npm run build\n'], ['k', 'Build finished\n']
  ]
  function typeTerminal() {
    if (reduce) {
      typing.innerHTML = script.map(([k, s]) => `<span class="${k === 'p' ? 'p' : k === 'k' ? 'ok' : ''}">${s}</span>`).join('')
      return
    }
    typing.innerHTML = ''
    let part = 0
    let pos = 0
    let current = null
    const next = () => {
      if (part >= script.length) {
        setTimeout(typeTerminal, 3200)
        return
      }
      const [kind, text] = script[part]
      if (pos === 0) {
        current = document.createElement('span')
        if (kind === 'p') current.className = 'p'
        if (kind === 'k') current.className = 'ok'
        typing.appendChild(current)
      }
      if (kind === 't') {
        current.textContent += text[pos++]
        if (pos >= text.length) { part++; pos = 0; setTimeout(next, 260) } else setTimeout(next, 42 + Math.random() * 46)
      } else {
        current.textContent = text
        part++
        pos = 0
        setTimeout(next, kind === 'p' ? 130 : 200)
      }
    }
    next()
  }
  new IntersectionObserver(([e], o) => {
    if (e.isIntersecting) {
      o.disconnect()
      typeTerminal()
    }
  }, { threshold: 0.2 }).observe(typing)

  /* Effort card */
  const bars = $$('#bars i')
  const picks = $$('.effort-picks button')
  const setEffort = (n) => {
    bars.forEach((b, i) => b.classList.toggle('lit', i < n))
    picks.forEach((p) => p.classList.toggle('on', Number(p.dataset.e) === n))
  }
  picks.forEach((p) => { p.onclick = () => setEffort(Number(p.dataset.e)) })
  setEffort(3)

  /* Ways switch */
  const tabs = $$('.way-switch button')
  const panels = $$('.way-panel')
  const pill = $('#way-pill')
  const movePill = () => {
    const on = tabs.find((t) => t.getAttribute('aria-selected') === 'true')
    pill.style.width = `${on.offsetWidth}px`
    pill.style.transform = `translateX(${on.offsetLeft}px)`
  }
  tabs.forEach((tab, i) => {
    tab.onclick = () => {
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)))
      panels.forEach((p, j) => p.classList.toggle('on', j === i))
      movePill()
    }
  })
  movePill()
  addEventListener('resize', movePill)
  document.fonts?.ready.then(movePill)

  /* Numbers count up once. */
  const countUp = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      countUp.unobserve(entry.target)
      if (reduce) continue
      const end = Number(entry.target.dataset.count)
      const start = performance.now()
      const step = (now) => {
        const t = Math.min(1, (now - start) / 1300)
        entry.target.textContent = String(Math.round(end * (1 - Math.pow(1 - t, 3))))
        if (t < 1) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }
  }, { threshold: 0.4 })
  $$('[data-count]').forEach((el) => countUp.observe(el))

  /* Point the main button at the right download. */
  const ua = navigator.userAgent
  const os = /Windows/.test(ua) ? 'windows' : /Linux|X11/.test(ua) && !/Android/.test(ua) ? 'linux' : /Macintosh/.test(ua) ? 'mac' : null
  if (os) {
    const card = $(`.os[data-os="${os}"]`)
    card.classList.add('yours')
    const hero = $('#hero-download')
    hero.lastChild.textContent = `Download for ${{ mac: 'Mac', windows: 'Windows', linux: 'Linux' }[os]}`
    if (os !== 'mac') hero.href = $('.btn', card).href
  }
})()
