module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'missing_openai_key' });
  }

  const source = req.body && req.body.caseData;
  if (!source || typeof source !== 'object') {
    return res.status(400).json({ error: 'invalid_case_data' });
  }

  const cleanText = (value, max = 6000) => String(value || '').slice(0, max);
  const history = Array.isArray(source.history)
    ? source.history.slice(-30).map(item => ({
        type: cleanText(item && item.type, 120),
        text: cleanText(item && item.text, 3000),
        date: cleanText(item && item.date, 120)
      }))
    : [];

  const contact = source.contact && typeof source.contact === 'object' ? {
    name: cleanText(source.contact.name, 300),
    type: cleanText(source.contact.type, 120),
    street: cleanText(source.contact.street, 300),
    city: cleanText(source.contact.city, 200),
    phone: cleanText(source.contact.phone, 120),
    mobile: cleanText(source.contact.mobile, 120),
    email: cleanText(source.contact.email, 300),
    website: cleanText(source.contact.website, 500)
  } : {};

  const caseData = {
    title: cleanText(source.title, 500),
    category: cleanText(source.category, 200),
    status: cleanText(source.status, 200),
    goalAndDescription: cleanText(source.desc, 6000),
    lastKnownStep: cleanText(source.nextStep, 6000),
    contact,
    history,
    allowedSources: source.sourceSettings || {}
  };

  const systemPrompt = `Du bist der intelligente persönliche Sekretär in der App Sekretarz.
Analysiere ausschließlich die übergebenen Informationen dieser Angelegenheit.
Deine Aufgabe ist NICHT, eine starre Regel anzuwenden, sondern aus Ziel, aktuellem Stand, Kontakt und gesamter Historie den aktuell sinnvollsten nächsten Schritt abzuleiten.

Wichtige Regeln:
- Berücksichtige besonders den neuesten Eintrag in der Historie.
- Erfinde keine Fakten, Fristen, Gesetze, Antworten oder Dokumente.
- Wenn Informationen fehlen, kann der beste nächste Schritt eine gezielte Rückfrage sein.
- Wenn nachweislich auf eine angekündigte Antwort gewartet wird, kann bewusstes Warten mit einem sinnvollen Kontrollzeitpunkt besser sein als sofort eine E-Mail zu schreiben.
- Wenn eine E-Mail, ein Brief oder Telefonat sinnvoll ist, darfst du dies vorschlagen, aber NICHT behaupten, dass es bereits ausgeführt wurde.
- Formuliere konkret und nutzerverständlich auf Deutsch.
- Gib genau EINEN aktuell besten nächsten Schritt aus.
- Die Analyse soll kurz sein (2-4 Sätze), der nächste Schritt konkret (1-3 Sätze).

Antworte ausschließlich als gültiges JSON ohne Markdown in diesem Format:
{"analysis":"...","nextStep":"...","actionType":"wait|email|letter|call|request_info|document_check|other","reason":"..."}`;

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
        input: [
          { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
          { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(caseData) }] }
        ],
        max_output_tokens: 1000
      })
    });

    const raw = await response.json();
    if (!response.ok) {
      console.error('openai response error', raw);
      return res.status(502).json({ error: 'openai_request_failed', message: 'Die KI konnte die Anfrage nicht verarbeiten.' });
    }

    let text = '';
    if (typeof raw.output_text === 'string') text = raw.output_text;
    if (!text && Array.isArray(raw.output)) {
      for (const item of raw.output) {
        if (!item || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (part && part.type === 'output_text' && typeof part.text === 'string') text += part.text;
        }
      }
    }

    text = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('AI JSON parse error', text);
      return res.status(502).json({ error: 'invalid_ai_response', message: 'Die KI-Antwort konnte nicht gelesen werden.' });
    }

    return res.status(200).json({
      analysis: cleanText(parsed.analysis, 3000),
      nextStep: cleanText(parsed.nextStep, 3000),
      actionType: cleanText(parsed.actionType, 80) || 'other',
      reason: cleanText(parsed.reason, 2000)
    });
  } catch (error) {
    console.error('ai-case error', error);
    return res.status(500).json({ error: 'ai_server_error', message: 'Die KI-Verbindung ist momentan nicht verfügbar.' });
  }
};
