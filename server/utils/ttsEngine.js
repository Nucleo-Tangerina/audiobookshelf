const axios = require('axios')
const Logger = require('../Logger')

// Contract from jamiepine/voicebox backend/routes/generations.py (POST /generate/stream), backend/routes/profiles.py (GET /profiles), backend/models.py
// Voicebox picks the profile's default engine (Qwen3-TTS "qwen" for cloned voices), which supports language "pt"

function getBaseUrl() {
  return (process.env.TTS_ENGINE_URL || '').replace(/\/+$/, '')
}

function getHeaders() {
  return process.env.TTS_ENGINE_API_KEY ? { Authorization: `Bearer ${process.env.TTS_ENGINE_API_KEY}` } : {}
}

// Ready-made pt-BR voices, so there is something to pick before the user clones their own.
// Kokoro voice ids from jamiepine/voicebox backend/backends/kokoro_backend.py; preset profile fields from backend/models.py (VoiceProfileCreate)
const PRESET_VOICES = [
  { name: 'Dora (pt-BR, feminina)', preset_voice_id: 'pf_dora' },
  { name: 'Alex (pt-BR, masculina)', preset_voice_id: 'pm_alex' }
]
module.exports.PRESET_VOICES = PRESET_VOICES

/**
 * Lists engine voice profiles, creating the missing pt-BR presets first
 *
 * @returns {Promise<{id:string, name:string}[]>}
 */
async function listVoices() {
  const response = await axios.get(`${getBaseUrl()}/profiles`, { headers: getHeaders(), timeout: 15000 })
  const profiles = response.data
  for (const preset of PRESET_VOICES) {
    if (profiles.some((p) => p.preset_engine === 'kokoro' && p.preset_voice_id === preset.preset_voice_id)) continue
    try {
      const created = await axios.post(`${getBaseUrl()}/profiles`, { ...preset, language: 'pt', voice_type: 'preset', preset_engine: 'kokoro' }, { headers: getHeaders(), timeout: 15000 })
      profiles.push(created.data)
    } catch (error) {
      // Older Voicebox without Kokoro presets: still list the voices that exist
      Logger.warn(`[ttsEngine] Could not create preset voice "${preset.name}": ${error.response?.data?.detail || error.message}`)
    }
  }
  return profiles.map((p) => ({ id: p.id, name: p.name }))
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

/**
 * Multipart POST with native fetch, axios 0.27 cannot send a native FormData
 *
 * @param {string} path
 * @param {FormData} form
 * @returns {Promise<any>} parsed JSON response
 */
async function postForm(path, form) {
  const response = await fetch(`${getBaseUrl()}${path}`, { method: 'POST', headers: getHeaders(), body: form, signal: AbortSignal.timeout(10 * 60 * 1000) })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : `TTS engine returned ${response.status}`)
  return body
}

/**
 * Clone a voice from one sample: transcribe it, create a profile, attach the sample with its transcript.
 * Contract from jamiepine/voicebox backend/routes/profiles.py (POST /profiles, POST /profiles/{id}/samples needs reference_text, max 30 s) and backend/routes/transcription.py (POST /transcribe)
 *
 * @param {{name:string, language:string, audioBuffer:Buffer, filename:string}} params
 * @returns {Promise<{id:string, name:string}>}
 */
async function createVoice({ name, language, audioBuffer, filename }) {
  const makeForm = () => {
    const form = new FormData()
    form.append('file', new Blob([audioBuffer]), filename)
    return form
  }

  const transcribeForm = makeForm()
  transcribeForm.append('language', language)
  const { text } = await postForm('/transcribe', transcribeForm)
  if (!text?.trim()) throw new Error('No speech detected in the sample')

  const response = await axios.post(`${getBaseUrl()}/profiles`, { name, language }, { headers: getHeaders(), timeout: 15000 })
  const profile = response.data

  try {
    const sampleForm = makeForm()
    sampleForm.append('reference_text', text.trim())
    await postForm(`/profiles/${encodeURIComponent(profile.id)}/samples`, sampleForm)
  } catch (error) {
    // A profile without a sample cannot speak, do not leave it behind
    await deleteVoice(profile.id).catch(() => {})
    throw error
  }
  return { id: profile.id, name: profile.name }
}
module.exports.createVoice = createVoice

/**
 * Contract from jamiepine/voicebox backend/routes/profiles.py (DELETE /profiles/{profile_id})
 *
 * @param {string} id
 */
async function deleteVoice(id) {
  await axios.delete(`${getBaseUrl()}/profiles/${encodeURIComponent(id)}`, { headers: getHeaders(), timeout: 15000 })
}
module.exports.deleteVoice = deleteVoice
