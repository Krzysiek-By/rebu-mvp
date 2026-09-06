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
    allowedSources: source.sourceSettings || {},
    controlDate: cleanText(source.controlDate, 40),
    currentDate: new Date().toISOString().slice(0,10)
  };

  const systemPrompt = `Du bist der intelligente persönliche Sekretär in der App Sekretarz.
Analysiere ausschließlich die übergebenen Informationen dieser Angelegenheit.
Deine Aufgabe ist NICHT, eine starre Regel anzuwenden, sondern aus Ziel, aktuellem Stand, Kontakt und gesamter Historie den aktuell sinnvollsten nächsten Schritt abzuleiten.

Wichtige Regeln:
- Berücksichtige besonders den neuesten Eintrag in der Historie.
- Erfinde keine Fakten, Fristen, Gesetze, Antworten oder Dokumente.
- Wenn Informationen fehlen, kann der beste nächste Schritt eine gezielte Rückfrage sein.
- Wenn nachweislich auf eine angekündigte Antwort gewartet wird, darf actionType "wait" gewählt werden.
- Bei actionType "wait" darfst du NIEMALS eine Frist oder ein Datum erfinden.
- Prüfe aber, ob die übergebenen Informationen selbst eine eindeutige zeitliche Zusage enthalten, z. B. „innerhalb der nächsten 10 Tage“, „bis 20.09.2026“ oder „in zwei Wochen“. Wenn ja, berechne daraus einen konkreten proposedControlDate im Format YYYY-MM-DD. Verwende als Ausgangsdatum das Datum des betreffenden Historieneintrags bzw. der Nachricht, nicht pauschal das heutige Datum.
- proposedControlDate darf NUR gesetzt werden, wenn die Frist eindeutig aus den übergebenen Informationen hervorgeht. Wenn keine eindeutige Frist vorliegt, muss proposedControlDate ein leerer String sein; dann fragt die App den Nutzer nach einem Kontrolltermin.
- Gib in controlDateBasis kurz an, welche konkrete Angabe aus der Quelle die Berechnung begründet, ohne etwas hinzuzuerfinden.
- Wenn bereits ein konkretes controlDate vorhanden ist und noch nicht überschritten wurde, berücksichtige dieses Datum als verbindlichen Kontrollpunkt und setze proposedControlDate leer.
- Wenn eine E-Mail, ein Brief oder Telefonat sinnvoll ist, darfst du dies vorschlagen, aber NICHT behaupten, dass es bereits ausgeführt wurde.
- Wenn actionType "email" ist, erstelle zusätzlich einen sofort nutzbaren deutschen E-Mail-Entwurf: einen kurzen Betreff und eine vollständige, sachliche E-Mail. Nutze nur bekannte Fakten. Keine erfundenen Namen, Fristen oder Zusagen.
- VERBINDLICHE ANREDE-REGEL FÜR E-MAILS: Prüfe zuerst Empfänger und Beziehung. Wenn der Empfänger eine Firma, Behörde, Versicherung, Vermieter/Hausverwaltung oder ein vergleichbarer institutioneller/formeller Kontakt ist UND keine konkrete Ansprechperson bekannt ist, MUSS die E-Mail exakt mit „Sehr geehrte Damen und Herren,“ beginnen. In diesem Fall sind „Guten Tag,“ und „Hallo“ NICHT zulässig. Wenn bei einem formellen Kontakt eine konkrete Person bekannt ist, MUSS eine passende persönliche formelle Anrede verwendet werden, z. B. „Sehr geehrte Frau …,“ oder „Sehr geehrter Herr …,“. Nur bei privaten, freundschaftlichen oder erkennbar lockeren Kontakten darf eine informellere Anrede wie „Hallo …“ oder „Guten Tag …“ verwendet werden.
- Wenn actionType nicht "email" ist, müssen emailSubject und emailBody leere Strings sein.
- Formuliere konkret und nutzerverständlich auf Deutsch.
- Gib genau EINEN aktuell besten nächsten Schritt aus.
- Die Analyse soll kurz sein (2-4 Sätze), der nächste Schritt konkret (1-3 Sätze).

Antworte ausschließlich als gültiges JSON ohne Markdown in diesem Format:
{"analysis":"...","nextStep":"...","actionType":"wait|email|letter|call|request_info|document_check|other","reason":"...","emailSubject":"...","emailBody":"...","proposedControlDate":"YYYY-MM-DD oder leer","controlDateBasis":"... oder leer"}`;

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
      reason: cleanText(parsed.reason, 2000),
      emailSubject: cleanText(parsed.emailSubject, 500),
      emailBody: cleanText(parsed.emailBody, 6000),
      proposedControlDate: cleanText(parsed.proposedControlDate, 40),
      controlDateBasis: cleanText(parsed.controlDateBasis, 1000)
    });
  } catch (error) {
    console.error('ai-case error', error);
    return res.status(500).json({ error: 'ai_server_error', message: 'Die KI-Verbindung ist momentan nicht verfügbar.' });
  }
};
