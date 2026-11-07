const Os = require('os')
const Path = require('path')
const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const fs = require('../../../server/libs/fsExtra')
const Database = require('../../../server/Database')
const ToolsController = require('../../../server/controllers/ToolsController')
const Logger = require('../../../server/Logger')

describe('ToolsController', () => {
  describe('generateTts options', () => {
    let originalMetadataPath
    let originalEngineUrl
    let router
    let getExpandedById

    before(async () => {
      originalMetadataPath = global.MetadataPath
      originalEngineUrl = process.env.TTS_ENGINE_URL
      global.MetadataPath = await fs.mkdtemp(Path.join(Os.tmpdir(), 'abs-tts-'))
      await fs.ensureDir(Path.join(global.MetadataPath, 'tts-beds'))
      await fs.writeFile(Path.join(global.MetadataPath, 'tts-beds', 'bed.mp3'), '')
      process.env.TTS_ENGINE_URL = 'http://engine'
      Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
      Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
      await Database.buildModels()
    })

    after(async () => {
      await fs.remove(global.MetadataPath)
      global.MetadataPath = originalMetadataPath
      if (originalEngineUrl === undefined) delete process.env.TTS_ENGINE_URL
      else process.env.TTS_ENGINE_URL = originalEngineUrl
    })

    beforeEach(() => {
      sinon.stub(Logger, 'info')
      sinon.stub(Logger, 'error')
      router = { ttsManager: { pendingTasks: [], getPendingTaskByLibraryItemId: () => null, startTts: sinon.spy() } }
      getExpandedById = sinon.stub(Database.libraryItemModel, 'getExpandedById').resolves(null)
    })

    afterEach(() => sinon.restore())

    async function post(body) {
      const req = {
        params: { id: 'book1' },
        user: { id: 'user1', checkCanAccessLibraryItem: () => true },
        libraryItem: { id: 'book1', isBook: true, isFile: false, media: { title: 'Book', ebookFile: { ebookFormat: 'pdf' } } },
        body: { voiceId: 'v1', ...body }
      }
      const res = { statusCode: 200, status: sinon.stub(), send: sinon.stub(), sendStatus: sinon.stub() }
      res.status.callsFake((code) => {
        res.statusCode = code
        return res
      })
      res.sendStatus.callsFake((code) => (res.statusCode = code))
      await ToolsController.generateTts.call(router, req, res)
      return res
    }

    it('defaults to audiobook output without bed', async () => {
      const res = await post({})
      expect(res.statusCode).to.equal(200)
      const options = router.ttsManager.startTts.firstCall.args[2]
      expect(options).to.include({ bedPath: null, bedVolume: 0.15, podcastLibraryItem: null })
    })

    it('accepts an existing bed and volume', async () => {
      const res = await post({ bed: 'bed.mp3', bedVolume: 0.3 })
      expect(res.statusCode).to.equal(200)
      const options = router.ttsManager.startTts.firstCall.args[2]
      expect(options.bedPath).to.equal(Path.join(Path.resolve(global.MetadataPath, 'tts-beds'), 'bed.mp3'))
      expect(options.bedVolume).to.equal(0.3)
    })

    it('rejects bad bed, volume and output', async () => {
      for (const body of [{ bed: 'missing.mp3' }, { bed: '../bed.mp3' }, { bed: 5 }, { bedVolume: 1.5 }, { bedVolume: -0.1 }, { bedVolume: '0.2' }, { output: 'video' }, { output: 'podcast' }]) {
        const res = await post(body)
        expect(res.statusCode, JSON.stringify(body)).to.equal(400)
      }
      expect(router.ttsManager.startTts.called).to.be.false
    })

    it('requires a podcast library item for podcast output', async () => {
      getExpandedById.withArgs('book2').resolves({ id: 'book2', mediaType: 'book', media: {} })
      getExpandedById.withArgs('pod1').resolves({ id: 'pod1', mediaType: 'podcast', media: {}, path: '/podcasts/pod1' })

      expect((await post({ output: 'podcast', podcastLibraryItemId: 'nope' })).statusCode).to.equal(400)
      expect((await post({ output: 'podcast', podcastLibraryItemId: 'book2' })).statusCode).to.equal(400)
      expect(router.ttsManager.startTts.called).to.be.false

      const res = await post({ output: 'podcast', podcastLibraryItemId: 'pod1' })
      expect(res.statusCode).to.equal(200)
      expect(router.ttsManager.startTts.firstCall.args[2].podcastLibraryItem.id).to.equal('pod1')
    })
  })
})
