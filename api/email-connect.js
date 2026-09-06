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

function decryptPassword(row){
  const decipher=crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(String(row.encryption_iv||''),'base64')
  );
  decipher.setAuthTag(Buffer.from(String(row.encryption_tag||''),'base64'));
  const decrypted=Buffer.concat([
    decipher.update(Buffer.from(String(row.encrypted_password||''),'base64')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

async function getStoredGmxAccount(userId){
  const fields='email,status,encrypted_password,encryption_iv,encryption_tag,updated_at';
  const r=await supabaseService('/rest/v1/secretary_email_accounts?user_id=eq.'+encodeURIComponent(userId)+'&provider=eq.gmx&status=eq.connected&select='+fields+'&order=updated_at.desc&limit=1');
  const rows=await r.json().catch(()=>[]);
  if(!r.ok) throw new Error('SUPABASE_'+r.status);
  return Array.isArray(rows)?rows[0]:null;
}

async function loadGmxFolders(email, appPassword){
  let imap;
  try{
    imap=new ImapFlow({
      host:'imap.gmx.net', port:993, secure:true,
      auth:{user:email,pass:appPassword}, logger:false,
      connectionTimeout:10000, greetingTimeout:10000, socketTimeout:15000,
      tls:{minVersion:'TLSv1.2'}
    });
    await imap.connect();
    const list=await imap.list();
    await imap.logout();
    return (Array.isArray(list)?list:[]).map(box=>({
      path:String(box?.path||box?.name||''),
      name:String(box?.name||box?.path||''),
      delimiter:String(box?.delimiter||'/'),
      specialUse:String(box?.specialUse||'')
    })).filter(x=>x.path);
  }catch(err){
    try{ if(imap?.usable) await imap.logout(); }catch(_){ }
    throw err;
  }
}


async function loadGmxMessages(email, appPassword, folderPath, limit=10){
  let imap;
  try{
    imap=new ImapFlow({
      host:'imap.gmx.net', port:993, secure:true,
      auth:{user:email,pass:appPassword}, logger:false,
      connectionTimeout:10000, greetingTimeout:10000, socketTimeout:20000,
      tls:{minVersion:'TLSv1.2'}
    });
    await imap.connect();
    const lock=await imap.getMailboxLock(folderPath);
    try{
      const total=Number(imap.mailbox?.exists||0);
      if(!total) return [];
      const count=Math.max(1,Math.min(Number(limit)||10,20));
      const start=Math.max(1,total-count+1);
      const rows=[];
      for await (const msg of imap.fetch(start+':'+total,{uid:true,envelope:true,internalDate:true,flags:true})){
        const env=msg.envelope||{};
        const fromArr=Array.isArray(env.from)?env.from:[];
        const from=fromArr.map(x=>{
          const name=String(x?.name||'').trim();
          const addr=[x?.mailbox,x?.host].filter(Boolean).join('@');
          return name && addr ? name+' <'+addr+'>' : (addr||name);
        }).filter(Boolean).join(', ');
        const dt=msg.internalDate||env.date||null;
        rows.push({
          uid:Number(msg.uid||0),
          subject:String(env.subject||''),
          from,
          date:dt ? new Date(dt).toISOString() : '',
          dateLabel:dt ? new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Berlin'}).format(new Date(dt)) : '',
          seen:!!(msg.flags && typeof msg.flags.has==='function' && msg.flags.has('\\Seen'))
        });
      }
      return rows.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
    }finally{
      lock.release();
      await imap.logout();
    }
  }catch(err){
    try{ if(imap?.usable) await imap.logout(); }catch(_){ }
    throw err;
  }
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
      const r=await supabaseService('/rest/v1/secretary_email_accounts?user_id=eq.'+encodeURIComponent(user.id)+'&provider=eq.gmx&status=eq.connected&select=email,status,updated_at&order=updated_at.desc&limit=1');
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

  if(action==='folders'){
    try{
      const user=await verifyUser(req);
      if(!user?.id) return res.status(401).json({ok:false,message:'Sitzung ist nicht gültig. Bitte melde dich erneut an.'});
      const account=await getStoredGmxAccount(user.id);
      if(!account) return res.status(404).json({ok:false,message:'Es ist noch kein dauerhaft verbundenes GMX-Konto vorhanden.'});
      const password=decryptPassword(account);
      const folders=await loadGmxFolders(account.email,password);
      return res.status(200).json({ok:true,email:account.email,folders,version:'13.60'});
    }catch(err){
      return res.status(502).json({ok:false,message:'Die GMX-Ordner konnten nicht geladen werden.',code:safeCode(err)});
    }
  }


  if(action==='messages'){
    try{
      const user=await verifyUser(req);
      if(!user?.id) return res.status(401).json({ok:false,message:'Sitzung ist nicht gültig. Bitte melde dich erneut an.'});
      const folder=String(req.body?.folder||'').trim();
      if(!folder) return res.status(400).json({ok:false,message:'Kein Ordner ausgewählt.'});
      const account=await getStoredGmxAccount(user.id);
      if(!account) return res.status(404).json({ok:false,message:'Es ist noch kein dauerhaft verbundenes GMX-Konto vorhanden.'});
      const password=decryptPassword(account);
      const messages=await loadGmxMessages(account.email,password,folder,req.body?.limit||10);
      return res.status(200).json({ok:true,email:account.email,folder,messages,version:'13.60'});
    }catch(err){
      return res.status(502).json({ok:false,message:'Die Nachrichten aus diesem GMX-Ordner konnten nicht geladen werden.',code:safeCode(err)});
    }
  }

  const email=String(req.body?.email||'').trim().toLowerCase();
  const appPassword=String(req.body?.appPassword||'');
  if(!email || !/^[^\s@]+@gmx\.(de|net|com)$/i.test(email) || !appPassword){
    return res.status(400).json({ok:false,stage:'input',message:'E-Mail-Adresse oder Anwendungspasswort fehlt.'});
  }

  const checked=await checkGmx(email,appPassword);
  if(!checked.ok) return res.status(checked.status||502).json(checked);

  if(action!=='connect'){
    return res.status(200).json({ok:true,imap:true,smtp:true,version:'13.60'});
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
    return res.status(200).json({ok:true,connected:true,email,imap:true,smtp:true,version:'13.60'});
  }catch(err){
    return res.status(500).json({ok:false,message:'Die sichere E-Mail-Verbindung konnte nicht gespeichert werden.',code:safeCode(err)});
  }
};
