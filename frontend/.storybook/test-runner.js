const { mkdirSync } = require('node:fs')
const path = require('node:path')

const defaultImagesRoot = path.resolve(__dirname, '..', '..', 'docs', 'images')
const imagesRoot = process.env.STORYBOOK_SCREENSHOT_DIR ?? defaultImagesRoot

const sanitize = (segment) =>
  segment
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()

module.exports = {
  async preVisit(page) {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addStyleTag({
      content:
        '*{animation:none!important;transition:none!important}\n*::before{animation:none!important;transition:none!important}\n*::after{animation:none!important;transition:none!important}',
    })
  },
  async postVisit(page, context) {
    const titleSegments = context.title.split('/').map(sanitize)
    const storyName = sanitize(context.name)
    const outputDir = path.join(imagesRoot, ...titleSegments)

    mkdirSync(outputDir, { recursive: true })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({
      path: path.join(outputDir, `${storyName}.png`),
    })
  },
}
