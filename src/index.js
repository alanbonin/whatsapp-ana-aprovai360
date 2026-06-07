import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import Anthropic from '@anthropic-ai/sdk'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import pino from 'pino'
import express from 'express'

const app = express()
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

let currentQR = null
let isConnected = false

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

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr
      isConnected = false
      console.log('\n📱 QR Code disponível em: ' + (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:3000'))
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

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🌐 Servidor rodando na porta ${PORT}`))

startWhatsApp()
