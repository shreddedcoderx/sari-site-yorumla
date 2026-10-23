import {makeSeo} from './seo.mjs';
import {reviewFlags} from './moderation.mjs';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt as rawScrypt, timingSafeEqual, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const scrypt=promisify(rawScrypt), root=dirname(fileURLToPath(import.meta.url));
const production=process.env.NODE_ENV==='production';
const legalVersion='2026-10-23';
const origin=process.env.APP_URL ? new URL(process.env.APP_URL).origin : null;
if(production && (!origin || !origin.startsWith('https://') || process.env.DEMO_DATA==='true')) throw new Error('Production requires HTTPS APP_URL and DEMO_DATA=false.');
mkdirSync(process.env.DATA_DIR || resolve(root,'data'),{recursive:true});
const db=new DatabaseSync(resolve(process.env.DATA_DIR || resolve(root,'data'),'dobra.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS vehicles(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,brand TEXT NOT NULL,model TEXT NOT NULL,year INTEGER NOT NULL,km INTEGER NOT NULL,city TEXT NOT NULL,category TEXT NOT NULL,fuel TEXT NOT NULL,gear TEXT NOT NULL,source TEXT UNIQUE,description TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',demo INTEGER DEFAULT 0,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,vehicle_id TEXT NOT NULL REFERENCES vehicles(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prices(id TEXT PRIMARY KEY,vehicle_id TEXT NOT NULL REFERENCES vehicles(id),user_id TEXT NOT NULL REFERENCES users(id),amount INTEGER NOT NULL,observed TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS follows(user_id TEXT REFERENCES users(id),vehicle_id TEXT REFERENCES vehicles(id),PRIMARY KEY(user_id,vehicle_id));
CREATE TABLE IF NOT EXISTS votes(user_id TEXT REFERENCES users(id),comment_id TEXT REFERENCES comments(id),PRIMARY KEY(user_id,comment_id));
CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,comment_id TEXT REFERENCES comments(id),user_id TEXT REFERENCES users(id),reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created TEXT NOT NULL,UNIQUE(comment_id,user_id));
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,admin_id TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,action TEXT NOT NULL,created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS comment_vehicle ON comments(vehicle_id,status);
CREATE INDEX IF NOT EXISTS price_vehicle ON prices(vehicle_id,status);
CREATE INDEX IF NOT EXISTS vehicle_public_order ON vehicles(status,created DESC);
CREATE INDEX IF NOT EXISTS comment_public_order ON comments(vehicle_id,status,created DESC);
CREATE INDEX IF NOT EXISTS price_public_order ON prices(vehicle_id,status,observed DESC,created DESC);
CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);`);
const q=(sql,...args)=>db.prepare(sql).all(...args), one=(sql,...args)=>db.prepare(sql).get(...args), run=(sql,...args)=>db.prepare(sql).run(...args);
const now=()=>new Date().toISOString(), hash=v=>createHash('sha256').update(v).digest('hex');
if(!q('PRAGMA table_info(users)').some(c=>c.name==='is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
if(!q('PRAGMA table_info(users)').some(c=>c.name==='is_suspended')) db.exec('ALTER TABLE users ADD COLUMN is_suspended INTEGER NOT NULL DEFAULT 0');
for(const [column,type] of [['terms_accepted_at','TEXT'],['terms_version','TEXT'],['rules_version','TEXT']]) if(!q('PRAGMA table_info(users)').some(c=>c.name===column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${type}`);
if(!q('PRAGMA table_info(comments)').some(c=>c.name==='review_flags')){db.exec("ALTER TABLE comments ADD COLUMN review_flags TEXT NOT NULL DEFAULT ''");for(const row of q('SELECT id,body FROM comments')){const flags=reviewFlags(row.body);if(flags.length)run('UPDATE comments SET review_flags=? WHERE id=?',flags.join(', '),row.id);}}
if(!q('PRAGMA table_info(vehicles)').some(c=>c.name==='listing_no')) db.exec('ALTER TABLE vehicles ADD COLUMN listing_no TEXT');
if(!q('PRAGMA table_info(vehicles)').some(c=>c.name==='owner_removed')) db.exec('ALTER TABLE vehicles ADD COLUMN owner_removed INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS vehicle_listing_no ON vehicles(listing_no) WHERE listing_no IS NOT NULL');
const admin=u=>u?.is_admin===1;
const safeUser=u=>u?{id:u.id,name:u.name,admin:admin(u)}:null;
class Err extends Error{constructor(status,message){super(message);this.status=status;}}
const fail=(s,m)=>{throw new Err(s,m);};
const text=(v,min,max,label)=>{if(typeof v!=='string'||v.trim().length<min||v.trim().length>max)fail(400,`${label}: ${min}–${max} karakter olmalı.`); return v.trim();};
const num=(v,min,max,label)=>{v=Number(v);if(!Number.isSafeInteger(v)||v<min||v>max)fail(400,`${label} geçersiz.`);return v;};
const pick=(v,choices)=>{if(!choices.includes(v))fail(400,'Geçersiz seçim.');return v;};
const categories=['Otomobil','Arazi, SUV & Pickup','Elektrikli Araç','Motosiklet','Minivan & Panelvan','Ticari Araç','Kiralık Araç','Deniz Aracı','Hasarlı Araç'];
const roles=['Eski sahibiyim','Şu anki sahibiyim','Aracı gördüm','Ekspertize götürdüm','İlanı takip ediyorum'];
function listingNumber(value){const raw=String(value||'').trim();const match=raw.match(/^\d{8,12}$/)||raw.match(/^https:\/\/(?:www\.)?sahibinden\.com\/ilan\/[^?#]*-(\d{8,12})(?:\/detay)?(?:[?#].*)?$/);if(!match)fail(400,'8–12 haneli ilan numarası veya geçerli ilan bağlantısı girin.');return match[1]||match[0];}
function sourceUrl(v){if(!v)return null;try{const u=new URL(v);if(u.protocol!=='https:'||!['www.sahibinden.com','sahibinden.com'].includes(u.hostname)||!u.pathname.startsWith('/ilan/')||u.username||u.password)throw 0;return `https://www.sahibinden.com${u.pathname.replace(/\/$/,'')}`;}catch{fail(400,'Sarı siteden geçerli bir HTTPS ilan bağlantısı girin.');}}
function session(req){const token=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('dobra_session='))?.slice(14);return token?one('SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.is_suspended=0',hash(token),Date.now()):null;}
const requireUser=req=>{const u=session(req);if(!u)fail(401,'Devam etmek için giriş yapın.');return u;};
const requireAdmin=req=>{const u=requireUser(req);if(!admin(u))fail(403,'Bu işlem için yönetici yetkisi gerekiyor.');return u;};
const streams=new Set();
function publish(kind,scope='public',vehicleId=null,userId=null){const message=`data: ${JSON.stringify({kind,vehicleId})}\n\n`;for(const client of streams){if(scope==='admin'&&!client.admin||scope==='user'&&client.userId!==userId)continue;if(!client.res.write(message)){client.res.end();streams.delete(client);}}}
setInterval(()=>{for(const client of streams)if(!client.res.write(': ping\n\n')){client.res.end();streams.delete(client);}},25000).unref();
function cookie(token,age=604800){return `dobra_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${production?'; Secure':''}`;}
const limits=new Map();
function limit(key,max,ms){const t=Date.now();let e=limits.get(key);if(!e||e.until<t){e={count:0,until:t+ms};limits.set(key,e);}if(++e.count>max)fail(429,'Çok fazla deneme yaptınız. Biraz sonra tekrar deneyin.');}
function clientIp(req){const peer=req.socket.remoteAddress||'unknown';if(process.env.TRUST_PROXY!=='true')return peer;const forwarded=req.headers['x-forwarded-for'];const candidate=typeof forwarded==='string'?forwarded.split(',').at(-1)?.trim():null;return candidate&&isIP(candidate)?candidate:peer;}
let activePasswordJobs=0;
async function passwordDigest(password,salt){if(activePasswordJobs>=8)fail(503,'Giriş sistemi şu an yoğun. Biraz sonra tekrar deneyin.');activePasswordJobs++;try{return await scrypt(password,salt,64);}finally{activePasswordJobs--;}}
setInterval(()=>{for(const [k,v] of limits)if(v.until<Date.now())limits.delete(k);run('DELETE FROM sessions WHERE expires<?',Date.now());},60000).unref();
async function body(req){if(!req.headers['content-type']?.startsWith('application/json'))fail(415,'JSON içerik gerekiyor.');let b='';for await(const c of req){b+=c;if(Buffer.byteLength(b)>24000)fail(413,'İçerik çok büyük.');}try{const value=JSON.parse(b);if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Geçersiz istek.');return value;}catch{fail(400,'Geçersiz istek.');}}
function vehicle(id,u){const v=one('SELECT * FROM vehicles WHERE id=?',id);if(!v||v.status==='removed'&&!admin(u)||!['approved','suspended'].includes(v.status)&&v.user_id!==u?.id&&!admin(u))fail(404,'Araç bulunamadı.');return v;}
function vehicles(u,requestUrl){const params=new URL(requestUrl,'http://localhost').searchParams;
const limitRows=num(params.get('limit')||24,1,48,'Sayfa boyutu'),offset=num(params.get('offset')||0,0,1000000,'Sayfa'),category=params.get('category')||'Tümü',sort=pick(params.get('sort')||'new',['new','comments','price']),query=(params.get('query')||'').trim(),following=params.get('following')==='1';
if(query.length>100)fail(400,'Arama çok uzun.');if(category!=='Tümü'&&!['Vasıta',...categories].includes(category))fail(400,'Geçersiz kategori.');if(following&&!u)fail(401,'Takip listesini görmek için giriş yapın.');
const clauses=["v.status IN ('approved','suspended')"],args=[];
if(category!=='Tümü'){clauses.push('v.category=?');args.push(category);}if(query){const term=`%${query.replace(/[\\%_]/g,'\\$&')}%`;clauses.push("v.listing_no LIKE ? ESCAPE '\\'");args.push(term);}if(following){clauses.push('EXISTS (SELECT 1 FROM follows f WHERE f.vehicle_id=v.id AND f.user_id=?)');args.push(u.id);}
const where=clauses.join(' AND '),count=one(`SELECT COUNT(*) total FROM vehicles v WHERE ${where}`,...args).total;
const order=sort==='comments'?'comment_count DESC, created DESC':sort==='price'?'CASE WHEN price IS NULL THEN 1 ELSE 0 END, price ASC, created DESC':'created DESC';
const rows=q(`SELECT * FROM (SELECT v.id,v.user_id,v.listing_no,v.category,v.status,v.demo,v.created, (SELECT COUNT(*) FROM comments c WHERE c.vehicle_id=v.id AND c.status='approved') comment_count,
(SELECT amount FROM prices p WHERE p.vehicle_id=v.id AND p.status='approved' ORDER BY observed DESC,created DESC LIMIT 1) price,
(SELECT COUNT(*) FROM follows f WHERE f.vehicle_id=v.id AND f.user_id=?) following
FROM vehicles v WHERE ${where}) ORDER BY ${order} LIMIT ? OFFSET ?`,u?.id||'',...args,limitRows,offset);
return {vehicles:rows,total:count,hasMore:offset+rows.length<count};}
async function api(req,res,path){const method=req.method,u=session(req),ip=clientIp(req);
if(method!=='GET'){const expected=origin||`http://${req.headers.host}`;if(req.headers.origin!==expected)fail(403,'İstek kaynağı doğrulanamadı.');limit(`write:${u?.id||ip}`,u?120:240,60000);}
const send=(data,status=200,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data));};
if(path==='/api/health'&&method==='GET'){one('SELECT 1');return send({ok:true});}
if(path==='/api/events'&&method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(': connected\n\n');const client={res,admin:admin(u),userId:u?.id||null};streams.add(client);req.on('close',()=>streams.delete(client));return;}
if(path==='/api/me'&&method==='GET')return send({user:safeUser(u),demo:process.env.DEMO_DATA==='true'});
if(path==='/api/meta'&&method==='GET')return send({categories,roles});
if(['/api/register','/api/login'].includes(path)&&method==='POST'){
const b=await body(req),email=text(b.email,5,254,'E-posta').toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Geçerli bir e-posta girin.');limit(`auth-email:${hash(email)}`,12,900000);const password=text(b.password,12,128,'Şifre');let user;
if(path==='/api/register'){
const name=text(b.name,2,40,'Görünen ad');if(b.acceptTerms!==true||b.acceptRules!==true)fail(400,'Kullanım koşullarını ve topluluk kurallarını kabul edin.');const salt=randomBytes(16).toString('hex'),digest=(await passwordDigest(password,salt)).toString('hex');
try{run('INSERT INTO users(id,email,name,password,created,terms_accepted_at,terms_version,rules_version) VALUES(?,?,?,?,?,?,?,?)',randomUUID(),email,name,`${salt}:${digest}`,now(),now(),legalVersion,legalVersion);}catch(e){if(e.code?.includes('CONSTRAINT')||e.message.includes('UNIQUE'))fail(409,'Bu e-posta ile kayıt yapılamıyor. Giriş yapmayı deneyin.');throw e;}user=one('SELECT * FROM users WHERE email=?',email);publish('users','admin');
}else{user=one('SELECT * FROM users WHERE email=?',email);const [salt,digest]=(user?.password||'00000000000000000000000000000000:'+ '0'.repeat(128)).split(':');const actual=await passwordDigest(password,salt);if(!timingSafeEqual(actual,Buffer.from(digest,'hex'))||!user)fail(401,'E-posta veya şifre hatalı.');if(user.is_suspended)fail(403,'Bu hesabın erişimi askıya alındı.');}
const token=randomBytes(32).toString('hex');run('INSERT INTO sessions VALUES(?,?,?)',hash(token),user.id,Date.now()+604800000);return send({user:safeUser(user)},200,{'Set-Cookie':cookie(token)});
}
if(path==='/api/logout'&&method==='POST'){const token=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('dobra_session='))?.slice(14);if(token)run('DELETE FROM sessions WHERE token=?',hash(token));return send({ok:true},200,{'Set-Cookie':cookie('',0)});}
if(path==='/api/vehicles'&&method==='GET')return send(vehicles(u,req.url),200,u?{}:{'Cache-Control':'public, max-age=10'});
if((path==='/api/listings'||path==='/api/vehicles')&&method==='POST'){
 const user=requireUser(req),b=await body(req);
 if(Object.keys(b).some(key=>!['listing','listing_no','category'].includes(key))||('listing' in b)==('listing_no' in b))fail(400,'İlan açarken yalnızca ilan numarası ve kategori gönderilebilir.');
 const number=String(b.listing??b.listing_no).trim();if(!/^\d{8,12}$/.test(number))fail(400,'8–12 haneli ilan numarası girin.');
 const category=pick(b.category,categories),existing=one('SELECT status FROM vehicles WHERE listing_no=?',number);
 if(existing)fail(409,existing.status==='pending'?'Bu ilan numarası için açılan sayfa şu anda incelemede. Onay tamamlanınca görünür olacak.':'Bu ilan numarasıyla bir sayfa zaten var. Her ilan numarası yalnızca bir kez kullanılabilir.');
 limit(`listing:${user.id}`,15,3600000);const id=randomUUID(),status=admin(user)?'approved':'pending';
 try{run('INSERT INTO vehicles(id,user_id,title,brand,model,year,km,city,category,fuel,gear,source,description,status,created,listing_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,user.id,`İlan #${number}`,'Belirtilmedi','Belirtilmedi',0,-1,'Belirtilmedi',category,'Belirtilmedi','Belirtilmedi',null,'',status,now(),number);}
 catch(error){if(String(error.message).includes('vehicles.listing_no'))fail(409,'Bu ilan numarasıyla bir sayfa zaten var.');throw error;}
 publish('vehicles',status==='approved'?'public':'admin',id);return send({id,pending:status==='pending'},201);
}
if(path==='/api/listings'&&method==='GET'){const number=listingNumber(new URL(req.url,'http://localhost').searchParams.get('number'));const v=one('SELECT id,status FROM vehicles WHERE listing_no=?',number);return send({id:['approved','suspended'].includes(v?.status)?v.id:null,status:v?.status==='pending'?'pending':v?.status==='approved'||v?.status==='suspended'?'published':'missing'});}
if(path==='/api/account'&&method==='GET'){const user=requireUser(req);return send({comments:q("SELECT c.*,v.listing_no,v.status AS vehicle_status FROM comments c JOIN vehicles v ON v.id=c.vehicle_id WHERE c.user_id=? AND v.status<>'removed' ORDER BY c.created DESC",user.id),vehicles:q("SELECT id,status,listing_no,owner_removed,created FROM vehicles WHERE user_id=? AND status<>'removed' ORDER BY created DESC",user.id),prices:q("SELECT p.*,v.listing_no,v.status AS vehicle_status FROM prices p JOIN vehicles v ON v.id=p.vehicle_id WHERE p.user_id=? AND v.status<>'removed' ORDER BY p.created DESC",user.id)});}
const manage=path.match(/^\/api\/vehicles\/([\w-]+)\/manage$/);
if(manage&&method==='POST'){
const user=requireUser(req),v=one('SELECT * FROM vehicles WHERE id=?',manage[1]);if(!v||v.status==='removed'&&!admin(user))fail(404,'İlan bulunamadı.');if(v.user_id!==user.id&&!admin(user))fail(403,'Yalnızca ilanı ekleyen kişi veya yönetici bu işlemi yapabilir.');
const b=await body(req),action=pick(b.action,['update','remove','restore']);if(Object.keys(b).some(key=>!['action',...(action==='update'?['category']:[])].includes(key)))fail(400,'Bu işlemde araç veya fiyat bilgisi gönderilemez.');if(v.status==='suspended'&&!admin(user))fail(403,'Askıdaki ilan üzerinde işlem yapılamaz.');
if(action==='remove'){if(v.status==='removed')fail(409,'İlan zaten kaldırılmış.');run('UPDATE vehicles SET status=?,owner_removed=? WHERE id=?','removed',admin(user)?0:1,v.id);}
else if(action==='restore'){if(v.status!=='removed'||!admin(user)&&!v.owner_removed)fail(403,'Bu ilanı geri açma yetkin yok.');run('UPDATE vehicles SET status=?,owner_removed=0 WHERE id=?',admin(user)?'approved':'pending',v.id);}
else{
 if(v.status==='removed'&&!admin(user))fail(404,'İlan bulunamadı.');
 const category=pick(b.category,categories),status=admin(user)?v.status:'pending';
 run('UPDATE vehicles SET category=?,status=? WHERE id=?',category,status,v.id);

}
run('INSERT INTO audit VALUES(?,?,?,?,?,?)',randomUUID(),user.id,'vehicles',v.id,admin(user)?action:`owner_${action}`,now());const updatedStatus=one('SELECT status FROM vehicles WHERE id=?',v.id).status;publish('vehicles',['approved','suspended'].includes(v.status)||['approved','suspended'].includes(updatedStatus)?'public':'admin',v.id);return send({ok:true,status:updatedStatus});
}
let m=path.match(/^\/api\/vehicles\/([\w-]+)(?:\/(comments|prices|follow))?$/);
if(m){const [,id,action]=m,v=vehicle(id,u);
if(!action&&method==='GET')return send({vehicle:{id:v.id,user_id:v.user_id,listing_no:v.listing_no,category:v.category,status:v.status,owner_removed:v.owner_removed,demo:v.demo,created:v.created},comments:q(`SELECT c.id,c.body,c.role,c.status,c.created,c.user_id,u.name,(SELECT COUNT(*) FROM votes WHERE comment_id=c.id) helpful,(SELECT COUNT(*) FROM votes WHERE comment_id=c.id AND user_id=?) voted FROM comments c JOIN users u ON u.id=c.user_id WHERE c.vehicle_id=? AND (c.status='approved' OR c.user_id=?) ORDER BY c.created DESC`,u?.id||'',id,u?.id||''),prices:['approved','suspended'].includes(v.status)?q('SELECT p.id,p.amount,p.observed,p.created,u.name FROM prices p JOIN users u ON u.id=p.user_id WHERE vehicle_id=? AND p.status=\'approved\' ORDER BY p.observed DESC,p.created DESC',id):[],myPrices:u?q("SELECT id,amount,observed,CASE WHEN status='approved' AND ? NOT IN ('approved','suspended') THEN 'pending_listing' ELSE status END AS status FROM prices WHERE vehicle_id=? AND user_id=? AND (status<>'approved' OR ? NOT IN ('approved','suspended')) ORDER BY created DESC",v.status,id,u.id,v.status):[],following:!!one('SELECT 1 FROM follows WHERE user_id=? AND vehicle_id=?',u?.id||'',id)});
if(method==='POST'){const user=requireUser(req);if(v.status==='suspended')fail(423,'Bu ilan yönetici tarafından geçici olarak askıya alındı. İşlemler kapalı.');if(v.status!=='approved')fail(423,'İlan onaylanmadan yorum veya fiyat eklenemez.');
if(action==='follow'){const has=one('SELECT 1 FROM follows WHERE user_id=? AND vehicle_id=?',user.id,id);has?run('DELETE FROM follows WHERE user_id=? AND vehicle_id=?',user.id,id):run('INSERT INTO follows VALUES(?,?)',user.id,id);return send({following:!has});}
const b=await body(req);limit(`contribute:${user.id}`,20,3600000);if(one('SELECT status FROM vehicles WHERE id=?',id)?.status!=='approved')fail(423,'Bu ilan artık etkileşime açık değil.');
if(action==='comments'){const comment=text(b.body,30,3000,'Yorum');run('INSERT INTO comments(id,vehicle_id,user_id,role,body,status,created,review_flags) VALUES(?,?,?,?,?,?,?,?)',randomUUID(),id,user.id,pick(b.role,roles),comment,'pending',now(),reviewFlags(comment).join(', '));publish('comments','admin',id);publish('comments','user',id,user.id);return send({pending:true},201);}
if(action==='prices'){if(Object.keys(b).some(key=>!['amount','observed'].includes(key)))fail(400,'Fiyat bildirirken yalnızca tutar ve gözlem tarihi gönderilebilir.');const observed=text(b.observed,10,10,'Gözlem tarihi');if(!/^\d{4}-\d{2}-\d{2}$/.test(observed)||!Number.isFinite(Date.parse(observed))||new Date(observed).toISOString().slice(0,10)!==observed||observed>now().slice(0,10)||observed<'2000-01-01')fail(400,'Geçerli bir geçmiş veya bugünün tarihini girin.');run('INSERT INTO prices VALUES(?,?,?,?,?,?,?)',randomUUID(),id,user.id,num(b.amount,1,1000000000,'Fiyat'),observed,'pending',now());publish('prices','admin',id);publish('prices','user',id,user.id);return send({pending:true},201);}
}}
m=path.match(/^\/api\/comments\/([\w-]+)\/(vote|report)$/);
if(m&&method==='POST'){const user=requireUser(req),[,id,action]=m,c=one("SELECT c.*,v.status AS vehicle_status FROM comments c JOIN vehicles v ON v.id=c.vehicle_id WHERE c.id=? AND c.status='approved'",id);if(!c||!['approved','suspended'].includes(c.vehicle_status))fail(404,'Yorum bulunamadı.');if(c.vehicle_status==='suspended')fail(423,'Bu ilan askıya alındı. İşlemler kapalı.');if(action==='vote'){if(c.user_id===user.id)fail(400,'Kendi yorumunuzu oylayamazsınız.');const exists=one('SELECT 1 FROM votes WHERE user_id=? AND comment_id=?',user.id,id);exists?run('DELETE FROM votes WHERE user_id=? AND comment_id=?',user.id,id):run('INSERT INTO votes VALUES(?,?)',user.id,id);publish('votes','public',c.vehicle_id);return send({ok:true});}const b=await body(req);if(one('SELECT status FROM vehicles WHERE id=?',c.vehicle_id)?.status!=='approved')fail(423,'Bu ilan artık etkileşime açık değil.');run('INSERT OR IGNORE INTO reports VALUES(?,?,?,?,?,?)',randomUUID(),id,user.id,text(b.reason,10,500,'Şikâyet nedeni'),'open',now());publish('reports','admin',c.vehicle_id);return send({ok:true});}
if(path==='/api/admin'&&method==='GET'){requireAdmin(req);return send({
vehicles:q('SELECT v.id,v.user_id,v.listing_no,v.category,v.status,v.created,u.name FROM vehicles v JOIN users u ON v.user_id=u.id ORDER BY v.created DESC'),
comments:q('SELECT c.*,v.listing_no,v.status AS vehicle_status,u.name FROM comments c JOIN vehicles v ON v.id=c.vehicle_id JOIN users u ON u.id=c.user_id ORDER BY c.created DESC'),
prices:q('SELECT p.*,v.listing_no,v.status AS vehicle_status,u.name FROM prices p JOIN vehicles v ON v.id=p.vehicle_id JOIN users u ON u.id=p.user_id ORDER BY p.created DESC'),
reports:q('SELECT r.*,c.body,c.vehicle_id,v.listing_no,u.name FROM reports r JOIN comments c ON c.id=r.comment_id JOIN vehicles v ON v.id=c.vehicle_id JOIN users u ON u.id=r.user_id ORDER BY r.created DESC'),
users:q('SELECT id,name,email,created,is_admin,is_suspended FROM users ORDER BY created DESC'),
userCount:one('SELECT COUNT(*) AS count FROM users').count,
audit:q('SELECT a.*,u.name AS admin_name FROM audit a JOIN users u ON u.id=a.admin_id ORDER BY a.created DESC LIMIT 20'),
categories
});}
if(path==='/api/admin/moderate'&&method==='POST'){
const user=requireAdmin(req),b=await body(req),kind=pick(b.kind,['vehicles','comments','prices','reports','users']),id=text(b.id,1,100,'Kayıt');
if(kind==='users'){
const target=one('SELECT id,is_admin FROM users WHERE id=?',id);if(!target)fail(404,'Üye bulunamadı.');if(target.is_admin)fail(403,'Yönetici hesapları bu ekrandan askıya alınamaz.');const status=pick(b.status,['active','suspended']);run('UPDATE users SET is_suspended=? WHERE id=?',status==='suspended'?1:0,id);if(status==='suspended')run('DELETE FROM sessions WHERE user_id=?',id);run('INSERT INTO audit VALUES(?,?,?,?,?,?)',randomUUID(),user.id,kind,id,status,now());publish('users','admin');return send({ok:true});
}
const allowed=kind==='reports'?['resolved','open']:kind==='vehicles'||kind==='comments'||kind==='prices'?['approved','rejected','suspended','removed']:[];const status=pick(b.status,allowed);const target=one(`SELECT * FROM ${kind} WHERE id=?`,id);if(!target)fail(404,'Kayıt bulunamadı.');if(status==='approved'&&(kind==='comments'||kind==='prices')&&one('SELECT status FROM vehicles WHERE id=?',target.vehicle_id)?.status!=='approved')fail(409,'Önce bağlı ilanı onaylayın.');if(kind==='comments'&&status==='approved'&&target.review_flags&&b.overrideFlagged!==true)fail(409,'Bu yorum ek inceleme gerektiriyor. Gerekçeyi değerlendirip açık onay verin.');if(kind==='vehicles')run('UPDATE vehicles SET status=?,owner_removed=0 WHERE id=?',status,id);else run(`UPDATE ${kind} SET status=? WHERE id=?`,status,id);run('INSERT INTO audit VALUES(?,?,?,?,?,?)',randomUUID(),user.id,kind,id,kind==='comments'&&status==='approved'&&target.review_flags?'approved_flagged':status,now());const vehicleId=kind==='vehicles'?id:kind==='comments'||kind==='prices'?target.vehicle_id:null;if(kind==='reports')publish(kind,'admin',vehicleId);else if(target.status==='approved'||status==='approved'||kind==='vehicles'&&target.status==='suspended')publish(kind,'public',vehicleId);else{publish(kind,'admin',vehicleId);publish(kind,'user',vehicleId,target.user_id);}return send({ok:true});
}
fail(404,'Sayfa bulunamadı.');
}
if(process.env.DEMO_DATA==='true'&&!one('SELECT 1 FROM vehicles LIMIT 1')){
const uid='demo-user';run('INSERT OR IGNORE INTO users(id,email,name,password,created) VALUES(?,?,?,?,?)',uid,'demo@invalid.example','Örnek kullanıcı',`disabled:${'0'.repeat(128)}`,now());
const rows=[['BMW 320i M Sport','BMW','320i M Sport',2021,68500,'İstanbul','Benzin',2850000],['Volkswagen Golf 1.5 eTSI R-Line','Volkswagen','Golf 1.5 eTSI',2023,32400,'Ankara','Benzin',2190000],['Mercedes-Benz C 200 AMG','Mercedes-Benz','C 200 AMG',2022,47200,'İzmir','Hibrit',4150000],['Renault Megane 1.5 Blue dCi','Renault','Megane Icon',2020,112000,'Bursa','Dizel',1245000]];
for(let i=0;i<rows.length;i++){const [title,brand,model,year,km,city,fuel,price]=rows[i],id=`demo-${i}`;run('INSERT INTO vehicles(id,user_id,title,brand,model,year,km,city,category,fuel,gear,source,description,status,demo,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,uid,title,brand,model,year,km,city,'Otomobil',fuel,'Otomatik',null,'Bu bir örnek araç kaydıdır. Gerçek bir ilanı veya aracı temsil etmez.','approved',1,now());run('INSERT INTO prices VALUES(?,?,?,?,?,?,?)',randomUUID(),id,uid,price,'2026-10-20','approved',now());run('INSERT INTO comments(id,vehicle_id,user_id,role,body,status,created) VALUES(?,?,?,?,?,?,?)',randomUUID(),id,uid,'Aracı gördüm','Bu bir örnek yorumdur. Burada aracı görenlerin gözlemleri ve eski sahiplerin deneyimleri, inceleme sonrasında yer alacak.','approved',now());}}
const getTemplate=()=>readFileSync(resolve(root,'public/index.html'),'utf8');
const seo=(req,res,path)=>makeSeo({q,one,origin:origin||'http://localhost:4180',template:production?staticTemplate:getTemplate()})(req,res,path);
const staticTemplate=production?getTemplate():null;
const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/legal.json':['legal.json','application/json; charset=utf-8'],'/intro-boot.js':['intro-boot.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/brand-symbol.svg':['brand-symbol.svg','image/svg+xml'],'/favicon.svg':['favicon.svg','image/svg+xml'],'/favicon-96.png':['favicon-96.png','image/png'],'/favicon.ico':['favicon.ico','image/x-icon'],'/lucide-icons.svg':['lucide-icons.svg','image/svg+xml'],'/lucide-search.svg':['lucide-search.svg','image/svg+xml'],'/logo.svg':['logo.svg','image/svg+xml']};
const server=http.createServer(async(req,res)=>{
res.setHeader('X-Content-Type-Options','nosniff');
if(production)res.setHeader('X-Frame-Options','DENY');
res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self';${production ? " frame-ancestors 'none';" : ""} base-uri 'none'; form-action 'self'; object-src 'none'`);
if(production)res.setHeader('Strict-Transport-Security','max-age=31536000');
try{const path=new URL(req.url,'http://localhost').pathname;if(production&&path!=='/api/health'&&req.headers.host!==new URL(origin).host){res.writeHead(308,{Location:origin+req.url,'Cache-Control':'no-store'});return res.end();}if(path.startsWith('/api/'))return await api(req,res,path);if(seo(req,res,path))return;if(req.method!=='GET'&&req.method!=='HEAD')fail(405,'Yöntem desteklenmiyor.');const entry=files[path];if(!entry)fail(404,'Sayfa bulunamadı.');res.writeHead(200,{'Content-Type':entry[1],'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:readFileSync(resolve(root,'public',entry[0])));}catch(e){const status=e.status||500;if(status===500)console.error('Request failed:',e.message);if(!res.headersSent)res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:status===500?'Bir sorun oluştu. Lütfen tekrar deneyin.':e.message}));}});
server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=1000;
server.listen(Number(process.env.PORT||4180),'0.0.0.0',()=>console.log(`Sarı Site Yorumla http://localhost:${server.address().port}`));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{for(const client of streams)client.res.end();streams.clear();server.close(()=>{db.close();process.exit(0);});});
