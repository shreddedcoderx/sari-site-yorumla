import {readFileSync} from 'node:fs';
const legalPages=JSON.parse(readFileSync(new URL('./public/legal.json',import.meta.url),'utf8'));
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const brand='Sarı Site Yorumla';
const description='Araç ilanı yorumlarını ilan numarasıyla bul. Eski sahiplerin ve aracı görmüş kişilerin deneyimlerini, kullanıcıların bildirdiği fiyatları oku; sen de yorum yap.';
export function makeSeo({q,one,origin,template}){
 const eligible="v.status='approved' AND coalesce(v.demo,0)=0 AND v.listing_no IS NOT NULL";
 const structured=data=>`<script type="application/ld+json">${JSON.stringify(data).replace(/</g,'\\u003c')}</script>`;
 const breadcrumb=(name,path)=>({'@context':'https://schema.org','@type':'BreadcrumbList',itemListElement:[{'@type':'ListItem',position:1,name:brand,item:origin+'/'},{'@type':'ListItem',position:2,name,item:origin+path}]});
 const page=(title,desc,path,content,index=true,schema=null)=>{const fallback=`<div class="seo-fallback" hidden aria-hidden="true">${content}</div><noscript>${content}</noscript>`;return template.replace(/<title>.*?<\/title>/,`<title>${escape(title)}</title>`).replace(/<meta name="description"[^>]*>/,`<meta name="description" content="${escape(desc)}">`).replace('</head>',`<link rel="canonical" href="${escape(origin+path)}"><meta name="robots" content="${index?'index,follow':'noindex,follow'}"><meta property="og:type" content="website"><meta property="og:locale" content="tr_TR"><meta property="og:site_name" content="${brand}"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(desc)}"><meta property="og:url" content="${escape(origin+path)}"><meta name="twitter:card" content="summary">${schema?structured(schema):''}</head>`).replace('<p class="loading">Sarı Site Yorumla yükleniyor…</p>',fallback);};
 const nav=`<header class="wrap"><a href="/">${brand}</a></header>`;
 const foot='<footer class="wrap"><a href="/about">Proje hakkında</a> · <a href="/terms">Kullanım koşulları</a> · <a href="/guide">Topluluk kuralları</a> · <a href="/privacy">KVKK aydınlatma metni</a> · <a href="/cookies">Çerezler</a> · <a href="https://github.com/shreddedcoderx/sari-site-yorumla" target="_blank" rel="noopener noreferrer">GitHub · Açık kaynak</a><p>Bağımsız ve kâr amacı gütmeyen bir topluluktur. Başka ilan platformlarıyla resmî bağlantısı yoktur.</p></footer>';
 return (req,res,path)=>{
  const send=(body,type='text/html; charset=utf-8',status=200,index=true)=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-cache',...(!index?{'X-Robots-Tag':'noindex, follow'}:{})});res.end(req.method==='HEAD'?undefined:body);return true;};
  if(!['GET','HEAD'].includes(req.method))return false;
  if(path==='/robots.txt')return send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /account\nDisallow: /takip\nSitemap: ${origin}/sitemap.xml\n`,'text/plain; charset=utf-8');
  const xml=entries=>'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+entries.map(e=>`<url><loc>${escape(origin+e)}</loc></url>`).join('')+'</urlset>';
  if(path==='/sitemap.xml'){
   const count=one(`SELECT count(*) total FROM vehicles v WHERE ${eligible}`).total;
   const names=['/sitemap-pages.xml',...Array.from({length:Math.ceil(count/1000)},(_,i)=>`/sitemap-vehicles-${i+1}.xml`)];
   return send('<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+names.map(n=>`<sitemap><loc>${escape(origin+n)}</loc></sitemap>`).join('')+'</sitemapindex>','application/xml; charset=utf-8');
  }
  if(path==='/sitemap-pages.xml')return send(xml(['/','/about','/terms','/guide','/privacy','/cookies']),'application/xml; charset=utf-8');
  let match=path.match(/^\/sitemap-vehicles-([1-9]\d{0,5})\.xml$/);
  if(match){const rows=q(`SELECT v.id FROM vehicles v WHERE ${eligible} ORDER BY v.id LIMIT 1000 OFFSET ?`,(Number(match[1])-1)*1000);return send(xml(rows.map(v=>'/ilan/'+v.id)),'application/xml; charset=utf-8');}
  if(path==='/'){
   const rows=q(`SELECT v.id,v.listing_no FROM vehicles v WHERE ${eligible} ORDER BY v.created DESC LIMIT 100`);
   const website={'@context':'https://schema.org','@type':'WebSite',name:brand,alternateName:'Sarı Site Yorumları',url:origin+'/'};
   return send(page(`Araç ilanı yorumları ve eski sahip deneyimleri | ${brand}`,description,'/',`${nav}<main class="wrap prose"><h1>Araç ilanı yorumları ve deneyimleri</h1><p>${description}</p><p>İlan numarasıyla aynı araç hakkındaki yorumları bir arada bul. Sahiplik etiketleri kullanıcı beyanıdır; profesyonel ekspertiz yerine geçmez.</p><h2>Topluluğun konuştuğu ilanlar</h2><ul>${rows.map(v=>`<li><a href="/ilan/${escape(v.id)}">İlan #${escape(v.listing_no||v.id)}</a></li>`).join('')}</ul><p>Yorum yazmak ve ilan aramak için tarayıcında JavaScript açık olmalı.</p></main>${foot}`,true,website));
  }
  if(['/about','/terms','/guide','/privacy','/cookies'].includes(path)){
   const legal=legalPages[path.slice(1)];
   const content=legal.intro+legal.sections.map(([heading,body])=>`<section><h2>${escape(heading)}</h2>${body}</section>`).join('');
   return send(page(`${legal.title} | ${brand}`,legal.description,path,`${nav}<main class="wrap prose"><h1>${escape(legal.heading)}</h1>${content}</main>${foot}`,true,breadcrumb(legal.title,path)));
  }
  match=path.match(/^\/ilan\/([\w-]{1,80})$/);
  if(match){
   const v=one("SELECT * FROM vehicles WHERE id=? AND status IN ('approved','suspended')",match[1]);
   if(!v)return send(page(`İlan bulunamadı | ${brand}`,'İlan bulunamadı.',path,`${nav}<main class="wrap prose"><h1>İlan bulunamadı.</h1><a href="/">Ana sayfa</a></main>`,false),'text/html; charset=utf-8',404,false);
   const comments=q("SELECT c.body,c.role,c.created,u.name FROM comments c JOIN users u ON u.id=c.user_id WHERE c.vehicle_id=? AND c.status='approved' ORDER BY c.created DESC LIMIT 50",v.id);
   const number=v.listing_no||v.id;
   const title=`İlan #${number} yorumları | ${brand}`;
   const desc=`İlan #${number} (${v.category}) için ${comments.length} onaylı yorum. Topluluğun deneyimlerini ve fiyat kayıtlarını oku.`;
   const index=!!v.listing_no&&!v.demo&&v.status==='approved';
   return send(page(title,desc,path,`${nav}<main class="wrap prose"><h1>İlan #${escape(number)} yorumları</h1><p>Kategori: ${escape(v.category)}</p><h2>İlan yorumları</h2>${comments.length?comments.map(c=>`<article><h3>${escape(c.name)} · ${escape(c.role)}</h3><p>İlişki etiketi kullanıcı beyanıdır.</p><p>${escape(c.body)}</p><time datetime="${escape(c.created)}">${escape(c.created.slice(0,10))}</time></article>`).join(''):'<p>Henüz yayımlanmış yorum bulunmuyor. İlk deneyimi sen paylaş.</p>'}</main>${foot}`,index,index?breadcrumb(`İlan #${number} yorumları`,path):null),'text/html; charset=utf-8',200,index);
  }
  if(['/account','/admin','/takip'].includes(path))return send(page(`${brand} — ${path==='/takip'?'Takip ettiklerim':'Hesabım'}`,'Üye hesabı.',path,'<p class="loading">Hesabın yükleniyor…</p>',false),'text/html; charset=utf-8',200,false);
  if(!path.includes('.' )&&!path.startsWith('/api/'))return send(page(`Sayfa bulunamadı | ${brand}`,'Sayfa bulunamadı.',path,`${nav}<main class="wrap prose"><h1>Sayfa bulunamadı.</h1><a href="/">Ana sayfa</a></main>`,false),'text/html; charset=utf-8',404,false);
  return false;
 };
}
