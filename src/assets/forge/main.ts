// Asset Forge entry.
//
// Two modes share this page:
//   Assets        — library contact sheets (default)
//   Environments  — live biome preview + style editor (`?mode=env`)
//
// ARCHITECTURE: "Separate Vite entry at /forge, sharing the game's renderer,
// sky, and material... Viewport running the game's ACTUAL atmosphere and post
// — WYSIWYG or the tool is useless."

import { bootEnvEditor } from './envEditor'
import { bootAssetViewer } from './assetViewer'

function wireChrome(): void {
  const q = new URLSearchParams(location.search)
  const mode = q.get('mode') === 'env' ? 'env' : 'assets'
  // Body uses data-forge-mode — NOT data-mode. data-mode is the tab buttons'
  // selector, and putting it on <body> made every bubbled click navigate.
  document.body.dataset.forgeMode = mode
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.forge-mode [data-mode]')) {
    btn.classList.toggle('on', btn.dataset.mode === mode)
    btn.addEventListener('click', () => {
      const next = new URL(location.href)
      if (btn.dataset.mode === 'env') next.searchParams.set('mode', 'env')
      else next.searchParams.delete('mode')
      // Drop asset-only framing when entering env, and vice versa.
      if (btn.dataset.mode === 'env') {
        next.searchParams.delete('focus')
        next.searchParams.delete('ladder')
        next.searchParams.delete('ids')
      }
      location.href = next.toString()
    })
  }
}

wireChrome()

const mode = new URLSearchParams(location.search).get('mode')
if (mode === 'env') {
  void bootEnvEditor()
} else {
  void bootAssetViewer()
}
