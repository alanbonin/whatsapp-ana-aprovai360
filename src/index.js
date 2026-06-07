import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import Anthropic from '@anthropic-ai/sdk'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import pino from 'pino'
import express from 'express'

const app = express()
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SUPORTE_NUMBER = '5571991606505@s.whatsapp.net'

let currentQR = null
let isConnected = false
let faqContent = ''
let sock = null

const conversationHistory = new Map()

async function fetchFAQ() {
  try {
    const res = await fetch('https://aprovai360.com.br/api/faq', {
      headers: { 'User-Agent': 'AnaBot/1.0' },
      redirect: 'follow',
    })
    if (res.ok) {
      const data = await res.text()
      faqContent = data.slice(0, 3000)
      console.log('✅ FAQ atualizado com sucesso')
    }
  } catch (err) {
    console.error('Erro ao buscar FAQ:', err.message)
  }
}

function buildSystemPrompt() {
  return `Você é Ana, assistente virtual de suporte do AprovAI360 — plataforma de preparação para concursos públicos.

Seu papel é ajudar os alunos com dúvidas sobre o sistema, acesso, planos, questões e simulados.

Informações do sistema:
- Site: aprovai360.com.br
- Suporte humano: Equipe de Suporte (disponível se você não conseguir resolver)

${faqContent ? `=== INFORMAÇÕES DO SISTEMA (FAQ) ===\n${faqContent}\n===================================` : ''}

Regras IMPORTANTES:
- Responda sempre em português brasileiro
- Seja simpática, objetiva e profissional
- Respostas curtas e diretas (máximo 3 parágrafos)
- Não invente informações que não estejam no FAQ acima
- Se o aluno pedir para falar com humano, ou se você não souber responder, responda EXATAMENTE com: [ENCAMINHAR_SUPORTE]
- Se a dúvida for muito específica ou técnica e não estiver no FAQ, responda com: [ENCAMINHAR_SUPORTE]`
}

async function getAnaResponse(phoneNumber, userMessage) {
  if (!conversationHistory.has(phoneNumber)) {
    conversationHistory.set(phoneNumber, [])
  }

  const history = conversationHistory.get(phoneNumber)
  history.push({ role: 'user', content: userMessage })

  if (history.length > 10) history.splice(0, history.length - 10)

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: buildSystemPrompt(),
    messages: history,
  })

  const reply = response.content[0].text
  history.push({ role: 'assistant', content: reply })

  return reply
}

async function encaminharParaSuporte(sock, from, clientName) {
  // Avisa o aluno
  await sock.sendMessage(from, {
    text: 'Vou encaminhar para nossa Equipe de Suporte. Em breve alguém entrará em contato com você! 😊',
  })

  // Notifica o número de suporte
  const phoneFrom = from.replace('@s.whatsapp.net', '').replace('@lid', '')
  await sock.sendMessage(SUPORTE_NUMBER, {
    text: `🔔 *Novo chamado de suporte*\n\n📱 Cliente: +${phoneFrom}\n💬 Precisa de atendimento humano no WhatsApp.`,
  })
}

// Página web com QR Code
app.get('/', async (req, res) => {
  if (isConnected) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#f0f0f0">
        <h1 style="color:green">✅ Ana está conectada ao WhatsApp!</h1>
        <p>O bot está funcionando normalmente.</p>
        <p style="color:#888">AprovAI360 - Suporte via WhatsApp</p>
      </body></html>
    `)
  }

  if (!currentQR) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#f0f0f0">
        <h1>⏳ Aguardando QR Code...</h1>
        <p>Recarregue a página em alguns segundos.</p>
        <script>setTimeout(()=>location.reload(), 3000)</script>
      </body></html>
    `)
  }

  const qrImage = await QRCode.toDataURL(currentQR)
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#f0f0f0">
      <h1>📱 Conectar Ana ao WhatsApp</h1>
      <p>Abra o WhatsApp → Aparelhos conectados → Conectar aparelho</p>
      <img src="${qrImage}" style="width:300px;height:300px;border:4px solid #25D366;border-radius:12px"/>
      <p style="color:#888">QR Code expira em 60 segundos. Recarregue se necessário.</p>
      <script>setTimeout(()=>location.reload(), 30000)</script>
    </body></html>
  `)
})

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr
      isConnected = false
      const url = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : 'http://localhost:3000'
      console.log(`\n📱 QR Code disponível em: ${url}`)
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      isConnected = false
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('Conexão encerrada. Reconectando:', shouldReconnect)
      if (shouldReconnect) startWhatsApp()
    }

    if (connection === 'open') {
      currentQR = null
      isConnected = true
      console.log('✅ Ana conectada ao WhatsApp!')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (!msg.message) continue

      const from = msg.key.remoteJid
      if (from === SUPORTE_NUMBER) continue

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ''

      if (!text) continue

      console.log(`📩 Mensagem de ${from}: ${text}`)

      try {
        const reply = await getAnaResponse(from, text)

        if (reply.includes('[ENCAMINHAR_SUPORTE]')) {
          await encaminharParaSuporte(sock, from)
          console.log(`📞 Encaminhado para suporte: ${from}`)
        } else {
          await sock.sendMessage(from, { text: reply })
          console.log(`✉️ Ana respondeu: ${reply}`)
        }
      } catch (err) {
        console.error('Erro ao responder:', err)
        await sock.sendMessage(from, {
          text: 'Olá! Estou com uma instabilidade no momento. Por favor, tente novamente em alguns instantes ou envie um email para suporte@aprovai360.com.br',
        })
      }
    }
  })
}

// Busca FAQ ao iniciar e atualiza a cada hora
await fetchFAQ()
setInterval(fetchFAQ, 60 * 60 * 1000)

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🌐 Servidor rodando na porta ${PORT}`))

startWhatsApp()
