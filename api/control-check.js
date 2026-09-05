const webpush = require('web-push');

const SUPABASE_URL = 'https://luhkjdkqzauhgljnvvzo.supabase.co';

function berlinTodayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

async function supabaseFetch(path, options = {}) {
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey) throw new Error('missing_supabase_secret_key');

  return fetch(SUPABASE_URL + path, {
    ...options,
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

async function readJsonOrThrow(response, label) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) {}
  if (!response.ok) {
    const detail = data?.message || data?.error || text || response.statusText;
    throw new Error(`${label}_${response.status}: ${detail}`);
  }
  return data;
}

async function disableDeadSubscription(id) {
  try {
    await supabaseFetch(`/rest/v1/secretary_push_subscriptions?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ enabled: false, updated_at: new Date().toISOString() })
    });
  } catch (e) {
    console.error('disable subscription failed', e);
  }
}

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(500).json({ error: 'missing_cron_secret' });
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) {
    return res.status(500).json({ error: 'missing_vapid_env' });
  }

  try {
    webpush.setVapidDetails(
      'https://sekretarz-app.vercel.app',
      vapidPublic,
      vapidPrivate
    );

    const today = berlinTodayISO();
    const dueResponse = await supabaseFetch(
      `/rest/v1/secretary_control_points?select=id,user_id,case_id,case_title,control_date&resolved_at=is.null&notified_at=is.null&control_date=lt.${today}&order=control_date.asc`,
      { method: 'GET' }
    );
    const due = await readJsonOrThrow(dueResponse, 'control_points_read_failed') || [];

    const summary = {
      ok: true,
      today,
      due: due.length,
      sent: 0,
      withoutSubscription: 0,
      failed: 0,
      processed: []
    };

    for (const point of due) {
      const subResponse = await supabaseFetch(
        `/rest/v1/secretary_push_subscriptions?select=id,subscription&user_id=eq.${encodeURIComponent(point.user_id)}&enabled=eq.true`,
        { method: 'GET' }
      );
      const subscriptions = await readJsonOrThrow(subResponse, 'subscriptions_read_failed') || [];

      if (!subscriptions.length) {
        summary.withoutSubscription += 1;
        summary.processed.push({ case_id: point.case_id, status: 'no_subscription' });
        continue;
      }

      let delivered = 0;
      for (const row of subscriptions) {
        try {
          const payload = JSON.stringify({
            notification: {
              title: 'Sekretarz – Kontrolltermin',
              lang: 'de-DE',
              dir: 'ltr',
              body: `${point.case_title || 'Angelegenheit'}: Der Kontrolltermin ist abgelaufen. Ist die erwartete Antwort inzwischen eingegangen?`,
              navigate: 'https://sekretarz-app.vercel.app/',
              silent: false
            },
            tag: `sekretarz-control-${point.case_id}`
          });

          await webpush.sendNotification(row.subscription, payload);
          delivered += 1;
          summary.sent += 1;
        } catch (e) {
          const status = Number(e?.statusCode || 0);
          if (status === 404 || status === 410) await disableDeadSubscription(row.id);
          summary.failed += 1;
          console.error('control push failed', point.case_id, status, e?.message || e);
        }
      }

      if (delivered > 0) {
        const updateResponse = await supabaseFetch(
          `/rest/v1/secretary_control_points?id=eq.${encodeURIComponent(point.id)}`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ notified_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          }
        );
        await readJsonOrThrow(updateResponse, 'control_point_update_failed');
        summary.processed.push({ case_id: point.case_id, status: 'notified', devices: delivered });
      } else {
        summary.processed.push({ case_id: point.case_id, status: 'delivery_failed' });
      }
    }

    return res.status(200).json(summary);
  } catch (e) {
    console.error('control-check error', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
};
