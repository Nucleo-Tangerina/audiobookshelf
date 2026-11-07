const { expect } = require('chai')

const { cleanPages, splitSentences, buildChapters } = require('../../../server/utils/pdfText')

describe('pdfText', () => {
  describe('cleanPages', () => {
    it('removes headers/footers repeated on most pages and bare page numbers', () => {
      const bodies = ['Era uma vez.', 'Um rei.', 'Uma rainha.', 'Fim.']
      const pages = bodies.map((body, i) => `Meu Livro - Capítulo\n${body}\n${i + 1}\nPágina ${i + 1} de 4`)
      expect(cleanPages(pages)).to.deep.equal(bodies)
    })

    it('keeps repeated lines when there are fewer than 3 pages', () => {
      expect(cleanPages(['Cabeçalho\nUm.', 'Cabeçalho\nDois.'])).to.deep.equal(['Cabeçalho Um.', 'Cabeçalho Dois.'])
    })

    it('joins hyphenated line breaks and collapses whitespace', () => {
      expect(cleanPages(['A pala-\nvra   foi\n\n  dita.'])).to.deep.equal(['A palavra foi dita.'])
    })

    it('keeps hyphen before an uppercase word', () => {
      expect(cleanPages(['Rio-\nGrande'])).to.deep.equal(['Rio- Grande'])
    })

    it('returns empty strings for pages without text', () => {
      expect(cleanPages(['', '  \n '])).to.deep.equal(['', ''])
    })
  })

  describe('splitSentences', () => {
    it('splits on sentence punctuation', () => {
      expect(splitSentences('Olá mundo. Tudo bem? Sim! Fim…')).to.deep.equal(['Olá mundo.', 'Tudo bem?', 'Sim!', 'Fim…'])
    })

    it('does not split on pt-BR abbreviations', () => {
      const text = 'O Sr. Silva e a Sra. Souza falaram com a Srta. Lima. O Dr. Pereira e a Dra. Ana chegaram. O Prof. João e a Profa. Maria leram a pág. 12 e a p. 13. Moro na Av. Paulista, nº 1000. A Empresa Ltda. Faz tudo. A Petrobras S.A. Anunciou lucro. Livros, revistas etc. Foram vendidos.'
      expect(splitSentences(text)).to.deep.equal(['O Sr. Silva e a Sra. Souza falaram com a Srta. Lima.', 'O Dr. Pereira e a Dra. Ana chegaram.', 'O Prof. João e a Profa. Maria leram a pág. 12 e a p. 13.', 'Moro na Av. Paulista, nº 1000.', 'A Empresa Ltda. Faz tudo.', 'A Petrobras S.A. Anunciou lucro.', 'Livros, revistas etc. Foram vendidos.'])
    })

    it('does not split on decimals, ordinals or initials', () => {
      expect(splitSentences('A taxa subiu 3,5% no 1º trimestre. O valor era 2.5 mil. J. R. R. Tolkien escreveu. A 2ª edição saiu.')).to.deep.equal(['A taxa subiu 3,5% no 1º trimestre.', 'O valor era 2.5 mil.', 'J. R. R. Tolkien escreveu.', 'A 2ª edição saiu.'])
    })

    it('does not split before a lowercase word', () => {
      expect(splitSentences('Ele disse... e saiu.')).to.deep.equal(['Ele disse... e saiu.'])
    })

    it('keeps closing quotes with the sentence', () => {
      expect(splitSentences('Ela disse: "Vamos." Depois foi.')).to.deep.equal(['Ela disse: "Vamos."', 'Depois foi.'])
    })

    it('splits long sentences at commas, then spaces, within maxChars', () => {
      const chunks = splitSentences('um dois três quatro cinco, seis sete oito nove dez onze doze treze.', 30)
      expect(chunks).to.deep.equal(['um dois três quatro cinco,', 'seis sete oito nove dez onze', 'doze treze.'])
      chunks.forEach((c) => expect(c.length).to.be.at.most(30))
    })

    it('hard cuts a word longer than maxChars', () => {
      expect(splitSentences('abcdefghij', 4)).to.deep.equal(['abcd', 'efgh', 'ij'])
    })
  })

  describe('buildChapters', () => {
    it('groups pages into chapters and tags sentences with their page', () => {
      const chapters = buildChapters(['Primeira frase. Começo da', 'segunda frase. Terceira.', '', 'Quarta.'], 2)
      expect(chapters).to.deep.equal([
        {
          index: 1,
          sentences: [
            { text: 'Primeira frase.', page: 1 },
            { text: 'Começo da segunda frase.', page: 1 },
            { text: 'Terceira.', page: 2 }
          ]
        },
        { index: 2, sentences: [{ text: 'Quarta.', page: 4 }] }
      ])
    })

    it('skips chapters without text and numbers chapters consecutively', () => {
      expect(buildChapters(['', '', 'Texto.'], 2)).to.deep.equal([{ index: 1, sentences: [{ text: 'Texto.', page: 3 }] }])
      expect(buildChapters(['', ''], 10)).to.deep.equal([])
    })
  })
})
