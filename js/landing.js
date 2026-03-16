/**
 * landing.js — Counter animations and scroll reveal for the landing page.
 */

// ── Number counter ──────────────────────────────────────────────────────
function animateCounter(el) {
  const target = parseFloat(el.dataset.target);
  const prefix = el.dataset.prefix || '';
  const suffix = el.dataset.suffix || '';
  const isDecimal = String(target).includes('.');
  const duration = 1800;
  const start = performance.now();

  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 4); // easeOutQuart
    const value = target * eased;
    el.textContent = prefix + (isDecimal ? value.toFixed(1) : Math.round(value)) + suffix;
    if (progress < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

document.addEventListener('DOMContentLoaded', () => {
  // Start counters after a short delay (hero animation settles)
  setTimeout(() => {
    document.querySelectorAll('.hc-val').forEach(animateCounter);
  }, 500);

  // ── Scroll reveal ────────────────────────────────────────────────────
  const revealObs = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        revealObs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });

  document.querySelectorAll('.reveal').forEach(el => revealObs.observe(el));

  // ── Bar animations: trigger when section scrolls into view ───────────
  const barObs = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.querySelectorAll('.rep-bar, .r4-bar').forEach(bar => {
          bar.classList.add('animate');
        });
        barObs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.25 });

  const lb = document.querySelector('.leaderboard');
  if (lb) barObs.observe(lb);

  const rg = document.querySelector('.reg4-grid');
  if (rg) barObs.observe(rg);
});
