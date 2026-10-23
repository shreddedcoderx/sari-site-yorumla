// Conservative prompts for human review; these are signals, not legal findings.
const fold=value=>value.toLocaleLowerCase('tr').replace(/ı/g,'i').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ');
const rules=[
  ['hakaret veya küfür', /\b(?:salak|aptal|gerizekali|serefsiz|haysiyetsiz|orospu|pic|siktir|amk|o cocugu|dolandirici)\b/u],
  ['tehdit', /\b(?:oldururum|doverim|bulup gebertirim|evini basarim|seni bulurum)\b/u],
  ['suç isnadı', /\b(?:hirsiz|sahtekar|dolandirmis|dolandiriyor|suclu|kacakci)\b/u],
  ['örtülü kişisel saldırı', /\b(?:aklindan suphe|zekasindan suphe|adamlikla ilgisi yok|insanligi tartisilir|ne mal oldugu belli)\b/u]
];
export function reviewFlags(body){const normalized=fold(body);return rules.filter(([,pattern])=>pattern.test(normalized)).map(([label])=>label);}
