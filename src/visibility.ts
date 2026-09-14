/**
 * The one browser API this library touches: the page going away.
 *
 * Two events, because neither is enough on its own —
 *
 *   - **`visibilitychange → hidden`** is backgrounding: another tab, another
 *     app, the phone locking.
 *   - **`pagehide`** is a same-tab navigation, a refresh or a tab close — and
 *     on iOS Safari it is what a swipe-away fires. There the two do not
 *     reliably coincide, so listening for only the first flushes *nothing*.
 *
 * Not `beforeunload`: mobile browsers routinely discard a page without ever
 * firing it, and registering one costs the back/forward cache.
 *
 * The two overlap constantly — a desktop tab close fires both — so a hide
 * **latches**, and only coming back (`pageshow`, or `visibilitychange` to
 * anything but `hidden`) unlatches it. One flush per time the page goes away
 * rather than one per event, and a backgrounded tab that comes back still
 * flushes again the next time it leaves.
 *
 * It is best-effort either way: the page can be frozen before the request
 * leaves. That is what the attempt's `final` flag is for — it lets the writer
 * set `keepalive`, which is the only thing that makes a request outlive the
 * page — and why `pending` is exposed so an app can warn.
 *
 * Where there is no `document` — Node, a worker, a server render — there is no
 * page to hide, so this is a no-op rather than a feature detection failure.
 */

/** Subscribe to the page going away. Returns the unsubscribe. */
export function onPageHidden(handler: () => void): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}

  let hidden = false

  const hide = (): void => {
    if (hidden) return
    hidden = true
    handler()
  }
  const show = (): void => {
    hidden = false
  }

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') hide()
    else show()
  }

  // `pagehide`/`pageshow` are fired at the window and do not reach `document`.
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', hide)
  window.addEventListener('pageshow', show)

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', hide)
    window.removeEventListener('pageshow', show)
  }
}
