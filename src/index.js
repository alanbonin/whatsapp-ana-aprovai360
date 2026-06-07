import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import Anthropic from '@anthropic-ai/sdk'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import express from 'express'

const app = express()
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Histórico de conversas em memória (por número de telefone)
const conversationHistory = new Map()

const SYSTEM_PROMPT = `Você é Ana, assistente virtual de suporte do AprovAI360 — plataforma de preparação para concursos públicos.

Seu papel é ajudar os alunos com:
- Dúvidas sobre o sistema (como acessar, usar as funcionalidades)
- Problemas de login ou acesso
- Informações sobre planos e assinaturas
- Dúvidas sobre questões e simulados
- Orientações gerais sobre a plataforma

Informações sobre o AprovAI360:
- Site: aprovai360.com.br
- Plataforma de questões e simulados para concursos públicos
- Possui plano gratuito e plano premium
- Suporte por email: suporte@aprovai360.com.br

Regras:
- Seja sempre simpática, objetiva e profissional
- Responda em português brasileiro
- Se não souber responder algo, diga que vai encaminhar para a equipe humana
- Mantenha respostas curtas e diretas (máximo 3 parágrafos)
- Não invente informações sobre o sistema`

async function getAnaResponse(phoneNumber, userMessage) {
  if (!conversationHistory.has(phoneNumber)) {
    conversationHistory.set(phoneNumber, [])
  }

  const history = conversationHistory.get(phoneNumber)
  history.push({ role: 'user', content: userMessage })

  // Manter apenas as últimas 10 mensagens para economizar tokens
  if (history.length > 10) history.splice(0, history.length - 10)

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: history,
  })

  const reply = response.content[0].text
  history.push({ role: 'assistant', content: reply })

  return reply
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Escaneie o QR Code abaixo com o WhatsApp:\n')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('Conexão encerrada. Reconectando:', shouldReconnect)
      if (shouldReconnect) startWhatsApp()
    }

    if (connection === 'open') {
      console.log('✅ Ana conectada ao WhatsApp!')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (!msg.message) continue

      const from = msg.key.remoteJid
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ''

      if (!text) continue

      console.log(`📩 Mensagem de ${from}: ${text}`)

      try {
        const reply = await getAnaResponse(from, text)
        await sock.sendMessage(from, { text: reply })
        console.log(`✉️ Ana respondeu: ${reply}`)
      } catch (err) {
        console.error('Erro ao responder:', err)
        await sock.sendMessage(from, {
          text: 'Olá! Estou com uma instabilidade no momento. Por favor, tente novamente em alguns instantes ou envie um email para suporte@aprovai360.com.br',
        })
      }
    }
  })
}

// Endpoint de health check para o Railway
app.get('/', (_, res) => res.send('Ana - AprovAI360 WhatsApp Bot Online ✅'))
app.listen(process.env.PORT || 3000)

startWhatsApp()
