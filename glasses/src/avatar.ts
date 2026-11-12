// Draws the round avatars of the chat lists. Browser only: it needs a canvas.

import { AVATAR_SIZE } from './screen'

/**
 * A circle with the given initials, as PNG bytes; an empty string gives a
 * black (transparent on the glasses) image. White shows as bright green.
 */
export async function renderAvatar(initials: string): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_SIZE
  canvas.height = AVATAR_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no 2d canvas')

  context.fillStyle = '#000'
  context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE)
  if (initials) {
    const centre = AVATAR_SIZE / 2
    context.strokeStyle = '#fff'
    context.lineWidth = 3
    context.beginPath()
    context.arc(centre, centre, centre - 3, 0, 2 * Math.PI)
    context.stroke()
    context.fillStyle = '#fff'
    context.font = `bold ${initials.length > 1 ? 23 : 28}px sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(initials, centre, centre + 1)
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('canvas gave no image')
  return new Uint8Array(await blob.arrayBuffer())
}
