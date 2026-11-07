<template>
  <div id="page-wrapper" class="bg-bg page overflow-y-auto relative" :class="streamLibraryItem ? 'streaming' : ''">
    <div class="max-w-3xl mx-auto px-4 py-6">
      <nuxt-link :to="`/item/${libraryItem.id}`" class="hover:underline">
        <h1 class="text-lg lg:text-xl">{{ title }}</h1>
      </nuxt-link>
      <p class="text-sm text-gray-400 mb-6">{{ $strings.ButtonReadAlong }}</p>

      <section v-for="chapter in chapters" :key="chapter.file" class="mb-10">
        <h2 class="text-base font-semibold text-gray-200 mb-3">{{ chapter.title }}</h2>
        <p class="text-lg leading-relaxed text-gray-300">
          <template v-for="sentence in chapter.sentences">
            <button :key="sentence.index" type="button" class="inline text-left rounded-sm px-0.5 hover:text-white focus-visible:outline-1 focus-visible:outline-white" :class="sentence.index === activeIndex ? 'bg-yellow-400/25 text-white' : ''" :aria-current="sentence.index === activeIndex ? 'true' : null" @click="seekTo(sentence)">{{ sentence.text }}</button>{{ ' ' }}
          </template>
        </p>
      </section>
    </div>
  </div>
</template>

<script>
export default {
  async asyncData({ store, params, app, redirect }) {
    const libraryItem = await app.$axios.$get(`/api/items/${params.id}?expanded=1`).catch((error) => {
      console.error('Failed', error)
      return null
    })
    if (!libraryItem) return redirect('/')

    const alignment = await app.$axios.$get(`/api/items/${params.id}/tts/alignment`).catch(() => null)
    if (!alignment) return redirect(`/item/${params.id}`)

    // Fetch and set library if this items library does not match the current
    if (store.state.libraries.currentLibraryId !== libraryItem.libraryId || !store.state.libraries.filterData) {
      await store.dispatch('libraries/fetch', libraryItem.libraryId)
    }
    return { libraryItem, alignment }
  },
  data() {
    return {
      currentTime: 0
    }
  },
  computed: {
    streamLibraryItem() {
      return this.$store.state.streamLibraryItem
    },
    title() {
      return this.libraryItem.media.metadata.title
    },
    sentences() {
      // Alignment times are per chapter file; global time = track startOffset + time in file
      const offsets = {}
      ;(this.libraryItem.media.tracks || []).forEach((track) => (offsets[track.metadata.filename] = track.startOffset))
      return this.alignment
        .filter((a) => offsets[a.file] !== undefined)
        .map((a) => ({ ...a, start: offsets[a.file] + a.start, end: offsets[a.file] + a.end }))
        .sort((a, b) => a.start - b.start)
        .map((s, index) => ({ ...s, index }))
    },
    chapters() {
      const chapters = []
      this.sentences.forEach((s) => {
        let chapter = chapters[chapters.length - 1]
        if (!chapter || chapter.file !== s.file) {
          chapter = { file: s.file, title: s.file.replace(/\.[^.]+$/, ''), sentences: [] }
          chapters.push(chapter)
        }
        chapter.sentences.push(s)
      })
      return chapters
    },
    activeIndex() {
      // Binary search for the last sentence starting at or before currentTime
      let lo = 0
      let hi = this.sentences.length - 1
      let found = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (this.sentences[mid].start <= this.currentTime) {
          found = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return found
    }
  },
  watch: {
    activeIndex() {
      this.$nextTick(() => {
        const el = this.$el.querySelector('[aria-current="true"]')
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    }
  },
  methods: {
    playerTimeUpdate(time) {
      if (this.$store.getters['getIsMediaStreaming'](this.libraryItem.id)) this.currentTime = time
    },
    seekTo(sentence) {
      // Same item already loaded: player seeks; otherwise it loads the item and starts at this time
      this.$eventBus.$emit('play-item', {
        libraryItemId: this.libraryItem.id,
        episodeId: null,
        startTime: sentence.start,
        queueItems: [
          {
            libraryItemId: this.libraryItem.id,
            libraryId: this.libraryItem.libraryId,
            episodeId: null,
            title: this.title,
            subtitle: this.libraryItem.media.metadata.authors.map((au) => au.name).join(', '),
            caption: '',
            duration: this.libraryItem.media.duration || null,
            coverPath: this.libraryItem.media.coverPath || null
          }
        ]
      })
    }
  },
  mounted() {
    const progress = this.$store.getters['user/getUserMediaProgress'](this.libraryItem.id)
    this.currentTime = progress?.currentTime || 0
    this.$eventBus.$on('player-current-time', this.playerTimeUpdate)
  },
  beforeDestroy() {
    this.$eventBus.$off('player-current-time', this.playerTimeUpdate)
  }
}
</script>
