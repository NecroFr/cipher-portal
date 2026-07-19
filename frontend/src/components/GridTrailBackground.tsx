import { useEffect, useRef } from 'react'

// ─── Constants ────────────────────────────────────────────────────────────────
const CELL_SIZE = 40          // px — size of each grid square
const TRAIL_RADIUS = 150      // px — illumination radius around cursor
const DECAY_RATE = 0.015      // opacity lost per frame at 60fps (~1.8s full fade)
const BASE_ALPHA = 0.04       // resting grid line opacity
const PEAK_ALPHA = 0.35       // maximum cell highlight opacity

// ─── Types ────────────────────────────────────────────────────────────────────
interface Cell {
  col: number
  row: number
  alpha: number   // current highlight alpha [0, PEAK_ALPHA]
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function GridTrailBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Live state — kept in refs so the rAF loop always sees latest values
    let cols = 0
    let rows = 0
    let mouseX = -9999
    let mouseY = -9999
    let rafId = 0

    // Sparse map of illuminated cells: key = "col,row" → Cell
    const active = new Map<string, Cell>()

    // ── Resize handler ──────────────────────────────────────────────────────
    function resize() {
      const dpr = window.devicePixelRatio || 1
      const w = window.innerWidth
      const h = window.innerHeight

      canvas!.width = w * dpr
      canvas!.height = h * dpr
      canvas!.style.width = `${w}px`
      canvas!.style.height = `${h}px`
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)

      cols = Math.ceil(w / CELL_SIZE) + 1
      rows = Math.ceil(h / CELL_SIZE) + 1
    }

    // ── Mouse move handler ──────────────────────────────────────────────────
    function onMouseMove(e: MouseEvent) {
      mouseX = e.clientX
      mouseY = e.clientY

      // Determine which cells fall within the trail radius
      const cellCol = Math.floor(mouseX / CELL_SIZE)
      const cellRow = Math.floor(mouseY / CELL_SIZE)
      const reach = Math.ceil(TRAIL_RADIUS / CELL_SIZE)

      for (let dc = -reach; dc <= reach; dc++) {
        for (let dr = -reach; dr <= reach; dr++) {
          const col = cellCol + dc
          const row = cellRow + dr
          if (col < 0 || row < 0 || col >= cols || row >= rows) continue

          // Distance from cursor to the centre of this cell
          const cx = col * CELL_SIZE + CELL_SIZE / 2
          const cy = row * CELL_SIZE + CELL_SIZE / 2
          const dist = Math.hypot(cx - mouseX, cy - mouseY)
          if (dist > TRAIL_RADIUS) continue

          // Map distance → opacity with a smooth cubic falloff
          const t = 1 - dist / TRAIL_RADIUS
          const targetAlpha = PEAK_ALPHA * (t * t * (3 - 2 * t))   // smoothstep

          const key = `${col},${row}`
          const existing = active.get(key)
          if (!existing || existing.alpha < targetAlpha) {
            active.set(key, { col, row, alpha: targetAlpha })
          }
        }
      }
    }

    // ── Draw loop ───────────────────────────────────────────────────────────
    function draw() {
      const w = window.innerWidth
      const h = window.innerHeight

      ctx!.clearRect(0, 0, w, h)

      // 1. Draw base grid ─ all cells at resting alpha
      ctx!.strokeStyle = `rgba(0, 212, 255, ${BASE_ALPHA})`
      ctx!.lineWidth = 0.5
      ctx!.beginPath()

      for (let c = 0; c <= cols; c++) {
        const x = c * CELL_SIZE
        ctx!.moveTo(x, 0)
        ctx!.lineTo(x, h)
      }
      for (let r = 0; r <= rows; r++) {
        const y = r * CELL_SIZE
        ctx!.moveTo(0, y)
        ctx!.lineTo(w, y)
      }
      ctx!.stroke()

      // 2. Draw & decay active (highlighted) cells
      const toDelete: string[] = []

      for (const [key, cell] of active) {
        const x = cell.col * CELL_SIZE
        const y = cell.row * CELL_SIZE

        // Fill the cell with a teal glow
        ctx!.fillStyle = `rgba(0, 212, 255, ${cell.alpha * 0.18})`
        ctx!.fillRect(x + 0.5, y + 0.5, CELL_SIZE - 1, CELL_SIZE - 1)

        // Redraw the four borders at the enhanced alpha
        ctx!.strokeStyle = `rgba(0, 212, 255, ${cell.alpha})`
        ctx!.lineWidth = 0.8
        ctx!.strokeRect(x + 0.5, y + 0.5, CELL_SIZE - 1, CELL_SIZE - 1)

        // Decay
        cell.alpha -= DECAY_RATE
        if (cell.alpha <= BASE_ALPHA) toDelete.push(key)
      }

      // Prune cells that have fully faded
      for (const key of toDelete) active.delete(key)

      rafId = requestAnimationFrame(draw)
    }

    // ── Init ────────────────────────────────────────────────────────────────
    resize()
    rafId = requestAnimationFrame(draw)

    window.addEventListener('resize', resize)
    window.addEventListener('mousemove', onMouseMove)

    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMouseMove)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 0,
      }}
      aria-hidden="true"
    />
  )
}
