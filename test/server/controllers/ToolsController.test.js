const { expect } = require('chai')
const sinon = require('sinon')

const ToolsController = require('../../../server/controllers/ToolsController')
const ttsEngine = require('../../../server/utils/ttsEngine')
const Logger = require('../../../server/Logger')

describe('ToolsController', () => {
  describe('createTtsVoice', () => {
    let createVoiceStub
    let res

    beforeEach(() => {
      process.env.TTS_ENGINE_URL = 'http://voicebox.test'
      createVoiceStub = sinon.stub(ttsEngine, 'createVoice').resolves({ id: 'v1', name: 'Minha voz' })
      sinon.stub(Logger, 'error')
      res = { status: sinon.stub().returnsThis(), send: sinon.stub(), json: sinon.stub() }
    })

    afterEach(() => {
      delete process.env.TTS_ENGINE_URL
      sinon.restore()
    })

    const audio = { name: 'sample.webm', mimetype: 'audio/webm', size: 1000, truncated: false }

    it('rejects without consent', async () => {
      await ToolsController.createTtsVoice({ body: { name: 'Minha voz' }, files: { audio }, user: {} }, res)
      expect(res.status.calledWith(400)).to.be.true
      expect(createVoiceStub.called).to.be.false
    })

    it('rejects when consent is not "true"', async () => {
      await ToolsController.createTtsVoice({ body: { name: 'Minha voz', consent: 'false' }, files: { audio }, user: {} }, res)
      expect(res.status.calledWith(400)).to.be.true
      expect(createVoiceStub.called).to.be.false
    })

    it('rejects without an audio file', async () => {
      await ToolsController.createTtsVoice({ body: { name: 'Minha voz', consent: 'true' }, files: null, user: {} }, res)
      expect(res.status.calledWith(400)).to.be.true
      expect(createVoiceStub.called).to.be.false
    })

    it('rejects a non-audio file', async () => {
      await ToolsController.createTtsVoice({ body: { name: 'Minha voz', consent: 'true' }, files: { audio: { ...audio, mimetype: 'application/pdf' } }, user: {} }, res)
      expect(res.status.calledWith(400)).to.be.true
      expect(createVoiceStub.called).to.be.false
    })

    it('rejects a file over the size limit', async () => {
      await ToolsController.createTtsVoice({ body: { name: 'Minha voz', consent: 'true' }, files: { audio: { ...audio, size: 21 * 1024 * 1024 } }, user: {} }, res)
      expect(res.status.calledWith(400)).to.be.true
      expect(createVoiceStub.called).to.be.false
    })
  })
})
