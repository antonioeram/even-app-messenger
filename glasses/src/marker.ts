// Draws the selection marker of the chat lists. Browser only: it needs a canvas.

import { BORDER, MARKER } from './screen'

/**
 * The marker image as PNG bytes. Lit, it is a framed cell with a chevron
 * pointing at the row; its right edge lies on the left border of the box, so
 * the two read as one frame. Otherwise it is empty. Black is transparent on the glasses and
 * white is the brightest green.
 */
export async function renderMarker(lit: boolean): Promise<Uint8Array> {
  const { width, height } = MARKER
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no 2d canvas')

  context.fillStyle = '#000'
  context.fillRect(0, 0, width, height)
  if (lit) {
    // The frame, in the grey of the box borders (level BORDER of 15).
    const grey = Math.round((BORDER / 15) * 255)
    context.fillStyle = `rgb(${grey}, ${grey}, ${grey})`
    context.fillRect(0, 0, width, 1)
    context.fillRect(0, height - 1, width, 1)
    context.fillRect(0, 0, 1, height)
    context.fillRect(width - 1, 0, 1, height)

    const middle = height / 2
    context.strokeStyle = '#fff'
    context.lineWidth = 3
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()
    context.moveTo(8, middle - 10)
    context.lineTo(17, middle)
    context.lineTo(8, middle + 10)
    context.stroke()
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('canvas gave no image')
  return new Uint8Array(await blob.arrayBuffer())
}
