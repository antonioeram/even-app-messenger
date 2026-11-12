// Layout constants and page builders for the 576x288 glasses canvas.

import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'

export const SCREEN = { width: 576, height: 288 } as const

/** The full-screen text container (status, errors, reading). It captures input. */
export const MAIN_CONTAINER = { id: 1, name: 'main' } as const

/** The full-screen list of chats. It captures input while it is shown. */
export const INBOX_CONTAINER = { id: 2, name: 'inbox' } as const

// Limits from the Even Hub display docs.
export const MAX_CREATE_CHARS = 1000

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

/** A page with one full-screen text. */
export function textPage(content: string): RebuildPageContainer {
  return new RebuildPageContainer({ containerTotalNum: 1, textObject: [mainText(content)] })
}

/** A page with one full-screen list; the firmware moves the selection. */
export function listPage(items: readonly string[]): RebuildPageContainer {
  return new RebuildPageContainer({
    containerTotalNum: 1,
    listObject: [
      new ListContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: SCREEN.width,
        height: SCREEN.height,
        borderWidth: 0,
        paddingLength: 4,
        containerID: INBOX_CONTAINER.id,
        containerName: INBOX_CONTAINER.name,
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: items.length,
          itemWidth: SCREEN.width - 8,
          isItemSelectBorderEn: 1,
          itemName: [...items],
        }),
      }),
    ],
  })
}
