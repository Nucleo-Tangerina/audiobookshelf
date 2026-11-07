const { expect } = require('chai')
const sinon = require('sinon')
const axios = require('axios')

const Logger = require('../../../server/Logger')
const { getWavDuration, listVoices, synthesize } = require('../../../server/utils/ttsEngine')

function makeWav({ sampleRate = 24000, channels = 1, bitsPerSample = 16, seconds = 1.5, extraChunk = false, dataSizeOverride = null } = {}) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const dataSize = Math.round(byteRate * seconds)
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'ascii')
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8)
  fmt.writeUInt16LE(channels, 10)
  fmt.writeUInt32LE(sampleRate, 12)
  fmt.writeUInt32LE(byteRate, 16)
  fmt.writeUInt16LE((channels * bitsPerSample) / 8, 20)
  fmt.writeUInt16LE(bitsPerSample, 22)
  // Odd sized chunk exercises the pad byte
  const list = extraChunk ? Buffer.concat([Buffer.from('LIST', 'ascii'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc\0', 'ascii')]) : Buffer.alloc(0)
  const dataHeader = Buffer.alloc(8)
  dataHeader.write('data', 0, 'ascii')
  dataHeader.writeUInt32LE(dataSizeOverride ?? dataSize, 4)
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmt, list, dataHeader, Buffer.alloc(dataSize)])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

describe('ttsEngine', () => {
  describe('synthesize', () => {
    afterEach(() => {
      delete process.env.TTS_ENGINE_MODEL_SIZE
      sinon.restore()
    })

    it('sends model_size only when TTS_ENGINE_MODEL_SIZE is set', async () => {
      const post = sinon.stub(axios, 'post').resolves({ data: new ArrayBuffer(4) })
      await synthesize({ text: 'Olá.', voiceId: 'v1', language: 'pt' })
      expect(post.firstCall.args[1]).to.deep.equal({ profile_id: 'v1', text: 'Olá.', language: 'pt' })

      process.env.TTS_ENGINE_MODEL_SIZE = '0.6B'
      await synthesize({ text: 'Olá.', voiceId: 'v1', language: 'pt' })
      expect(post.secondCall.args[1].model_size).to.equal('0.6B')
    })
  })

  describe('listVoices', () => {
    afterEach(() => sinon.restore())

    it('creates the missing pt-BR presets and lists them with existing profiles', async () => {
      const dora = { id: 'p1', name: 'Dora', preset_engine: 'kokoro', preset_voice_id: 'pf_dora' }
      sinon.stub(axios, 'get').resolves({ data: [{ id: 'c1', name: 'Minha voz', voice_type: 'cloned' }, dora] })
      const post = sinon.stub(axios, 'post').resolves({ data: { id: 'p2', name: 'Alex (pt-BR, masculina)' } })

      const voices = await listVoices()

      expect(post.calledOnce).to.be.true
      expect(post.firstCall.args[1]).to.include({ preset_voice_id: 'pm_alex', preset_engine: 'kokoro', voice_type: 'preset', language: 'pt' })
      expect(voices.map((v) => v.id)).to.deep.equal(['c1', 'p1', 'p2'])
    })

    it('still lists voices when the engine rejects presets', async () => {
      sinon.stub(Logger, 'warn')
      sinon.stub(axios, 'get').resolves({ data: [{ id: 'c1', name: 'Minha voz' }] })
      sinon.stub(axios, 'post').rejects(new Error('400'))

      expect(await listVoices()).to.deep.equal([{ id: 'c1', name: 'Minha voz' }])
    })
  })

  describe('getWavDuration', () => {
    it('computes duration from data size and byte rate', () => {
      expect(getWavDuration(makeWav({ seconds: 1.5 }))).to.equal(1.5)
      expect(getWavDuration(makeWav({ sampleRate: 44100, channels: 2, seconds: 2 }))).to.equal(2)
    })

    it('skips other chunks before data', () => {
      expect(getWavDuration(makeWav({ seconds: 0.5, extraChunk: true }))).to.equal(0.5)
    })

    it('uses the buffer length when data size is a streaming placeholder', () => {
      expect(getWavDuration(makeWav({ seconds: 1, dataSizeOverride: 0xffffffff }))).to.equal(1)
    })

    it('throws on non-WAV input', () => {
      expect(() => getWavDuration(Buffer.from('ID3 not a wav file'))).to.throw('Not a WAV file')
    })
  })
})
