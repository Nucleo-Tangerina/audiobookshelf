<template>
  <div>
    <app-settings-content :header-text="$strings.HeaderVoices" :description="''">
      <p v-if="!ttsEnabled" class="text-warning">{{ $strings.MessageTtsEngineUnavailable }}</p>
      <template v-else>
        <!-- voice list -->
        <div class="mb-8">
          <p v-if="!voices.length" class="text-gray-300">{{ $strings.MessageNoVoices }}</p>
          <div v-for="voice in voices" :key="voice.id" class="flex items-center py-2 px-3 border-b border-white/10">
            <span class="material-symbols text-xl text-gray-300 mr-3">record_voice_over</span>
            <p class="grow truncate">{{ voice.name }}</p>
            <ui-btn small color="bg-error" :loading="deletingVoiceId === voice.id" @click="deleteVoiceClick(voice)">{{ $strings.ButtonDelete }}</ui-btn>
          </div>
        </div>

        <!-- create voice -->
        <p class="text-lg font-semibold mb-2">{{ $strings.HeaderCloneMyVoice }}</p>
        <form @submit.prevent="submit">
          <div class="flex flex-wrap items-end -mx-1 mb-4">
            <ui-text-input-with-label v-model="name" :label="$strings.LabelVoiceName" :disabled="creating" class="m-1 max-w-xs" />
            <ui-dropdown v-model="language" :items="languageItems" :label="$strings.LabelLanguage" :disabled="creating" class="m-1 max-w-xs" />
          </div>

          <p class="mb-1 font-semibold">{{ $strings.LabelVoiceReadingScript }}</p>
          <div class="bg-primary/25 border border-white/10 rounded-md p-4 mb-2 leading-relaxed">{{ readingScript }}</div>
          <p class="text-sm text-gray-300 mb-4">{{ $strings.LabelVoiceRecordingTip }}</p>

          <div class="flex flex-wrap items-center gap-2 mb-2">
            <ui-btn v-if="!recording" type="button" color="bg-primary" :disabled="creating" @click="startRecording">
              <span class="material-symbols text-base align-middle mr-1">mic</span>{{ $strings.ButtonStartRecording }}
            </ui-btn>
            <ui-btn v-else type="button" color="bg-error" @click="stopRecording">
              <span class="material-symbols text-base align-middle mr-1">stop</span>{{ $strings.ButtonStopRecording }}
            </ui-btn>
            <p v-if="recording || recordedSeconds" class="font-mono">{{ $secondsToTimestamp(recordedSeconds) }}</p>
            <ui-file-input ref="fileInput" accept="audio/*" class="ml-auto" @change="fileSelected">{{ $strings.ButtonUploadAudioFile }}</ui-file-input>
          </div>
          <p v-if="sampleFile && sampleFile.name" class="text-sm text-gray-300 mb-2">{{ sampleFile.name }}</p>
          <audio v-if="previewUrl" :src="previewUrl" controls class="w-full max-w-md mb-4" />

          <ui-checkbox v-model="consent" :label="$strings.LabelVoiceConsent" checkbox-bg="bg" class="mb-4" />

          <div class="flex">
            <ui-btn type="submit" color="bg-success" :loading="creating" :disabled="!canSubmit">{{ $strings.ButtonCreateVoice }}</ui-btn>
          </div>
        </form>
      </template>
    </app-settings-content>
  </div>
</template>

<script>
const MIN_RECORDING_SECONDS = 5
// Voicebox rejects reference samples longer than 30 s
const MAX_RECORDING_SECONDS = 30

