const axios = require('axios')

// Contract from jamiepine/voicebox backend/routes/generations.py (POST /generate/stream), backend/routes/profiles.py (GET /profiles), backend/models.py
// Voicebox picks the profile's default engine (Qwen3-TTS "qwen" for cloned voices), which supports language "pt"

function getBaseUrl() {
  return (process.env.TTS_ENGINE_URL || '').replace(/\/+$/, '')
}

function getHeaders() {
  return process.env.TTS_ENGINE_API_KEY ? { Authorization: `Bearer ${process.env.TTS_ENGINE_API_KEY}` } : {}
}

/**
 * @returns {Promise<{id:string, name:string}[]>}
 */
async function listVoices() {
  const response = await axios.get(`${getBaseUrl()}/profiles`, { headers: getHeaders(), timeout: 15000 })
  return response.data.map((p) => ({ id: p.id, name: p.name }))
}
module.exports.listVoices = listVoices

/**
 * Synthesize text synchronously, response body is WAV bytes
 *
 * @param {{text:string, voiceId:string, language:string}} params
 * @returns {Promise<Buffer>}
 */
async function synthesize({ text, voiceId, language }) {
  const response = await axios.post(
    `${getBaseUrl()}/generate/stream`,
    { profile_id: voiceId, text, language },
    {
      headers: getHeaders(),
      responseType: 'arraybuffer',
      // CPU generation can be slow and the first call may load the model
      timeout: 10 * 60 * 1000
    }
  )
  return Buffer.from(response.data)
}
module.exports.synthesize = synthesize

/**
 * Duration of a PCM WAV buffer from its header (data bytes / byteRate)
 *
 * @param {Buffer} buffer
 * @returns {number} seconds
 */
function getWavDuration(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file')
  let byteRate = 0
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    if (chunkId === 'fmt ') byteRate = buffer.readUInt32LE(offset + 16)
    if (chunkId === 'data') {
      if (!byteRate) throw new Error('WAV data chunk before fmt chunk')
      // Streamed WAVs may carry a placeholder size, never read past the buffer
      return Math.min(chunkSize, buffer.length - offset - 8) / byteRate
    }
    offset += 8 + chunkSize + (chunkSize % 2)
  }
  throw new Error('WAV has no data chunk')
}
module.exports.getWavDuration = getWavDuration
