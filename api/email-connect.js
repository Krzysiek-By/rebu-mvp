const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const dns = require('dns').promises;
const crypto = require('crypto');

const SUPABASE_URL='https://luhkjdkqzauhgljnvvzo.supabase.co';

function safeCode(err) {
  return String(err?.code || err?.responseCode || err?.name || 'UNKNOWN').slice(0, 80);
}

function jsonHeaders(extra={}){
  return { 'Content-Type':'application/json', ...extra };
}

async function verifyUser(req){
  const auth=String(req.headers.authorization||'');
  if(!auth.startsWith('Bearer ')) return null;
  const secret=process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!secret) throw new Error('SUPABASE_SECRET_KEY fehlt.');
  const r=await fetch(SUPABASE_URL+'/auth/v1/user',{
    headers:{ 'apikey':secret, 'Authorization':auth }
  });
  if(!r.ok) return null;
  return await r.json();
}

function encryptionKey(){
  const raw=String(process.env.EMAIL_ENCRYPTION_KEY||'').trim();
  if(!/^[0-9a-f]{64}$/i.test(raw)) throw new Error('EMAIL_ENCRYPTION_KEY ist ungültig.');
  return Buffer.from(raw,'hex');
}

function encryptPassword(value){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return {
    encrypted_password:encrypted.toString('base64'),
    encryption_iv:iv.toString('base64'),
    encryption_tag:tag.toString('base64')
  };
}

async function supabaseService(path, options={}){
  const secret=process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!secret) throw new Error('SUPABASE_SECRET_KEY fehlt.');
  return fetch(SUPABASE_URL+path,{
    ...options,
    headers:{
      'apikey':secret,
      'Authorization':'Bearer '+secret,
      'Content-Type':'application/json',
      ...(options.headers||{})
    }
  });
}

async function checkGmx(email, appPassword){
  try {
    await Promise.all([dns.lookup('imap.gmx.net'),dns.lookup('mail.gmx.net')]);
  } catch (err) {
    return {ok:false,status:502,stage:'dns',code:safeCode(err),message:'Der Sekretarz-Server kann die GMX-Server derzeit nicht auflösen.'};
  }

  let imap;
  try {
    imap = new ImapFlow({
      host:'imap.gmx.net', port:993, secure:true,
      auth:{user:email,pass:appPassword}, logger:false,
      connectionTimeout:10000, greetingTimeout:10000, socketTimeout:12000,
      tls:{minVersion:'TLSv1.2'}
    });
    await imap.connect();
    await imap.logout();
  } catch (err) {
    try { if (imap?.usable) await imap.logout(); } catch (_) {}
    return {ok:false,status:502,stage:'imap',code:safeCode(err),message:'IMAP-Verbindung fehlgeschlagen. Bitte prüfe GMX-Zugriff und Anwendungspasswort.'};
  }

  try {
    const smtp=nodemailer.createTransport({
      host:'mail.gmx.net', port:587, secure:false, requireTLS:true,
      auth:{user:email,pass:appPassword},
      connectionTimeout:10000, greetingTimeout:10000, socketTimeout:12000,
      tls:{minVersion:'TLSv1.2'}
    });
    await smtp.verify();
  } catch (err) {
    return {ok:false,status:502,stage:'smtp',code:safeCode(err),message:'IMAP funktioniert, aber SMTP konnte nicht bestätigt werden.'};
  }

  return {ok:true,imap:true,smtp:true};
}

module.exports = async function handler(req,res){
  if(req.method==='GET'){
    try{
      const user=await verifyUser(req);
      if(!user?.id) return res.status(401).json({ok:false,message:'Sitzung ist nicht gültig.'});
      const r=await supabaseService('/rest/v1/secretary_email_accounts?user_id=eq.'+encodeURIComponent(user.id)+'&provider=eq.gmx&status=eq.connected&select=email,status,updated_at&limit=1');
      const rows=await r.json().catch(()=>[]);
      if(!r.ok) return res.status(502).json({ok:false,message:'E-Mail-Verbindungsstatus konnte nicht geladen werden.'});
      const row=Array.isArray(rows)?rows[0]:null;
      return res.status(200).json({ok:true,connected:!!row,email:row?.email||'',status:row?.status||''});
    }catch(err){
      return res.status(500).json({ok:false,message:'E-Mail-Verbindungsstatus konnte nicht geladen werden.',code:safeCode(err)});
    }
  }

  if(req.method!=='POST'){
    res.setHeader('Allow','GET, POST');
    return res.status(405).json({ok:false,message:'Methode nicht erlaubt.'});
  }

  const action=String(req.body?.action||'test');
  const email=String(req.body?.email||'').trim().toLowerCase();
  const appPassword=String(req.body?.appPassword||'');
  if(!email || !/^[^\s@]+@gmx\.(de|net|com)$/i.test(email) || !appPassword){
    return res.status(400).json({ok:false,stage:'input',message:'E-Mail-Adresse oder Anwendungspasswort fehlt.'});
  }

  const checked=await checkGmx(email,appPassword);
  if(!checked.ok) return res.status(checked.status||502).json(checked);

  if(action!=='connect'){
    return res.status(200).json({ok:true,imap:true,smtp:true,version:'13.56'});
  }

  try{
    const user=await verifyUser(req);
    if(!user?.id) return res.status(401).json({ok:false,message:'Sitzung ist nicht gültig. Bitte melde dich erneut an.'});
    const enc=encryptPassword(appPassword);
    const payload={
      user_id:user.id,
      provider:'gmx',
      email,
      ...enc,
      status:'connected',
      updated_at:new Date().toISOString()
    };
    const r=await supabaseService('/rest/v1/secretary_email_accounts?on_conflict=user_id,provider,email',{
      method:'POST',
      headers:{'Prefer':'resolution=merge-duplicates,return=representation'},
      body:JSON.stringify(payload)
    });
    const data=await r.json().catch(()=>[]);
    if(!r.ok){
      return res.status(502).json({ok:false,message:'Die verschlüsselte E-Mail-Verbindung konnte nicht gespeichert werden.',code:'SUPABASE_'+r.status});
    }
    return res.status(200).json({ok:true,connected:true,email,imap:true,smtp:true,version:'13.56'});
  }catch(err){
    return res.status(500).json({ok:false,message:'Die sichere E-Mail-Verbindung konnte nicht gespeichert werden.',code:safeCode(err)});
  }
};
