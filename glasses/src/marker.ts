// Draws the selection marker of the chat lists. Browser only: it needs a canvas.

import { MARKER } from './screen'

/**
 * The marker image as PNG bytes: an arrowhead pointing at the row when lit,
 * nothing otherwise. Black is transparent on the glasses and white is the
 * brightest green.
 */
export async function renderMarker(lit: boolean): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = MARKER.width
  canvas.height = MARKER.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no 2d canvas')

  context.fillStyle = '#000'
  context.fillRect(0, 0, MARKER.width, MARKER.height)
  if (lit) {
    const middle = MARKER.height / 2
    const half = 11
    context.fillStyle = '#fff'
    context.beginPath()
    context.moveTo(4, middle - half)
    context.lineTo(MARKER.width - 6, middle)
    context.lineTo(4, middle + half)
    context.closePath()
    context.fill()
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('canvas gave no image')
  return new Uint8Array(await blob.arrayBuffer())
}
