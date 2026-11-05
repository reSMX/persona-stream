import twitterText from 'twitter-text';
import { clamp } from './store.js';

export function rankPreviews(posts, results, config, topicRows, authors, random=Math.random) {
  const byIndex = new Map();
  for(const r of results.items) {
    if(r.index>=posts.length || byIndex.has(r.index)) throw new Error('Модель перепутала номера превью. Пачка отклонена.');
    byIndex.set(r.index,r);
  }
  if(byIndex.size!==posts.length) throw new Error('Модель оценила не все превью. Пачка отклонена.');
  return posts.map((p,index)=>{
    const r = byIndex.get(index);
    const matched = topicRows.filter(t=>r.topics.includes(t.name));
    const weight = matched.length ? Math.max(...matched.map(t=>t.weight)) : 0.25;
    const affinity = Math.max(0,authors[p.author]?.affinity || 0);
    const score = clamp(0.45*r.interest+0.2*r.curiosity+0.15*r.novelty+0.15*weight+0.05*affinity);
    return {...p,score,reason:r.reason,topics:r.topics,explore:score<config.reading.threshold && random()<config.reading.exploration};
  }).sort((a,b)=>b.score-a.score);
}

export function selectReads(ranked, config) {
  const relevant = ranked.filter(p=>p.score>=config.reading.threshold);
  const explorers = ranked.filter(p=>p.explore);
  const capacity = config.reading.fullReads;
  const selected = relevant.slice(0,explorers.length && capacity>1 ? capacity-1 : capacity);
  if(explorers.length && selected.length<capacity) selected.push(explorers[0]);
  if(selected.length<capacity) selected.push(...relevant.filter(p=>!selected.includes(p)).slice(0,capacity-selected.length));
  return selected;
}

export function selectNotInterested(ranked,selected,config,visibleIds) {
  if(!config.actions.notInterested || config.actions.notInterestedBelow<=0)return [];
  const selectedIds=new Set(selected.map(p=>p.id));
  const visible=new Set(visibleIds);
  return ranked.filter(p=>p.score<config.actions.notInterestedBelow && !selectedIds.has(p.id) && !p.explore && visible.has(p.id))
    .sort((a,b)=>a.score-b.score);
}

export function validatePublicText(text) {
  const clean = text.trim();
  if(!clean) throw new Error('Пустой текст публикации');
  const parsed = twitterText.parseTweet(clean);
  if(!parsed.valid) throw new Error(`Текст не помещается в обычный пост X (${parsed.weightedLength}/280)`);
  if(/(?:192\.168\.|127\.0\.0\.1|localhost|[A-Z]:\\|-----BEGIN .*PRIVATE KEY|(?:api[_ -]?key|password)\s*[:=])/i.test(clean)) throw new Error('В тексте обнаружены локальные адреса или данные конфигурации');
  if(/@[A-Za-z0-9_]+/.test(clean)) throw new Error('Дополнительные упоминания в автоматических публикациях выключены');
  return clean;
}

export function proposeActions(analysis,author,config) {
  const actions = [];
  if(author && author.encounters>=config.actions.followEvidence && author.affinity>=0.18 && author.trust>=0.5) actions.push('follow');
  if(analysis.replyDesire>=0.72 && analysis.value>=0.45) actions.push('reply');
  if(analysis.likeDesire>=0.72 && analysis.agreement>=0.2) actions.push('like');
  return actions;
}
