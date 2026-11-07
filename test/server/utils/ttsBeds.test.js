const Path = require('path')
const { expect } = require('chai')

const { getBedPath, getBedsDir, buildBedMixFilter } = require('../../../server/utils/ttsBeds')

describe('ttsBeds', () => {
  let originalMetadataPath
  before(() => {
    originalMetadataPath = global.MetadataPath
    global.MetadataPath = Path.resolve('/metadata')
  })
  after(() => {
    global.MetadataPath = originalMetadataPath
  })

  describe('getBedPath', () => {
    it('resolves a safe audio filename inside the beds dir', () => {
      expect(getBedPath('Calm Piano.mp3')).to.equal(Path.join(Path.resolve(getBedsDir()), 'Calm Piano.mp3'))
      expect(getBedPath('rain.FLAC')).to.not.be.null
    })

    it('rejects path traversal and separators', () => {
      for (const name of ['../x.mp3', '..\\x.mp3', 'a/b.mp3', 'a\\b.mp3', '..', '...mp3', '/etc/x.mp3', 'C:\\x.mp3']) {
        expect(getBedPath(name), name).to.be.null
      }
    })

    it('rejects non-audio extensions and bad input', () => {
      for (const name of ['x.exe', 'x', 'x.mp3.js', '', null, undefined, 42, {}]) {
        expect(getBedPath(name), String(name)).to.be.null
      }
    })
  })

  describe('buildBedMixFilter', () => {
    it('fades and ducks the bed under the voice, ending with the voice', () => {
      expect(buildBedMixFilter(0.15, 60)).to.equal(
        [
          '[0:a]aformat=sample_rates=44100:channel_layouts=stereo,asplit=2[voice][sc]',
          '[1:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.15,afade=t=in:d=2,afade=t=out:st=58.000:d=2[bed]',
          '[bed][sc]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[duck]',
          '[voice][duck]amix=inputs=2:duration=first:normalize=0[out]'
        ].join(';')
      )
    })

    it('clamps the fade out start for short chapters', () => {
      expect(buildBedMixFilter(0.5, 1)).to.include('afade=t=out:st=0.000:d=2')
    })
  })
})
