import { Encoder } from 'cbor-x'
import type { DcMessage } from './types'

/**
 * The datachannel wire codec: CBOR (RFC 8949) via cbor-x, replacing the
 * original JSON strings. Encoded as self-describing plain maps
 * (useRecords: false), so every message decodes standalone with no
 * shared schema state between peers - a joiner mid-stream reads its
 * first message like any other. Numbers ride exactly: integers as CBOR
 * ints, everything else as float64, the same lossless f64 round-trip
 * JSON gave us (and our ints stay far under 2^53, so decode never
 * produces a BigInt). -0 is still normalized to 0 at emit time - CBOR
 * would happily carry -0 where JSON could not, but the session's
 * determinism guarantee predates the codec (see HANDOVER wire notes),
 * so the normalization stays upstream.
 *
 * Every transport carries these bytes opaquely: RTCDataChannel frames
 * in the ws demo, LiveKit reliable data packets, structured-cloned
 * Uint8Arrays over the mock BroadcastChannel.
 */

const encoder = new Encoder({ useRecords: false })

// cbor-x types its output over ArrayBufferLike; it never actually uses a
// SharedArrayBuffer, and the narrower type is what RTCDataChannel.send
// and LiveKit's publishData accept.
export const encodeDc = (msg: DcMessage): Uint8Array<ArrayBuffer> =>
  encoder.encode(msg) as Uint8Array<ArrayBuffer>

/** decode a transport payload (Uint8Array or ArrayBuffer); null when it
 * is not one of ours (wrong type, truncated, or no message kind) */
export function decodeDc(data: unknown): DcMessage | null {
  let bytes: Uint8Array
  if (data instanceof Uint8Array) bytes = data
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
  else return null
  try {
    const msg = encoder.decode(bytes) as unknown
    return typeof msg === 'object' && msg !== null && typeof (msg as DcMessage).kind === 'string'
      ? msg as DcMessage
      : null
  } catch {
    return null
  }
}
