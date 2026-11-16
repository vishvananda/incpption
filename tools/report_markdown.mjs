// Markdown is the report's only content source. Layout comments keep stable
// anchors and select the chart/cards/FAQ presentation without embedding HTML.
import {marked} from 'marked';
import {parse as parseYaml} from 'yaml';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inline = value => marked.parseInline(value);
const slug = value => value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const content = tokens => marked.parser(tokens).replaceAll('<table>', '<table class="opportunity-table">');
const cells = row => row.map(cell => cell.text);

function tableAfter(tokens, index) {
  let next = index + 1;
  while (tokens[next]?.type === 'space') next++;
  if (tokens[next]?.type !== 'table') throw Error('A report chart or stats marker must be followed by a Markdown table');
  return {table: tokens[next], next};
}

function chart(table) {
  const expected = ['Phase','Clang instructions','cppgm instructions','Clang cycles','cppgm cycles','Description'];
  if (JSON.stringify(cells(table.header)) !== JSON.stringify(expected)) throw Error('Unexpected phase-chart columns: '+expected.join(' | '));
  if (!table.rows.length) throw Error('The phase chart needs at least one phase');
  const rows = table.rows.map(row => {
    const [name, ...rest] = cells(row), description = rest.pop();
    const values = rest.map(value => {
      if (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0) throw Error('Invalid phase cost: '+value);
      return Number(value);
    });
    return {name, description, values};
  });
  const max = Math.max(...rows.flatMap(row => row.values.slice(0,2))) || 1;
  const gap = rows.reduce((sum,row) => sum + row.values[0] - row.values[1], 0);
  const phases = rows.map(({name,description,values:[ci,gi,cc,gc]}) => {
    const bars = [['clang','Clang',ci],['cppgm','cppgm',gi]].map(([key,label,value]) => `<div class="bar ${key}" style="--width:${value/max*100}%" role="img" aria-label="${label}: ${value.toFixed(1)} billion instructions"><span aria-hidden="true">${value.toFixed(1)}</span></div>`).join('');
    const share = gap ? Math.round((ci-gi)/gap*100) : 0;
    return `<div class="phase" data-clang-instructions="${ci}" data-cppgm-instructions="${gi}" data-clang-cycles="${cc}" data-cppgm-cycles="${gc}"><div class="phase-head"><strong>${inline(name)}</strong><span class="share">${share}% of attributed gap</span></div><div class="bars">${bars}</div><p>${inline(description)}</p></div>`;
  }).join('\n');
  return `<fieldset class="metric" disabled><legend>Show phase costs in</legend><label><input type="radio" name="metric" value="instructions" checked> Instructions</label><label><input type="radio" name="metric" value="cycles"> Cycles</label></fieldset>
<div class="chart-key"><span><i class="clang-key"></i> Clang</span><span><i class="cppgm-key"></i> cppgm</span><span>Billions · <span id="metric-name">instructions</span></span></div>
<div id="phase-chart" class="phase-chart" aria-live="polite">${phases}</div>`;
}

function stats(table) {
  if (JSON.stringify(cells(table.header)) !== JSON.stringify(['Metric','Value','Unit'])) throw Error('Stats columns must be Metric | Value | Unit');
  return '<div class="stats">'+table.rows.map(row => {
    const [label,value,unit] = cells(row);
    return `<div><span>${inline(label)}</span><strong>${escape(value)}<span> ${escape(unit)}</span></strong></div>`;
  }).join('')+'</div>';
}

function dataTable(table, caption = '') {
  const head=table.header.map(cell=>'<th scope="col">'+inline(cell.text)+'</th>').join('');
  const rows=table.rows.map(row=>'<tr>'+row.map((cell,index)=>index===0?'<th scope="row">'+inline(cell.text)+'</th>':'<td>'+inline(cell.text)+'</td>').join('')+'</tr>').join('');
  return '<table class="opportunity-table">'+(caption?'<caption>'+inline(caption)+'</caption>':'')+'<thead><tr>'+head+'</tr></thead><tbody>'+rows+'</tbody></table>';
}

