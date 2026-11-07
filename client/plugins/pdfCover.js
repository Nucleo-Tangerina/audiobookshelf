// Not a Nuxt plugin: imported by components that render a PDF's first page as the item cover.
// Server has no PDF rasterizer, so the browser renders with pdf.js and uploads through POST /api/items/:id/cover.

const attempted = new Set()
let queue = Promise.resolve()

function getPdfjs() {
  const PDFJS = require('pdfjs-dist/es5/build/pdf.js')
  if (!PDFJS.GlobalWorkerOptions.workerPort && typeof window !== 'undefined' && 'Worker' in window) {
    const workerModule = require('worker-loader!pdfjs-dist/es5/build/pdf.worker.js')
    const PdfjsWorker = workerModule.default || workerModule
    PDFJS.GlobalWorkerOptions.workerPort = new PdfjsWorker()
  }
  return PDFJS
}

async function renderFirstPage(data) {
  const doc = await getPdfjs().getDocument({ data }).promise
  try {
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: 800 / base.width })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff' // transparent PDFs would turn black as JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport }).promise
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.9))
  } finally {
    doc.destroy()
  }
}

/**
 * True when the item is a PDF book without a cover that this user may set
 * @param {Object} libraryItem expanded or minified
 * @param {boolean} canUpload user may upload covers
 */
export function needsPdfCover(libraryItem, canUpload) {
  const media = libraryItem?.media
  if (!canUpload || !media || libraryItem.mediaType !== 'book' || media.coverPath || libraryItem.isMissing) return false
  return (media.ebookFormat || media.ebookFile?.ebookFormat) === 'pdf'
}

/**
 * Render page 1 and upload it as cover. One PDF at a time, once per item per page load.
 * @param {Object} axios nuxt $axios
 * @param {string} libraryItemId
 * @returns {Promise<boolean>}
 */
export function generatePdfCover(axios, libraryItemId) {
  if (attempted.has(libraryItemId)) return Promise.resolve(false)
  attempted.add(libraryItemId)
  const job = queue.then(async () => {
    try {
      const data = await axios.$get(`/api/items/${libraryItemId}/ebook`, { responseType: 'arraybuffer' })
      const blob = await renderFirstPage(new Uint8Array(data))
      const form = new FormData()
      form.append('cover', blob, 'cover.jpg')
      await axios.$post(`/api/items/${libraryItemId}/cover`, form)
      return true
    } catch (error) {
      console.error('[pdfCover] Failed to generate cover', libraryItemId, error)
      return false
    }
  })
  queue = job
  return job
}
