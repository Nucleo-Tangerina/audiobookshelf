const { Request, Response, NextFunction } = require('express')
const Logger = require('../Logger')
const Database = require('../Database')
const Path = require('path')
const fs = require('../libs/fsExtra')
const ttsEngine = require('../utils/ttsEngine')
const ttsBeds = require('../utils/ttsBeds')

/**
 * @typedef RequestUserObject
 * @property {import('../models/User')} user
 *
 * @typedef {Request & RequestUserObject} RequestWithUser
 *
 * @typedef RequestEntityObject
 * @property {import('../models/LibraryItem')} libraryItem
 *
 * @typedef {RequestWithUser & RequestEntityObject} RequestWithLibraryItem
 */

class ToolsController {
  constructor() {}

  /**
   * POST: /api/tools/item/:id/encode-m4b
   * Start an audiobook merge to m4b task
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async encodeM4b(req, res) {
    if (req.libraryItem.isMissing || req.libraryItem.isInvalid) {
      Logger.error(`[MiscController] encodeM4b: library item not found or invalid ${req.params.id}`)
      return res.status(404).send('Audiobook not found')
    }

    if (!req.libraryItem.isBook) {
      Logger.error(`[MiscController] encodeM4b: Invalid library item ${req.params.id}: not a book`)
      return res.status(400).send('Invalid library item: not a book')
    }

    if (!req.libraryItem.hasAudioTracks) {
      Logger.error(`[MiscController] encodeM4b: Invalid audiobook ${req.params.id}: no audio tracks`)
      return res.status(400).send('Invalid audiobook: no audio tracks')
    }

    if (this.abMergeManager.getPendingTaskByLibraryItemId(req.libraryItem.id)) {
      Logger.error(`[MiscController] encodeM4b: Audiobook ${req.params.id} is already processing`)
      return res.status(400).send('Audiobook is already processing')
    }

    const options = req.query || {}
    Logger.info(`[ToolsController] encodeM4b: Starting audiobook merge for "${req.libraryItem.media.title}" with options: ${JSON.stringify(options)}`)
    this.abMergeManager.startAudiobookMerge(req.user.id, req.libraryItem, options)

    res.sendStatus(200)
  }

  /**
   * DELETE: /api/tools/item/:id/encode-m4b
   * Cancel a running m4b merge task
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async cancelM4bEncode(req, res) {
    const workerTask = this.abMergeManager.getPendingTaskByLibraryItemId(req.params.id)
    if (!workerTask) return res.sendStatus(404)

    this.abMergeManager.cancelEncode(workerTask.task)

    res.sendStatus(200)
  }

  /**
   * GET: /api/tools/tts/status
   * TTS is enabled when TTS_ENGINE_URL is set
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getTtsStatus(req, res) {
    res.json({ enabled: !!process.env.TTS_ENGINE_URL })
  }

  /**
   * GET: /api/tools/tts/voices
   * List voices from the TTS engine
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getTtsVoices(req, res) {
    if (!process.env.TTS_ENGINE_URL) return res.status(503).send('TTS is not enabled')
    try {
      res.json({ voices: await ttsEngine.listVoices() })
    } catch (error) {
      Logger.error(`[ToolsController] getTtsVoices: TTS engine request failed`, error.message)
      res.status(503).send('TTS engine unreachable')
    }
  }

  /**
   * POST: /api/tools/item/:id/tts
   * Start a TTS task generating audio files from the item's PDF ebook
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async generateTts(req, res) {
    if (!process.env.TTS_ENGINE_URL) {
      return res.status(400).send('TTS is not enabled')
    }

    if (req.libraryItem.isMissing || req.libraryItem.isInvalid) {
      Logger.error(`[ToolsController] generateTts: library item not found or invalid ${req.params.id}`)
      return res.status(404).send('Library item not found')
    }

    if (!req.libraryItem.isBook) {
      Logger.error(`[ToolsController] generateTts: Invalid library item ${req.params.id}: not a book`)
      return res.status(400).send('Invalid library item: not a book')
    }

    // Chapter files are written next to the PDF, a single-file item has no folder of its own
    if (req.libraryItem.isFile) {
      return res.status(400).send('Invalid library item: must be in its own folder')
    }

    if (req.libraryItem.media.ebookFile?.ebookFormat !== 'pdf') {
      return res.status(400).send('Invalid library item: no PDF ebook file')
    }

    const { voiceId, language, pagesPerChapter } = req.body || {}
    if (!voiceId || typeof voiceId !== 'string') {
      return res.status(400).send('Invalid request: voiceId is required')
    }
    if (language !== undefined && typeof language !== 'string') {
      return res.status(400).send('Invalid request: language must be a string')
    }
    if (pagesPerChapter !== undefined && (!Number.isInteger(pagesPerChapter) || pagesPerChapter < 1)) {
      return res.status(400).send('Invalid request: pagesPerChapter must be a positive integer')
    }

    const { bed = null, bedVolume = 0.15, output = 'audiobook', podcastLibraryItemId } = req.body || {}
    let bedPath = null
    if (bed !== null) {
      bedPath = ttsBeds.getBedPath(bed)
      if (!bedPath || !(await fs.pathExists(bedPath))) {
        return res.status(400).send('Invalid request: bed not found')
      }
    }
    if (typeof bedVolume !== 'number' || !Number.isFinite(bedVolume) || bedVolume < 0 || bedVolume > 1) {
      return res.status(400).send('Invalid request: bedVolume must be a number between 0 and 1')
    }
    if (output !== 'audiobook' && output !== 'podcast') {
      return res.status(400).send('Invalid request: output must be "audiobook" or "podcast"')
    }
    let podcastLibraryItem = null
    if (output === 'podcast') {
      if (!podcastLibraryItemId || typeof podcastLibraryItemId !== 'string') {
        return res.status(400).send('Invalid request: podcastLibraryItemId is required')
      }
      podcastLibraryItem = await Database.libraryItemModel.getExpandedById(podcastLibraryItemId)
      if (!podcastLibraryItem?.media || podcastLibraryItem.mediaType !== 'podcast' || podcastLibraryItem.isMissing || !req.user.checkCanAccessLibraryItem(podcastLibraryItem)) {
        return res.status(400).send('Invalid request: podcast library item not found')
      }
    }

    if (this.ttsManager.getPendingTaskByLibraryItemId(req.libraryItem.id)) {
      return res.status(400).send('Library item is already processing')
    }
    // Local engines usually take the whole GPU, so one TTS task at a time
    if (this.ttsManager.pendingTasks.length) {
      return res.status(400).send('TTS already running')
    }

    Logger.info(`[ToolsController] generateTts: Starting TTS for "${req.libraryItem.media.title}"`)
    this.ttsManager.startTts(req.user.id, req.libraryItem, { voiceId, language, pagesPerChapter, bedPath, bedVolume, podcastLibraryItem })

    res.sendStatus(200)
  }

  /**
   * DELETE: /api/tools/item/:id/tts
   * Cancel a running TTS task
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async cancelTts(req, res) {
    const workerTask = this.ttsManager.getPendingTaskByLibraryItemId(req.params.id)
    if (!workerTask) return res.sendStatus(404)

    this.ttsManager.cancel(workerTask.task)

    res.sendStatus(200)
  }

  /**
   * GET: /api/tools/tts/beds
   * List background music beds
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getTtsBeds(req, res) {
    const bedsDir = ttsBeds.getBedsDir()
    await fs.ensureDir(bedsDir)
    const beds = []
    for (const name of await fs.readdir(bedsDir)) {
      const bedPath = ttsBeds.getBedPath(name)
      if (!bedPath) continue
      const stat = await fs.stat(bedPath)
      if (stat.isFile()) beds.push({ name, size: stat.size })
    }
    res.json({ beds })
  }

  /**
   * POST: /api/tools/tts/beds
   * Upload a background music bed (multipart field "audio")
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async uploadTtsBed(req, res) {
    const file = req.files?.audio
    if (!file || Array.isArray(file)) {
      return res.status(400).send('Invalid request: audio file is required')
    }
    const bedPath = ttsBeds.getBedPath(file.name)
    let error = null
    if (!bedPath) error = [400, `Invalid file: allowed types are ${ttsBeds.BED_EXTENSIONS.join(', ')}`]
    else if (file.size > ttsBeds.MAX_BED_SIZE) error = [413, 'File too large']
    if (error) {
      if (file.tempFilePath) await fs.remove(file.tempFilePath).catch(() => {})
      return res.status(error[0]).send(error[1])
    }

    await fs.ensureDir(ttsBeds.getBedsDir())
    try {
      await file.mv(bedPath)
    } catch (err) {
      Logger.error(`[ToolsController] uploadTtsBed: Failed to save bed "${file.name}"`, err)
      return res.status(500).send('Failed to save file')
    }
    Logger.info(`[ToolsController] uploadTtsBed: Saved bed "${Path.basename(bedPath)}"`)
    res.json({ name: Path.basename(bedPath), size: file.size })
  }

  /**
   * DELETE: /api/tools/tts/beds/:name
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async deleteTtsBed(req, res) {
    const bedPath = ttsBeds.getBedPath(req.params.name)
    if (!bedPath) return res.status(400).send('Invalid bed name')
    if (!(await fs.pathExists(bedPath))) return res.sendStatus(404)
    await fs.remove(bedPath)
    res.sendStatus(200)
  }

  /**
   * POST: /api/tools/item/:id/embed-metadata
   * Start audiobook embed task
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithLibraryItem} req
   * @param {Response} res
   */
  async embedAudioFileMetadata(req, res) {
    if (req.libraryItem.isMissing || !req.libraryItem.hasAudioTracks || !req.libraryItem.isBook) {
      Logger.error(`[ToolsController] Invalid library item`)
      return res.sendStatus(400)
    }

    if (this.audioMetadataManager.getIsLibraryItemQueuedOrProcessing(req.libraryItem.id)) {
      Logger.error(`[ToolsController] Library item (${req.libraryItem.id}) is already in queue or processing`)
      return res.status(400).send('Library item is already in queue or processing')
    }

    const options = {
      forceEmbedChapters: req.query.forceEmbedChapters === '1',
      backup: req.query.backup === '1'
    }
    this.audioMetadataManager.updateMetadataForItem(req.user.id, req.libraryItem, options)
    res.sendStatus(200)
  }

