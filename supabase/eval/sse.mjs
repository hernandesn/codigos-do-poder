export function parseSse(body) {
  const events = []
  for (const block of String(body).split('\n\n')) {
    if (!block.trim()) continue
    let event = 'message'
    const dataLines = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    const dataText = dataLines.join('\n')
    let data = dataText
    if (dataText) {
      try {
        data = JSON.parse(dataText)
      } catch {
        data = dataText
      }
    } else {
      data = null
    }
    events.push({ event, data })
  }
  return events
}

export function textoDoFluxo(events) {
  let text = ''
  for (const event of events) {
    if (event.event !== 'delta' && event.event !== 'token') continue
    if (typeof event.data === 'string') {
      text += event.data
      continue
    }
    if (!event.data || typeof event.data !== 'object') continue
    if (typeof event.data.text === 'string') text += event.data.text
    else if (typeof event.data.content === 'string') text += event.data.content
  }
  return text
}

export function parseModelJson(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  try {
    return JSON.parse(fence ? fence[1] : trimmed)
  } catch {
    return null
  }
}

export function terminalCompleto(buf) {
  const parts = String(buf).split('\n\n')
  const complete = parts.slice(0, -1)
  return complete.some((block) => /^event:\s*(final|error)\b/m.test(block))
}
