const fs = require('../libs/fsExtra')

// Words that end with a period but do not end a sentence (pt-BR first), compared lowercase without the period
const ABBREVIATIONS = new Set([
  'sr',
  'sra',
  'srta',
  'srs',
  'sras',
  'dr',
  'dra',
  'drs',
  'dras',
  'prof',
  'profa',
  'profs',
  'profas',
  'p',
  'pp',
  'pág',
  'págs',
  'pag',
  'pags',
  'n',
  'nº',
  'núm',
  'num',
  'av',
  'ltda',
  'cia',
  'etc',
  'ex',
  'exa',
  'exmo',
  'exma',
  'v',
  'obs',
  'vol',
  'vols',
  'cap',
  'caps',
  'art',
  'arts',
  'fig',
  'figs',
  'tel',
  'jr',
  'sto',
  'sta',
  'séc',
  'ed',
  'eng',
  'adv',
  'aprox',
  'min',
  'máx',
  'mín',
  'mr',
  'mrs',
  'ms',
  'st',
  'vs',
  'cf'
])

/**
 * Remove headers/footers (lines repeated on most pages) and bare page numbers
 *
 * @param {string[]} pages raw text per page, lines separated by \n
 * @returns {string[]} cleaned text per page, whitespace collapsed
 */
function cleanPages(pages) {
  const pageLines = pages.map((p) =>
    p
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  )
  // Digits are masked so "Page 3" and "Page 4" count as the same footer
  const lineKey = (line) => line.toLowerCase().replace(/\d+/g, '#')

  const repeated = new Set()
  if (pageLines.length >= 3) {
    const counts = new Map()
    for (const lines of pageLines) {
      for (const key of new Set(lines.map(lineKey))) counts.set(key, (counts.get(key) || 0) + 1)
    }
    const minCount = Math.ceil(pageLines.length * 0.6)
    for (const [key, count] of counts) if (count >= minCount) repeated.add(key)
  }

  return pageLines.map((lines) => {
    const kept = lines.filter((l) => !repeated.has(lineKey(l)) && !/^(p[áa]g(ina)?\.?\s*)?[-–—\s]*\d+[-–—\s]*$/i.test(l))
    return kept
      .join('\n')
      .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
      .replace(/\s+/g, ' ')
      .trim()
  })
}
module.exports.cleanPages = cleanPages

/**
 * Split a chunk longer than maxChars at the last comma/semicolon/colon, else last space
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitLong(text, maxChars) {
  const chunks = []
  let rest = text
  while (rest.length > maxChars) {
    const head = rest.slice(0, maxChars)
    let cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '))
    if (cut < maxChars / 2) cut = head.lastIndexOf(' ')
    if (cut <= 0) cut = maxChars - 1
    chunks.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}

/**
 * Split text into sentences, no chunk longer than maxChars
 *
 * @param {string} text whitespace already collapsed
 * @param {number} [maxChars=400]
 * @returns {string[]}
 */
function splitSentences(text, maxChars = 400) {
  const sentences = []
  const boundary = /([.!?…]+)(["'”’»)\]]*)\s+(?=["'“‘«(\[—–-]?[\p{Lu}\d])/gu
  let start = 0
  let match
  while ((match = boundary.exec(text))) {
    const end = match.index + match[1].length + match[2].length
    if (match[1] === '.') {
      const token = (text.slice(start, match.index).match(/[\p{L}\p{N}.ºª]+$/u) || [''])[0]
      // Abbreviation, initial ("J."), or dotted abbreviation ("S.A.")
      if (ABBREVIATIONS.has(token.toLowerCase()) || /^\p{Lu}$/u.test(token) || token.includes('.')) continue
    }
    sentences.push(text.slice(start, end).trim())
    start = end
  }
  sentences.push(text.slice(start).trim())
  return sentences.filter(Boolean).flatMap((s) => splitLong(s, maxChars))
}
module.exports.splitSentences = splitSentences

/**
 * Group cleaned pages into chapters of pagesPerChapter pages, each split into sentences tagged with their page
 *
 * @param {string[]} pages cleaned text per page
 * @param {number} [pagesPerChapter=10]
 * @param {number} [maxChars=400]
 * @returns {{ index:number, sentences:{ text:string, page:number }[] }[]} page is 1-based
 */
function buildChapters(pages, pagesPerChapter = 10, maxChars = 400) {
  const chapters = []
  for (let i = 0; i < pages.length; i += pagesPerChapter) {
    // Join pages so sentences crossing a page break stay whole, remember where each page starts
    let text = ''
    const pageStarts = []
    pages.slice(i, i + pagesPerChapter).forEach((pageText, j) => {
      if (!pageText) return
      if (text) text += ' '
      pageStarts.push({ offset: text.length, page: i + j + 1 })
      text += pageText
    })
    if (!text) continue

    let cursor = 0
    const sentences = splitSentences(text, maxChars).map((sentence) => {
      cursor = text.indexOf(sentence, cursor)
      const page = pageStarts.filter((p) => p.offset <= cursor).pop().page
      cursor += sentence.length
      return { text: sentence, page }
    })
    chapters.push({ index: chapters.length + 1, sentences })
  }
  return chapters
}
module.exports.buildChapters = buildChapters

/**
 * Same line grouping as pdf-parse's default renderer, keeping line breaks for cleanPages
 *
 * @param {*} pageData pdf.js page
 * @returns {Promise<string>}
 */
async function renderPage(pageData) {
  const textContent = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
  let lastY = null
  let text = ''
  for (const item of textContent.items) {
    if (lastY !== null && lastY !== item.transform[5]) text += '\n'
    text += item.str
    lastY = item.transform[5]
  }
  return text
}

/**
 * Extract chapters and sentences from a PDF file
 *
 * @param {string} pdfPath
 * @param {number} [pagesPerChapter=10]
 * @returns {Promise<{ index:number, sentences:{ text:string, page:number }[] }[]>}
 */
async function extractPdfChapters(pdfPath, pagesPerChapter = 10) {
  // Require the lib file directly, the package index runs a debug test when module.parent is unset
  const pdfParse = require('pdf-parse/lib/pdf-parse.js')
  const pages = []
  // pdf.js 1.10 throws "bad XRef entry" on the Buffer from async fs.readFile; a plain Uint8Array copy parses fine
  const data = new Uint8Array(await fs.readFile(pdfPath))
  await pdfParse(data, {
    pagerender: async (pageData) => {
      const text = await renderPage(pageData)
      pages[pageData.pageIndex] = text
      return text
    }
  })

  const chapters = buildChapters(cleanPages(Array.from(pages, (p) => p || '')), pagesPerChapter)
  if (!chapters.length) {
    throw new Error('PDF has no extractable text (scanned PDF? OCR is not supported)')
  }
  return chapters
}
module.exports.extractPdfChapters = extractPdfChapters
