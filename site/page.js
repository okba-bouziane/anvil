(function () {
  const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true"><g class="logo-body"><path class="logo-fill" d="M3.5 19.5C12 20.5 17 17 23 14C25 13 27 12 30 12H56C59.5 12 62 14.5 62 18V26C62 29 60 31 57 31.3C52 31.8 47.5 34 46 38V41C46 44.5 49 47 53.5 48C56 48.6 57 50 57 52V54C57 56 55.6 57.4 53.6 57.4H18.4C16.4 57.4 15 56 15 54V52C15 50 16 48.6 18.5 48C23 47 26 44.5 26 41V38C25 33 13 26 3.5 22.5C1.8 21.8 1.8 19.4 3.5 19.5Z"/><g class="logo-eyes"><circle class="logo-eye" cx="35" cy="21" r="3"/><circle class="logo-eye" cx="49" cy="21" r="3"/></g><path class="logo-happy" d="M31.5 22C32.5 19 37.500 19 38.500 22M45.500 22C46.500 19 51.500 19 52.500 22"/><path class="logo-smile" d="M39.500 25.500C40.500 27.500 43.500 27.500 44.500 25.500"/></g><path class="logo-star" style="--d:0s" transform="translate(6 8)" d="M0-5C.6-1.6 1.6-.6 5 0C1.6.6.6 1.6 0 5C-.6 1.6-1.6.6-5 0C-1.6-.6-.6-1.6 0-5Z"/><path class="logo-star" style="--d:.06s" transform="translate(62 4) scale(.8)" d="M0-5C.6-1.6 1.6-.6 5 0C1.6.6.6 1.6 0 5C-.6 1.6-1.6.6-5 0C-1.6-.6-.6-1.6 0-5Z"/><path class="logo-star" style="--d:.12s" transform="translate(34 2) scale(.6)" d="M0-5C.6-1.6 1.6-.6 5 0C1.6.6.6 1.6 0 5C-.6 1.6-1.6.6-5 0C-1.6-.6-.6-1.6 0-5Z"/></svg>`
  document.querySelectorAll('[data-logo]').forEach((slot, i) => {
    slot.classList.add('logo')
    slot.innerHTML = LOGO.replaceAll('lgID', `lg${i}`)
    const hop = () => {
      slot.classList.remove('hop')
      void slot.getBoundingClientRect()
      slot.classList.add('hop')
    }
    slot.closest('a')?.addEventListener('pointerenter', hop)
  })
  // The side list marks the section you are reading.
  const links = [...document.querySelectorAll('.doc-side a')]
  if (links.length) {
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) links.forEach((a) => a.classList.toggle('on', a.hash === `#${entry.target.id}`))
      }
    }, { rootMargin: '-20% 0px -70% 0px' })
    document.querySelectorAll('.doc-main section').forEach((s) => seen.observe(s))
  }
})()
