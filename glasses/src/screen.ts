// Layout constants and page builders for the 576x288 glasses canvas.

import { CreateStartUpPageContainer, TextContainerProperty, TextContainerUpgrade } from '@evenrealities/even_hub_sdk'

export const SCREEN = { width: 576, height: 288 } as const

/** The single full-screen text container. Every screen is drawn in it, and it captures input. */
export const MAIN_CONTAINER = { id: 1, name: 'main' } as const

// Limits from the Even Hub display docs.
export const MAX_CREATE_CHARS = 1000
export const MAX_UPGRADE_CHARS = 2000

/** Cuts text to the limit. Uses ASCII dots: the firmware font drops unknown glyphs. */
export function fitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars - 3) + '...'
}

function mainText(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN.width,
    height: SCREEN.height,
    borderWidth: 0,
    paddingLength: 4,
    containerID: MAIN_CONTAINER.id,
    containerName: MAIN_CONTAINER.name,
    content: fitText(content, MAX_CREATE_CHARS),
    isEventCapture: 1,
  })
}

export function startupPage(content: string): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [mainText(content)] })
}

/** Replaces the text on the glasses. Proven on real hardware, unlike a page rebuild with a list. */
export function mainTextUpdate(content: string): TextContainerUpgrade {
  return new TextContainerUpgrade({
    containerID: MAIN_CONTAINER.id,
    containerName: MAIN_CONTAINER.name,
    content: fitText(content, MAX_UPGRADE_CHARS),
  })
}
