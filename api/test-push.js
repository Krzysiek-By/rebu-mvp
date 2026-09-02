const webpush = require('web-push');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    return res.status(500).json({ error: 'missing_vapid_env' });
  }

  const subscription = req.body && req.body.subscription;
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'invalid_subscription' });
  }

  webpush.setVapidDetails(
    'https://sekretarz-app.vercel.app',
    publicKey,
    privateKey
  );

  const payload = JSON.stringify({
    title: 'Sekretarz',
    body: 'Web-Push-Test – Nachricht kam vom Server.',
    tag: 'sekretarz-web-push-test',
    url: '/'
  });

  try {
    await webpush.sendNotification(subscription, payload);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('web-push error', error);
    return res.status(500).json({ error: 'send_failed' });
  }
};