function renderBlocks(tokens, intro = false) {
  let html = '', lead = intro;
  for (let i=0; i<tokens.length; i++) {
    const token = tokens[i], marker = token.type === 'html' ? token.raw.trim() : '';
    if (marker === '<!-- phase-chart -->' || marker === '<!-- stats -->') {
      const {table,next} = tableAfter(tokens,i);
      html += marker.includes('phase-chart') ? chart(table) : stats(table); i=next;
    } else if (marker === '<!-- note -->') {
      let next=i+1;
      while(tokens[next]?.type === 'space') next++;
      if(tokens[next]?.type !== 'paragraph') throw Error('A note marker must be followed by a paragraph');
      html += content([tokens[next]]).replace('<p>', '<p class="note">'); i=next;
    } else if (intro && token.type === 'blockquote') {
      html += '<div class="scope">'+content(token.tokens)+'</div>';
    } else if (lead && token.type === 'paragraph') {
      html += content([token]).replace('<p>', '<p class="lead">'); lead=false;
    } else if (token.type === 'paragraph' && token.tokens.length === 1 && token.tokens[0].type === 'em') {
      // An italic line immediately above a table is its caption.
      let next=i+1;
      while(tokens[next]?.type === 'space') next++;
      if(tokens[next]?.type === 'table') {
        html += dataTable(tokens[next],token.tokens[0].text); i=next;
      } else if(token.type === 'table') html += dataTable(token);
    else html += content([token]);
    } else if(token.type === 'table') html += dataTable(token);
    else html += content([token]);
  }
  return html;
}

function renderSection(section, index) {
  const prelude=[], groups=[];
  let pendingId;
  for (const token of section.tokens) {
    const id = token.type === 'html' && token.raw.trim().match(/^<!--\s*id:\s*([a-z][a-z0-9-]*)\s*-->$/);
    if(id){pendingId=id[1];continue;}
    if(token.type === 'heading' && token.depth === 3) {
      groups.push({title:token.text,id:pendingId||slug(token.text),tokens:[]}); pendingId=null;
    } else (groups.length ? groups.at(-1).tokens : prelude).push(token);
  }
  if(pendingId)throw Error('A report id marker must be followed by a level-three heading');
  let body=renderBlocks(prelude);
  const articles=groups.map(group => section.mode === 'faq'
    ? `<details id="${escape(group.id)}"><summary>${inline(group.title)}</summary>${renderBlocks(group.tokens)}</details>`
    : `<article${section.mode === 'cards'?'':' class="improvement-group"'} id="${escape(group.id)}"><h3>${inline(group.title)}</h3>${renderBlocks(group.tokens)}</article>`).join('\n');
  body += section.mode === 'cards' ? '<div class="cards">'+articles+'</div>' : articles;
  return `<section id="${escape(section.id)}" aria-labelledby="${escape(section.id)}-title"><div class="section-label">${String(index+1).padStart(2,'0')} / ${escape(section.label)}</div><h2 id="${escape(section.id)}-title">${inline(section.title)}</h2>${body}</section>`;
}

export function renderReport(markdown, template) {
  const front=markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if(!front)throw Error('The report needs YAML metadata between --- lines');
  const metadata=parseYaml(front[1]);
  for(const key of ['title','description','eyebrow'])if(typeof metadata?.[key] !== 'string')throw Error('Missing report metadata: '+key);
  const tokens=marked.lexer(markdown.slice(front[0].length)), intro=[], sections=[];
  let title, pendingSection;
  for(const token of tokens) {
    const directive=token.type === 'html' && token.raw.trim().match(/^<!--\s*section:\s*([a-z][a-z0-9-]*)\s*\|\s*([^|]+?)(?:\s*\|\s*(cards|faq))?\s*-->$/);
    if(directive){pendingSection={id:directive[1],label:directive[2].trim(),mode:directive[3]};continue;}
    if(token.type === 'heading' && token.depth === 1) {
      if(title||sections.length)throw Error('The report must start with one level-one heading');
      title=token.text;
    } else if(token.type === 'heading' && token.depth === 2) {
      sections.push({...pendingSection,id:pendingSection?.id||slug(token.text),label:pendingSection?.label||token.text,title:token.text,tokens:[]}); pendingSection=null;
    } else (sections.length ? sections.at(-1).tokens : intro).push(token);
  }
  if(!title||pendingSection)throw Error('Missing report heading after a layout marker');
  const body=`<section class="intro" aria-labelledby="title"><p class="eyebrow">${escape(metadata.eyebrow)}</p><h1 id="title">${inline(title)}</h1>${renderBlocks(intro,true)}</section>`+sections.map(renderSection).join('\n');
  for(const marker of ['{{TITLE}}','{{DESCRIPTION}}','<!-- REPORT_BODY -->'])if(!template.includes(marker))throw Error('Missing report template marker: '+marker);
  return template.replace('{{TITLE}}',escape(metadata.title)).replace('{{DESCRIPTION}}',escape(metadata.description)).replace('<!-- REPORT_BODY -->',body);
}
