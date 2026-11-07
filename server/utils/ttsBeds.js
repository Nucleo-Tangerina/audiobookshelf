const Path = require('path')
const { sanitizeFilename } = require('./fileUtils')

const BED_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac']
const MAX_BED_SIZE = 100 * 1024 * 1024
const BED_FADE_SECONDS = 2

function getBedsDir() {
  return Path.join(global.MetadataPath, 'tts-beds')
}

/**
 * Resolve a bed filename to its path inside the beds dir
 *
 * @param {string} name
 * @returns {string|null} null when the name is unsafe or not an audio file
 */
function getBedPath(name) {
  if (typeof name !== 'string' || !name || name !== sanitizeFilename(name)) return null
  if (name.includes('..') || /[\/\\]/.test(name)) return null
  if (!BED_EXTENSIONS.includes(Path.extname(name).toLowerCase())) return null
  const bedsDir = Path.resolve(getBedsDir())
  const bedPath = Path.resolve(bedsDir, name)
  if (Path.dirname(bedPath) !== bedsDir) return null
  return bedPath
}

/**
 * ffmpeg -filter_complex for input 0 = voice, input 1 = looped bed.
 * Bed is faded in/out and ducked under the voice, output ends with the voice.
 *
 * @param {number} bedVolume 0-1
 * @param {number} duration voice duration in seconds
 * @returns {string} graph with output label [out]
 */
function buildBedMixFilter(bedVolume, duration) {
  const format = 'aformat=sample_rates=44100:channel_layouts=stereo'
  const fadeOutStart = Math.max(0, duration - BED_FADE_SECONDS).toFixed(3)
  return [
    `[0:a]${format},asplit=2[voice][sc]`,
    `[1:a]${format},volume=${bedVolume},afade=t=in:d=${BED_FADE_SECONDS},afade=t=out:st=${fadeOutStart}:d=${BED_FADE_SECONDS}[bed]`,
    `[bed][sc]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[duck]`,
    `[voice][duck]amix=inputs=2:duration=first:normalize=0[out]`
  ].join(';')
}

module.exports = { BED_EXTENSIONS, MAX_BED_SIZE, getBedsDir, getBedPath, buildBedMixFilter }
