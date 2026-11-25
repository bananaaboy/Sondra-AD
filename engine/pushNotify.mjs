export async function dispatchPushNotifications(cfg, { title, body, level = 'info' } = {}) {
  const results = []
  const textTitle = String(title || 'Sondra AD').slice(0, 200)
  const textBody = String(body || '').slice(0, 1500)

  if (cfg?.discordWebhookUrl && String(cfg.discordWebhookUrl).trim()) {
    try {
      const color = level === 'error' ? 0xdc2626 : level === 'warn' ? 0xd97706 : 0x16a34a
      const res = await fetch(String(cfg.discordWebhookUrl).trim(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'Sondra AD',
          embeds: [{ title: textTitle, description: textBody, color }],
        }),
      })
      results.push({ channel: 'discord', ok: res.ok, status: res.status })
    } catch (err) {
      results.push({ channel: 'discord', ok: false, error: String(err?.message ?? err) })
    }
  }

  if (cfg?.telegramBotToken && cfg?.telegramChatId) {
    try {
      const base = (process.env.SONDRA_TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '')
      const url = `${base}/bot${encodeURIComponent(String(cfg.telegramBotToken).trim())}/sendMessage`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: String(cfg.telegramChatId).trim(),
          text: `${textTitle}\n${textBody}`,
          disable_web_page_preview: true,
        }),
      })
      results.push({ channel: 'telegram', ok: res.ok, status: res.status })
    } catch (err) {
      results.push({ channel: 'telegram', ok: false, error: String(err?.message ?? err) })
    }
  }

  if (cfg?.ntfyUrl && String(cfg.ntfyUrl).trim()) {
    try {
      const headers = {
        Title: textTitle.replace(/[\r\n]+/g, ' '),
        Priority: level === 'error' ? 'high' : level === 'warn' ? 'default' : 'low',
      }
      if (cfg.ntfyToken && String(cfg.ntfyToken).trim()) {
        headers.Authorization = `Bearer ${String(cfg.ntfyToken).trim()}`
      }
      const res = await fetch(String(cfg.ntfyUrl).trim(), {
        method: 'POST',
        headers,
        body: textBody,
      })
      results.push({ channel: 'ntfy', ok: res.ok, status: res.status })
    } catch (err) {
      results.push({ channel: 'ntfy', ok: false, error: String(err?.message ?? err) })
    }
  }

  if (cfg?.pushoverAppToken && cfg?.pushoverUserKey) {
    try {
      const endpoint = process.env.SONDRA_PUSHOVER_API_URL || 'https://api.pushover.net/1/messages.json'
      const params = new URLSearchParams({
        token: String(cfg.pushoverAppToken).trim(),
        user: String(cfg.pushoverUserKey).trim(),
        title: textTitle,
        message: textBody || textTitle,
        priority: level === 'error' ? '1' : '0',
      })
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })
      results.push({ channel: 'pushover', ok: res.ok, status: res.status })
    } catch (err) {
      results.push({ channel: 'pushover', ok: false, error: String(err?.message ?? err) })
    }
  }

  return results
}
