// MyPACS: load in <head>, before the page is shown. Pages change with a cross-document view transition (fx.css,
// @view-transition). When the browser has to skip one (a tab in the background, a quick second click, a page that
// was already drawn), the transition's promises reject. Nothing waits on them, so mark them handled; otherwise the
// console shows "Uncaught (in promise) InvalidStateError: Transition was aborted because of invalid state.
// Page already revealed". The page itself is fine either way: only the animation is skipped.
(function () {
  const quiet = e => {
    const t = e.viewTransition; if (!t) return;
    for (const p of [t.ready, t.finished, t.updateCallbackDone]) if (p && typeof p.catch === 'function') p.catch(() => {});
  };
  addEventListener('pagereveal', quiet);   // the page being opened
  addEventListener('pageswap', quiet);     // the page being left
})();
