const { expect } = require('chai')

const { getWavDuration } = require('../../../server/utils/ttsEngine')

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
