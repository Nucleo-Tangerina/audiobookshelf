const Path = require('path')
const crypto = require('crypto')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const TaskManager = require('./TaskManager')
const Task = require('../objects/Task')
const Watcher = require('../Watcher')
const ffmpegHelpers = require('../utils/ffmpegHelpers')
const Ffmpeg = require('../libs/fluentFfmpeg')
const SocketAuthority = require('../SocketAuthority')
const LibraryItemScanner = require('../scanner/LibraryItemScanner')
const { isWritable, sanitizeFilename } = require('../utils/fileUtils')
const ttsEngine = require('../utils/ttsEngine')
const { buildBedMixFilter } = require('../utils/ttsBeds')
const pdfText = require('../utils/pdfText')

/**
 * @typedef TtsOptions
 * @property {string} voiceId
 * @property {string} [language]
 * @property {number} [pagesPerChapter]
 * @property {string|null} [bedPath] background music file, mixed under the voice
 * @property {number} [bedVolume]
 * @property {import('../models/LibraryItem')|null} [podcastLibraryItem] when set, chapters become episodes of this podcast
 */

class TtsManager {
  constructor() {
    this.ttsCacheDir = Path.join(global.MetadataPath, 'cache/tts')

    /** @type {{id:string, task:Task}[]} */
    this.pendingTasks = []
  }

  /**
   *
   * @param {string} libraryItemId
   * @returns {{id:string, task:Task}|null}
   */
  getPendingTaskByLibraryItemId(libraryItemId) {
    return this.pendingTasks.find((t) => t.task.data.libraryItemId === libraryItemId)
  }

  /**
   * Cancel and fail running task
   *
   * @param {Task} task
   * @returns {Promise<void>}
   */
  cancel(task) {
    task.data.canceled = true
    task.setFailed({
      text: 'Task canceled by user',
      key: 'MessageTaskCanceledByUser'
    })
    return this.removeTask(task, true)
  }

  /**
   *
   * @param {string} userId
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {TtsOptions} options
   */
  startTts(userId, libraryItem, options) {
    const task = new Task()
    const taskData = {
      libraryItemId: libraryItem.id,
      libraryItemDir: libraryItem.path,
      userId,
      ebookPath: libraryItem.media.ebookFile.metadata.path,
      voiceId: options.voiceId,
      language: options.language || process.env.TTS_DEFAULT_LANGUAGE || 'pt',
      pagesPerChapter: options.pagesPerChapter || 10,
      bookTitle: libraryItem.media.title,
      bedPath: options.bedPath || null,
      bedVolume: options.bedVolume ?? 0.15,
      podcastLibraryItemId: options.podcastLibraryItem?.id || null,
      // Chapter audio goes to the podcast item folder in podcast mode
      outputDir: options.podcastLibraryItem?.path || libraryItem.path,
      itemCachePath: Path.join(this.ttsCacheDir, libraryItem.id),
      tempFilepath: null,
      canceled: false
    }

    const taskTitleString = {
      text: 'Generating audiobook (TTS)',
      key: 'MessageTaskTtsGenerate'
    }
    const taskDescriptionString = {
      text: `Generating audiobook "${libraryItem.media.title}" from its PDF with text-to-speech.`,
      key: 'MessageTaskTtsGenerateDescription',
      subs: [libraryItem.media.title]
    }
    task.setData('tts-generate', taskTitleString, taskDescriptionString, false, taskData)
    TaskManager.addTask(task)
    // Added before running so a second request is rejected right away
    this.pendingTasks.push({ id: task.id, task })
    Logger.info(`[TtsManager] Start TTS for ${libraryItem.id} - TaskId: ${task.id}`)

    this.runTts(task)
  }