export default {
  async asyncData({ store, redirect, app }) {
    if (!store.getters['user/getIsAdminOrUp']) {
      return redirect('/')
    }
    const ttsStatus = await app.$axios.$get('/api/tools/tts/status').catch(() => null)
    return { ttsEnabled: !!ttsStatus?.enabled }
  },
  data() {
    return {
      voices: [],
      deletingVoiceId: null,
      name: '',
      language: 'pt',
      consent: false,
      creating: false,
      recording: false,
      recordedSeconds: 0,
      mediaRecorder: null,
      recordTimer: null,
      sampleFile: null,
      previewUrl: null
    }
  },
  computed: {
    languageItems() {
      return [
        { value: 'pt', text: 'Português (Brasil)' },
        { value: 'en', text: 'English' }
      ]
    },
    readingScript() {
      if (this.language === 'en') {
        return 'Hello! Today I am reading a short passage to record my voice. On Saturday morning the market in the square was already busy: there were bananas, apples, warm bread and fresh coffee. The old man who sells shoes and umbrellas told me it rained a lot in the hills. I laughed, thanked him and kept walking slowly, listening to the cars, the children and the birds. Will it be sunny tomorrow?'
      }
      return 'Olá! Hoje eu vou ler um pequeno trecho para registrar a minha voz. Na manhã de sábado, a feira da praça já estava cheia: tinha banana, maçã, pão de queijo e café fresquinho. O seu Joaquim, que vende chinelos e guarda-chuvas, contou que choveu muito lá na serra. Eu ri, agradeci e segui caminhando devagar, ouvindo o barulho dos carros, das crianças e dos passarinhos. Será que amanhã vai fazer sol?'
    },
    canSubmit() {
      return this.consent && !!this.name.trim() && !!this.sampleFile && !this.recording
    }
  },
  methods: {
    fetchVoices() {
      this.$axios
        .$get('/api/tools/tts/voices')
        .then((data) => {
          this.voices = data.voices || []
        })
        .catch((error) => {
          console.error('Failed to fetch voices', error)
          this.$toast.error(this.$strings.MessageTtsEngineUnavailable)
        })
    },
    setSample(file) {
      if (this.previewUrl) URL.revokeObjectURL(this.previewUrl)
      this.sampleFile = file
      this.previewUrl = file ? URL.createObjectURL(file) : null
    },
    fileSelected(file) {
      this.recordedSeconds = 0
      this.setSample(file)
    },
    async startRecording() {
      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (error) {
        console.error('Microphone access failed', error)
        this.$toast.error(this.$strings.MessageMicrophonePermissionDenied)
        return
      }
      this.setSample(null)
      this.$refs.fileInput?.reset()
      const chunks = []
      const recorder = new MediaRecorder(stream)
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        clearInterval(this.recordTimer)
        this.recording = false
        if (this.recordedSeconds < MIN_RECORDING_SECONDS) {
          this.recordedSeconds = 0
          this.$toast.error(this.$strings.MessageVoiceRecordingTooShort)
          return
        }
        const type = recorder.mimeType || 'audio/webm'
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
        this.setSample(new File(chunks, `recording.${ext}`, { type }))
      }
      this.mediaRecorder = recorder
      this.recordedSeconds = 0
      this.recording = true
      recorder.start()
      this.recordTimer = setInterval(() => {
        this.recordedSeconds++
        if (this.recordedSeconds >= MAX_RECORDING_SECONDS) this.stopRecording()
      }, 1000)
    },
    stopRecording() {
      if (this.mediaRecorder?.state === 'recording') this.mediaRecorder.stop()
    },
    submit() {
      if (!this.canSubmit) return
      const form = new FormData()
      form.set('name', this.name.trim())
      form.set('language', this.language)
      form.set('consent', 'true')
      form.set('audio', this.sampleFile)
      this.creating = true
      this.$axios
        .$post('/api/tools/tts/voices', form)
        .then(() => {
          this.$toast.success(this.$strings.ToastVoiceCreateSuccess)
          this.name = ''
          this.consent = false
          this.recordedSeconds = 0
          this.setSample(null)
          this.$refs.fileInput?.reset()
          this.fetchVoices()
        })
        .catch((error) => {
          console.error('Failed to create voice', error)
          this.$toast.error(error.response?.data || this.$strings.ToastVoiceCreateFailed)
        })
        .finally(() => {
          this.creating = false
        })
    },
    deleteVoiceClick(voice) {
      const payload = {
        message: this.$getString('MessageConfirmDeleteVoice', [voice.name]),
        callback: (confirmed) => {
          if (confirmed) this.deleteVoice(voice)
        },
        type: 'yesNo'
      }
      this.$store.commit('globals/setConfirmPrompt', payload)
    },
    deleteVoice(voice) {
      this.deletingVoiceId = voice.id
      this.$axios
        .$delete(`/api/tools/tts/voices/${encodeURIComponent(voice.id)}`)
        .then(() => {
          this.$toast.success(this.$strings.ToastVoiceDeleteSuccess)
          this.voices = this.voices.filter((v) => v.id !== voice.id)
        })
        .catch((error) => {
          console.error('Failed to delete voice', error)
          this.$toast.error(this.$strings.ToastVoiceDeleteFailed)
        })
        .finally(() => {
          this.deletingVoiceId = null
        })
    }
  },
  mounted() {
    if (this.ttsEnabled) this.fetchVoices()
  },
  beforeDestroy() {
    this.stopRecording()
    clearInterval(this.recordTimer)
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl)
  }
}
</script>
