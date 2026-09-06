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

    const listed=await imap.list();
    const box=(Array.isArray(listed)?listed:[]).find(x=>String(x?.path||x?.name||'')===String(folderPath));
    if(!box){
      const err=new Error('MAILBOX_NOT_FOUND');
      err.code='MAILBOX_NOT_FOUND';
      throw err;
    }
    const flags=box?.flags;
    const noSelect = !!(flags && (
      (typeof flags.has==='function' && flags.has('\\Noselect')) ||
      (Array.isArray(flags) && flags.includes('\\Noselect'))
    ));
    if(noSelect){
      await imap.logout();
      return [];
    }

    // Zuerst nur den Status abfragen. Das ist für leere Ordner robuster als
    // direkt SELECT/EXAMINE zu senden und reicht aus, um sicher festzustellen,
    // dass wirklich keine Nachrichten vorhanden sind.
    let total=0;
    try{
      const st=await imap.status(String(box.path||folderPath),{messages:true});
      total=Number(st?.messages||0);
    }catch(statusErr){
      // Falls GMX STATUS für diesen Ordner nicht liefert, verwenden wir den
      // normalen Read-only-Open als Fallback.
      await imap.mailboxOpen(String(box.path||folderPath),{readOnly:true});
      total=Number(imap.mailbox?.exists||0);
    }

    if(!total){
      await imap.logout();
      return [];
    }

    // Nur nicht-leere Ordner müssen tatsächlich geöffnet werden.
    if(!imap.mailbox || String(imap.mailbox.path||'') !== String(box.path||folderPath)) {
      await imap.mailboxOpen(String(box.path||folderPath),{readOnly:true});
    }

    const count=Math.max(1,Math.min(Number(limit)||10,50));
    const first=Math.max(1,total-count+1);
    const rows=[];

    function decodeHeaderWord(v){
      const value=String(v||'').trim();
      return value.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi,(_,b)=>{
        try{return Buffer.from(b,'base64').toString('utf8')}catch{return _}
      }).replace(/=\?UTF-8\?Q\?([^?]+)\?=/gi,(_,q)=>{
        try{return q.replace(/_/g,' ').replace(/=([0-9A-F]{2})/gi,(m,h)=>String.fromCharCode(parseInt(h,16)))}catch{return _}
      });
    }

    function headerFromSource(source){
      const raw=Buffer.isBuffer(source)?source.toString('utf8'):String(source||'');
      const head=raw.split(/\r?\n\r?\n/,1)[0]||'';
      const unfolded=head.replace(/\r?\n[ \t]+/g,' ');
      const get=(name)=>{
        const m=unfolded.match(new RegExp('^'+name+':\\s*(.*)$','im'));
        return m?decodeHeaderWord(m[1]):'';
      };
      return { subject:get('Subject'), from:get('From'), date:get('Date') };
    }

    // Einzelne Nachrichten laden: eine fehlerhafte/ungewöhnliche Mail darf nicht
    // den kompletten Ordner unlesbar machen.
    for(let seq=total; seq>=first; seq--){
      try{
        let msg;
        try{
          msg=await imap.fetchOne(seq,{uid:true,envelope:true,internalDate:true,flags:true});
        }catch(primaryErr){
          const fallback=await imap.fetchOne(seq,{uid:true,source:true,internalDate:true,flags:true});
          const h=headerFromSource(fallback?.source);
          const d=fallback?.internalDate || (h.date ? new Date(h.date) : null);
          rows.push({
            uid:Number(fallback?.uid||0),
            subject:String(h.subject||'(Ohne Betreff)'),
            from:String(h.from||''),
            date:d && !Number.isNaN(new Date(d).getTime()) ? new Date(d).toISOString() : '',
            dateLabel:d && !Number.isNaN(new Date(d).getTime()) ? new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Berlin'}).format(new Date(d)) : '',
            seen:!!(fallback?.flags && typeof fallback.flags.has==='function' && fallback.flags.has('\\Seen'))
          });
          continue;
        }

        const env=msg?.envelope||{};
        const fromArr=Array.isArray(env.from)?env.from:[];
        const from=fromArr.map(x=>{
          const name=String(x?.name||'').trim();
          const addr=[x?.mailbox,x?.host].filter(Boolean).join('@');
          return name && addr ? name+' <'+addr+'>' : (addr||name);
        }).filter(Boolean).join(', ');
        const dt=msg?.internalDate||env.date||null;
        rows.push({
          uid:Number(msg?.uid||0),
          subject:String(env.subject||'(Ohne Betreff)'),
          from,
          date:dt ? new Date(dt).toISOString() : '',
          dateLabel:dt ? new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Berlin'}).format(new Date(dt)) : '',
          seen:!!(msg?.flags && typeof msg.flags.has==='function' && msg.flags.has('\\Seen'))
        });
      }catch(itemErr){
        // Überspringen statt den ganzen Ordner scheitern zu lassen.
        rows.push({uid:0,subject:'(Nachricht konnte nicht vollständig gelesen werden)',from:'',date:'',dateLabel:'',seen:false,readError:safeCode(itemErr)});
      }
    }

    await imap.logout();
    return rows.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  }catch(err){
    try{ if(imap?.usable) await imap.logout(); }catch(_){ }
    throw err;
  }
}


