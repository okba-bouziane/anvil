(function () {
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
