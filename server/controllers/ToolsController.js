const { Request, Response, NextFunction } = require('express')
const Logger = require('../Logger')
const Database = require('../Database')
const ttsEngine = require('../utils/ttsEngine')
const Path = require('path')
const fs = require('../libs/fsExtra')
const Ffmpeg = require('../libs/fluentFfmpeg')

const VOICE_SAMPLE_MAX_SIZE = 20 * 1024 * 1024

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
   * POST: /api/tools/tts/voices
   * Clone a voice from an uploaded sample (multipart: name, language, consent, file "audio").
   * The sample is only kept by the TTS engine, never stored in ABS.
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async createTtsVoice(req, res) {
    const audio = req.files?.audio
    let wavPath = null
    try {
      if (!process.env.TTS_ENGINE_URL) return res.status(503).send('TTS is not enabled')
      const { name, language = 'pt', consent } = req.body || {}
      if (consent !== 'true') return res.status(400).send('Consent is required to clone a voice')
      if (!name?.trim() || name.trim().length > 100) return res.status(400).send('Invalid request: name is required')
      if (!/^[a-z]{2}$/.test(language)) return res.status(400).send('Invalid request: invalid language')
      if (!audio || Array.isArray(audio)) return res.status(400).send('Invalid request: audio file is required')
      if (audio.truncated || audio.size > VOICE_SAMPLE_MAX_SIZE) return res.status(400).send('Invalid request: audio file is too large')
      // MediaRecorder may label an audio-only webm as video/webm
      if (!audio.mimetype?.startsWith('audio/') && audio.mimetype !== 'video/webm') return res.status(400).send('Invalid request: not an audio file')

      // Normalize browser webm/opus and other uploads to wav, Voicebox rejects samples over 30 s
      const voicesCacheDir = Path.join(global.MetadataPath, 'cache/tts/voices')
      await fs.ensureDir(voicesCacheDir)
      wavPath = Path.join(voicesCacheDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
      await new Promise((resolve, reject) => {
        Ffmpeg(audio.tempFilePath).noVideo().audioChannels(1).audioFrequency(24000).duration(30).output(wavPath).on('end', resolve).on('error', reject).run()
      })

      const voice = await ttsEngine.createVoice({ name: name.trim(), language, audioBuffer: await fs.readFile(wavPath), filename: 'sample.wav' })
      Logger.info(`[ToolsController] createTtsVoice: User "${req.user.username}" created voice "${voice.name}" (${voice.id})`)
      res.json({ voice })
    } catch (error) {
      Logger.error(`[ToolsController] createTtsVoice: failed`, error.message)
      res.status(500).send(`Failed to create voice: ${error.message}`)
    } finally {
      if (audio?.tempFilePath) await fs.remove(audio.tempFilePath).catch(() => {})
      if (wavPath) await fs.remove(wavPath).catch(() => {})
    }
  }

  /**
   * DELETE: /api/tools/tts/voices/:voiceId
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async deleteTtsVoice(req, res) {
    if (!process.env.TTS_ENGINE_URL) return res.status(503).send('TTS is not enabled')
    try {
      await ttsEngine.deleteVoice(req.params.voiceId)
      Logger.info(`[ToolsController] deleteTtsVoice: User "${req.user.username}" deleted voice ${req.params.voiceId}`)
      res.sendStatus(200)
    } catch (error) {
      Logger.error(`[ToolsController] deleteTtsVoice: failed`, error.message)
      res.status(error.response?.status === 404 ? 404 : 500).send('Failed to delete voice')
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

    if (this.ttsManager.getPendingTaskByLibraryItemId(req.libraryItem.id)) {
      return res.status(400).send('Library item is already processing')
    }
    // Local engines usually take the whole GPU, so one TTS task at a time
    if (this.ttsManager.pendingTasks.length) {
      return res.status(400).send('TTS already running')
    }

    Logger.info(`[ToolsController] generateTts: Starting TTS for "${req.libraryItem.media.title}"`)
    this.ttsManager.startTts(req.user.id, req.libraryItem, { voiceId, language, pagesPerChapter })

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
