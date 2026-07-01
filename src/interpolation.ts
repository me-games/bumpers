const RENDER_DELAY_MS = 100
const BUFFER_MS = 1000

export type InterpState = {
  x: number
  y: number
  z: number
  yaw: number
}

type Snap = {
  t: number
  v: InterpState
}

function lerp(a: number, b: number, k: number) {
  return a + (b - a) * k
}

function lerpAngle(a: number, b: number, k: number) {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * k
}

export class RemoteInterpolator {
  private buffers = new Map<string, Snap[]>()

  push(id: string, v: InterpState, now = performance.now()) {
    let buf = this.buffers.get(id)
    if (!buf) this.buffers.set(id, (buf = []))
    const last = buf[buf.length - 1]
    if (last && last.v.x === v.x && last.v.z === v.z && last.v.yaw === v.yaw && last.v.y === v.y) return
    buf.push({ t: now, v })
    const cutoff = now - BUFFER_MS
    while (buf.length > 2 && buf[0].t < cutoff) buf.shift()
  }

  sample(id: string, now = performance.now()): InterpState | null {
    const buf = this.buffers.get(id)
    if (!buf || buf.length === 0) return null
    const target = now - RENDER_DELAY_MS
    if (buf.length === 1 || target <= buf[0].t) return buf[0].v
    if (target >= buf[buf.length - 1].t) return buf[buf.length - 1].v
    for (let i = 0; i < buf.length - 1; i += 1) {
      const a = buf[i]
      const b = buf[i + 1]
      if (target >= a.t && target <= b.t) {
        const k = (target - a.t) / (b.t - a.t || 1)
        return {
          x: lerp(a.v.x, b.v.x, k),
          y: lerp(a.v.y, b.v.y, k),
          z: lerp(a.v.z, b.v.z, k),
          yaw: lerpAngle(a.v.yaw, b.v.yaw, k),
        }
      }
    }
    return buf[buf.length - 1].v
  }

  remove(id: string) {
    this.buffers.delete(id)
  }
}