  /**
   *
   * @param {Task} task
   */
  async runTts(task) {
    const { libraryItemId, libraryItemDir, itemCachePath, voiceId, language, outputDir, podcastLibraryItemId, bookTitle } = task.data

    let notWritableDir = null
    for (const dir of new Set([libraryItemDir, outputDir])) {
      if (!notWritableDir && !(await isWritable(dir))) notWritableDir = dir
    }
    if (notWritableDir) {
      Logger.error(`[TtsManager] Target directory is not writable: ${notWritableDir}`)
      task.setFailed({
        text: 'Target directory is not writable',
        key: 'MessageTaskTargetDirectoryNotWritable'
      })
      this.removeTask(task, true)
      return
    }

    // Only the audio dir: Watcher keeps one removal timer, so a second ignored dir could stay ignored
    Watcher.addIgnoreDir(outputDir)
    try {
      await fs.ensureDir(itemCachePath)
      const chapters = await pdfText.extractPdfChapters(task.data.ebookPath, task.data.pagesPerChapter)
      const totalSentences = chapters.reduce((total, c) => total + c.sentences.length, 0)
      const padLength = Math.max(2, String(chapters.length).length)
      const alignment = []
      let sentencesDone = 0

      for (const chapter of chapters) {
        const tracks = []
        let chapterTime = 0
        for (const sentence of chapter.sentences) {
          if (task.data.canceled) return

          const hash = crypto
            .createHash('sha1')
            .update(voiceId + language + sentence.text)
            .digest('hex')
          const wavPath = Path.join(itemCachePath, `${hash}.wav`)
          let wav
          // Sentence cache makes a restarted task resume instead of regenerating
          if (await fs.pathExists(wavPath)) {
            wav = await fs.readFile(wavPath)
          } else {
            wav = await ttsEngine.synthesize({ text: sentence.text, voiceId, language })
            if (task.data.canceled) return
            await fs.writeFile(wavPath, wav)
          }

          const duration = ttsEngine.getWavDuration(wav)
          tracks.push({ index: tracks.length, duration, metadata: { path: wavPath } })
          alignment.push({ chapter: chapter.index, file: null, start: chapterTime, end: chapterTime + duration, page: sentence.page, text: sentence.text })
          chapterTime += duration

          sentencesDone++
          SocketAuthority.adminEmitter('task_progress', { libraryItemId, progress: (sentencesDone / totalSentences) * 100 })
        }

        const chapterNumber = String(chapter.index).padStart(padLength, '0')
        const filename = podcastLibraryItemId ? sanitizeFilename(`${bookTitle} - ${chapterNumber} - Chapter ${chapterNumber}.mp3`) : `${chapterNumber} - Chapter ${chapterNumber}.mp3`
        task.data.tempFilepath = Path.join(itemCachePath, filename)
        task.data.ffmpeg = new Ffmpeg()
        await this.encodeChapter(tracks, Path.join(itemCachePath, 'files.txt'), task.data.tempFilepath, task.data.ffmpeg, {
          bedPath: task.data.bedPath,
          bedVolume: task.data.bedVolume,
          duration: chapterTime,
          // Podcast scanner uses the title tag as episode title
          title: podcastLibraryItemId ? `${bookTitle} – Capítulo ${chapterNumber}` : null
        })
        delete task.data.ffmpeg
        await fs.move(task.data.tempFilepath, Path.join(outputDir, filename), { overwrite: true })
        task.data.tempFilepath = null
        alignment.filter((a) => a.chapter === chapter.index).forEach((a) => (a.file = filename))
      }

      await fs.ensureDir(Path.join(libraryItemDir, 'tts'))
      await fs.writeFile(Path.join(libraryItemDir, 'tts', 'alignment.json'), JSON.stringify(alignment, null, 2))
    } catch (error) {
      if (task.data.canceled) return
      Logger.error(`[TtsManager] TTS failed for ${libraryItemId}`, error)
      task.setFailed({
        text: `TTS failed: ${error.message}`,
        key: 'MessageTaskTtsFailed',
        subs: [error.message]
      })
      this.removeTask(task, true)
      return
    }

    // Rescan creates a podcast episode for each new audio file
    await LibraryItemScanner.scanLibraryItem(podcastLibraryItemId || libraryItemId)

    task.setFinished()
    await this.removeTask(task, false)
    Logger.info(`[TtsManager] TTS task finished ${task.id}`)
  }

  /**
   * Concat sentence wavs into one mp3, optionally mixed with a looped background bed
   *
   * @param {{index:number, duration:number, metadata:{path:string}}[]} tracks
   * @param {string} concatFilePath
   * @param {string} outputPath
   * @param {import('../libs/fluentFfmpeg/index').FfmpegCommand} ffmpeg
   * @param {{bedPath?:string|null, bedVolume?:number, duration?:number, title?:string|null}} [options]
   * @returns {Promise<void>}
   */
  async encodeChapter(tracks, concatFilePath, outputPath, ffmpeg, options = {}) {
    if ((await ffmpegHelpers.writeConcatFile(tracks, concatFilePath)) == null) {
      throw new Error('Failed to write concat file')
    }
    ffmpeg.input(concatFilePath).inputOptions(['-safe 0', '-f concat'])
    if (options.bedPath) {
      ffmpeg.input(options.bedPath).inputOptions(['-stream_loop -1'])
      ffmpeg.complexFilter(buildBedMixFilter(options.bedVolume, options.duration))
      // -t guards against the infinite bed input outliving the voice
      ffmpeg.outputOptions(['-map [out]', `-t ${options.duration.toFixed(3)}`, '-acodec libmp3lame', '-b:a 128k'])
    } else {
      ffmpeg.outputOptions(['-map 0:a', '-acodec libmp3lame', '-b:a 128k'])
    }
    if (options.title) ffmpeg.addOption('-metadata', `title=${options.title}`)
    ffmpeg.output(outputPath)

    return new Promise((resolve, reject) => {
      ffmpeg
        .on('start', (cmd) => Logger.debug(`[TtsManager] Encode chapter ffmpeg command: ${cmd}`))
        .on('end', async () => {
          await fs.remove(concatFilePath)
          resolve()
        })
        .on('error', async (err, stdout, stderr) => {
          await fs.remove(concatFilePath)
          Logger.error('[TtsManager] ffmpeg stderr:', stderr)
          reject(err)
        })
      ffmpeg.run()
    })
  }

  /**
   * Remove TTS task, sentence wav cache is kept so the task can resume
   *
   * @param {Task} task
   * @param {boolean} [removeTempFilepath=false]
   */
  async removeTask(task, removeTempFilepath = false) {
    Logger.info('[TtsManager] Removing task ' + task.id)

    const pendingTask = this.pendingTasks.find((d) => d.id === task.id)
    if (pendingTask) {
      this.pendingTasks = this.pendingTasks.filter((d) => d.id !== task.id)
      if (task.data.ffmpeg) {
        Logger.warn(`[TtsManager] Killing ffmpeg process for task ${task.id}`)
        task.data.ffmpeg.kill()
        // wait for ffmpeg to exit, so that the output file is unlocked
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }

    if (removeTempFilepath && task.data.tempFilepath && (await fs.pathExists(task.data.tempFilepath))) {
      await fs.remove(task.data.tempFilepath).catch((err) => {
        Logger.error('[TtsManager] Failed to delete temp file', err)
      })
    }

    Watcher.removeIgnoreDir(task.data.outputDir)
    TaskManager.taskFinished(task)
  }
}
module.exports = TtsManager