  /**
   * POST: /api/tools/batch/embed-metadata
   * Start batch audiobook embed task
   *
   * @this import('../routers/ApiRouter')
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async batchEmbedMetadata(req, res) {
    const libraryItemIds = req.body.libraryItemIds || []
    if (!libraryItemIds.length) {
      return res.status(400).send('Invalid request payload')
    }

    const libraryItems = []
    for (const libraryItemId of libraryItemIds) {
      const libraryItem = await Database.libraryItemModel.getExpandedById(libraryItemId)
      if (!libraryItem) {
        Logger.error(`[ToolsController] Batch embed metadata library item (${libraryItemId}) not found`)
        return res.sendStatus(404)
      }

      // Check user can access this library item
      if (!req.user.checkCanAccessLibraryItem(libraryItem)) {
        Logger.error(`[ToolsController] Batch embed metadata library item (${libraryItemId}) not accessible to user "${req.user.username}"`)
        return res.sendStatus(403)
      }

      if (libraryItem.isMissing || !libraryItem.hasAudioTracks || !libraryItem.isBook) {
        Logger.error(`[ToolsController] Batch embed invalid library item (${libraryItemId})`)
        return res.sendStatus(400)
      }

      if (this.audioMetadataManager.getIsLibraryItemQueuedOrProcessing(libraryItemId)) {
        Logger.error(`[ToolsController] Batch embed library item (${libraryItemId}) is already in queue or processing`)
        return res.status(400).send('Library item is already in queue or processing')
      }

      libraryItems.push(libraryItem)
    }

    const options = {
      forceEmbedChapters: req.query.forceEmbedChapters === '1',
      backup: req.query.backup === '1'
    }
    this.audioMetadataManager.handleBatchEmbed(req.user.id, libraryItems, options)
    res.sendStatus(200)
  }

  /**
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   * @param {NextFunction} next
   */
  async middleware(req, res, next) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[LibraryItemController] Non-root user "${req.user.username}" attempted to access tools route`)
      return res.sendStatus(403)
    }

    if (req.params.id) {
      const item = await Database.libraryItemModel.getExpandedById(req.params.id)
      if (!item?.media) return res.sendStatus(404)

      // Check user can access this library item
      if (!req.user.checkCanAccessLibraryItem(item)) {
        return res.sendStatus(403)
      }

      req.libraryItem = item
    }

    next()
  }
}
module.exports = new ToolsController()