function decodeMimeHeader(value){
  let v=String(value||'');
  return v.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,(_,charset,enc,data)=>{
    try{
      if(String(enc).toLowerCase()==='b') return Buffer.from(data,'base64').toString('utf8');
      const bytes=String(data).replace(/_/g,' ').replace(/=([0-9A-F]{2})/gi,(m,h)=>String.fromCharCode(parseInt(h,16)));
      return Buffer.from(bytes,'binary').toString('utf8');
    }catch{return _}
  });
}

function parseHeaderBlock(raw){
  const head=String(raw||'').replace(/\r?\n[ \t]+/g,' ');
  const out={};
  for(const line of head.split(/\r?\n/)){
    const i=line.indexOf(':');
    if(i<1) continue;
    const k=line.slice(0,i).trim().toLowerCase();
    const v=line.slice(i+1).trim();
    out[k]=out[k] ? out[k]+', '+v : v;
  }
  return out;
}

function decodeQuotedPrintable(body){
  const soft=String(body||'').replace(/=\r?\n/g,'');
  const bin=soft.replace(/=([0-9A-F]{2})/gi,(m,h)=>String.fromCharCode(parseInt(h,16)));
  try{return Buffer.from(bin,'binary').toString('utf8')}catch{return bin}
}

function stripHtml(html){
  return String(html||'')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<br\s*\/?\s*>/gi,'\n')
    .replace(/<\/p>/gi,'\n\n')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&lt;/gi,'<')
    .replace(/&gt;/gi,'>')
    .replace(/&quot;/gi,'"')
    .replace(/&#39;/gi,"'")
    .replace(/[ \t]+\n/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}

function decodePartBody(body, encoding){
  const enc=String(encoding||'').toLowerCase();
  try{
    if(enc==='base64') return Buffer.from(String(body||'').replace(/\s+/g,''),'base64').toString('utf8');
    if(enc==='quoted-printable') return decodeQuotedPrintable(body);
  }catch(_){ }
  return String(body||'');
}

function parseMimeMessage(source){
  const raw=Buffer.isBuffer(source)?source.toString('utf8'):String(source||'');
  const split=raw.search(/\r?\n\r?\n/);
  const headRaw=split>=0?raw.slice(0,split):raw;
  const bodyRaw=split>=0?raw.slice(split).replace(/^\r?\n\r?\n/,''):'';
  const h=parseHeaderBlock(headRaw);
  const ct=String(h['content-type']||'text/plain');
  const boundaryMatch=ct.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  const attachments=[];
  let plain=''; let html='';

  if(boundaryMatch){
    const boundary=boundaryMatch[1]||boundaryMatch[2];
    const marker='--'+boundary;
    const parts=bodyRaw.split(marker).slice(1);
    for(let part of parts){
      if(/^--/.test(part.trim())) continue;
      part=part.replace(/^\r?\n/,'');
      const pi=part.search(/\r?\n\r?\n/);
      if(pi<0) continue;
      const ph=parseHeaderBlock(part.slice(0,pi));
      const pb=part.slice(pi).replace(/^\r?\n\r?\n/,'').replace(/\r?\n$/,'');
      const pct=String(ph['content-type']||'text/plain');
      const disp=String(ph['content-disposition']||'');
      const fnm=(disp.match(/filename\s*=\s*(?:"([^"]+)"|([^;\s]+))/i)||pct.match(/name\s*=\s*(?:"([^"]+)"|([^;\s]+))/i));
      const filename=fnm?decodeMimeHeader(fnm[1]||fnm[2]||'Anhang'):'';
      const enc=ph['content-transfer-encoding']||'';
      if(/attachment/i.test(disp) || filename){
        let size=0;
        if(String(enc).toLowerCase()==='base64') size=Math.floor(String(pb).replace(/\s+/g,'').length*0.75);
        else size=Buffer.byteLength(String(pb),'utf8');
        attachments.push({filename:filename||'Anhang',contentType:pct.split(';')[0].trim(),size});
        continue;
      }
      const decoded=decodePartBody(pb,enc);
      if(/^text\/plain/i.test(pct) && !plain) plain=decoded.trim();
      else if(/^text\/html/i.test(pct) && !html) html=decoded.trim();
    }
  }else{
    const decoded=decodePartBody(bodyRaw,h['content-transfer-encoding']||'');
    if(/^text\/html/i.test(ct)) html=decoded.trim(); else plain=decoded.trim();
  }

  return {
    subject:decodeMimeHeader(h.subject||'(Kein Betreff)'),
    from:decodeMimeHeader(h.from||''),
    to:decodeMimeHeader(h.to||''),
    cc:decodeMimeHeader(h.cc||''),
    date:h.date||'',
    text:(plain||stripHtml(html)||'').trim(),
    attachments
  };
}

async function loadGmxMessage(email, appPassword, folderPath, uid){
  let imap;
  try{
    imap=new ImapFlow({
      host:'imap.gmx.net', port:993, secure:true,
      auth:{user:email,pass:appPassword}, logger:false,
      connectionTimeout:10000, greetingTimeout:10000, socketTimeout:25000,
      tls:{minVersion:'TLSv1.2'}
    });
    await imap.connect();
    await imap.mailboxOpen(String(folderPath),{readOnly:true});
    const messageUid=Number(uid||0);
    if(!Number.isFinite(messageUid) || messageUid<=0){ const e=new Error('MESSAGE_UID_INVALID'); e.code='MESSAGE_UID_INVALID'; throw e; }
    const msg=await imap.fetchOne(messageUid,{uid:true,source:true,internalDate:true},{uid:true});
    if(!msg?.source){ const e=new Error('MESSAGE_NOT_FOUND'); e.code='MESSAGE_NOT_FOUND'; throw e; }
    const parsed=parseMimeMessage(msg.source);
    const dt=parsed.date ? new Date(parsed.date) : (msg.internalDate ? new Date(msg.internalDate) : null);
    await imap.logout();
    return {
      uid:messageUid,
      subject:String(parsed.subject||'(Kein Betreff)'),
      from:String(parsed.from||''), to:String(parsed.to||''), cc:String(parsed.cc||''),
      date:dt && !Number.isNaN(dt.getTime()) ? dt.toISOString() : '',
      dateLabel:dt && !Number.isNaN(dt.getTime()) ? new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Berlin'}).format(dt) : '',
      text:String(parsed.text||''), attachments:parsed.attachments||[]
    };
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
      return res.status(200).json({ok:true,email:account.email,folders,version:'13.66'});
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
      return res.status(200).json({ok:true,email:account.email,folder,messages,version:'13.66'});
    }catch(err){
      return res.status(502).json({ok:false,message:'Die Nachrichten aus diesem GMX-Ordner konnten nicht geladen werden.',code:safeCode(err)});
    }
  }

  if(action==='message'){
    try{
      const user=await verifyUser(req);
      if(!user?.id) return res.status(401).json({ok:false,message:'Sitzung ist nicht gültig. Bitte melde dich erneut an.'});
      const folder=String(req.body?.folder||'').trim();
      const uid=Number(req.body?.uid||0);
      if(!folder || !Number.isFinite(uid) || uid<=0) return res.status(400).json({ok:false,message:'Nachricht oder Ordner fehlt.'});
      const account=await getStoredGmxAccount(user.id);
      if(!account) return res.status(404).json({ok:false,message:'Es ist noch kein dauerhaft verbundenes GMX-Konto vorhanden.'});
      const password=decryptPassword(account);
      const message=await loadGmxMessage(account.email,password,folder,uid);
      return res.status(200).json({ok:true,email:account.email,folder,message,version:'13.66'});
    }catch(err){
      return res.status(502).json({ok:false,message:'Die E-Mail konnte nicht vollständig geladen werden.',code:safeCode(err)});
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
    return res.status(200).json({ok:true,imap:true,smtp:true,version:'13.66'});
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
    return res.status(200).json({ok:true,connected:true,email,imap:true,smtp:true,version:'13.66'});
  }catch(err){
    return res.status(500).json({ok:false,message:'Die sichere E-Mail-Verbindung konnte nicht gespeichert werden.',code:safeCode(err)});
  }
};
