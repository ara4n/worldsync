/** Deterministic per-peer accent color (chain lines, claim highlights):
 * every peer hashes the same id to the same hue, no negotiation needed.
 * Saturation/lightness are fixed at values that read on both the dark
 * default world and a white dots board. */
export function peerColor(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193)
  const hue = ((h >>> 0) % 360) / 360
  return hslToHex(hue, 0.75, 0.5)
}

function hslToHex(h: number, s: number, l: number): number {
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255)
}
