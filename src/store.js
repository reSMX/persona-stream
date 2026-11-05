import { DatabaseSync } from 'node:sqlite';

export const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));
export const now = () => new Date().toISOString();
export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS topics(name TEXT PRIMARY KEY, weight REAL NOT NULL, baseline REAL NOT NULL, keywords TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, exposures INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY, author TEXT NOT NULL, url TEXT NOT NULL, preview TEXT NOT NULL, body TEXT, status TEXT NOT NULL, score REAL, reason TEXT, analysis TEXT, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS posts_author ON posts(author);
      CREATE TABLE IF NOT EXISTS authors(handle TEXT PRIMARY KEY, summary TEXT NOT NULL DEFAULT '', affinity REAL NOT NULL DEFAULT 0, trust REAL NOT NULL DEFAULT 0.5, encounters INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY, author TEXT NOT NULL, post_id TEXT NOT NULL UNIQUE, note TEXT NOT NULL, quote TEXT NOT NULL, topics TEXT NOT NULL, affinity_delta REAL NOT NULL, confidence REAL NOT NULL, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memories_author ON memories(author);
      CREATE TABLE IF NOT EXISTS changes(id INTEGER PRIMARY KEY, topic TEXT NOT NULL, old REAL NOT NULL, new REAL NOT NULL, reason TEXT NOT NULL, post_id TEXT, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates(name TEXT NOT NULL, author TEXT NOT NULL, post_id TEXT NOT NULL, keyword TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(name,post_id));
      CREATE TABLE IF NOT EXISTS actions(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, UNIQUE(kind,target));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, level TEXT NOT NULL, text TEXT NOT NULL, data TEXT, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.prepare("UPDATE actions SET status='unknown', detail='Процесс завершился до подтверждения действия. Проверь X вручную.' WHERE status='pending'").run();
  }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  atomic(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  seed(topics, oldTopics = []) {
    const old = new Map(oldTopics.map(t => [t.name, t]));
    this.atomic(() => {
      for (const t of topics) {
        const existing = this.get('SELECT * FROM topics WHERE name=?', t.name);
        if (!existing) this.run('INSERT INTO topics(name,weight,baseline,keywords,pinned,updated) VALUES(?,?,?,?,?,?)', t.name,t.weight,t.weight,JSON.stringify(t.keywords),+t.pinned,now());
        else {
          const editedWeight = old.has(t.name) && old.get(t.name).weight !== t.weight;
          this.run('UPDATE topics SET baseline=?, keywords=?, pinned=?, weight=? WHERE name=?',t.weight,JSON.stringify(t.keywords),+t.pinned,editedWeight ? t.weight : existing.weight,t.name);
        }
      }
      for (const oldTopic of oldTopics) if (!topics.some(t => t.name === oldTopic.name)) this.run('DELETE FROM topics WHERE name=?',oldTopic.name);
    });
  }
  topics() { return this.all('SELECT * FROM topics ORDER BY weight DESC').map(t => ({ ...t, keywords: JSON.parse(t.keywords), pinned: !!t.pinned })); }
  event(text, level = 'info', data = null) { this.run('INSERT INTO events(level,text,data,created) VALUES(?,?,?,?)', level,text,data ? JSON.stringify(data) : null,now()); }
  setState(key, value) { this.run('INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(value)); }
  state(key, fallback) { const r = this.get('SELECT value FROM state WHERE key=?', key); return r ? JSON.parse(r.value) : fallback; }
  rememberPreview(post, score, reason, selected) {
    this.run(`INSERT INTO posts(id,author,url,preview,status,score,reason,created) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET preview=excluded.preview,status=excluded.status,score=excluded.score,reason=excluded.reason
      WHERE posts.status='selected'`,post.id,post.author,post.url,post.preview,selected ? 'selected' : 'skipped',score,reason,now());
  }
  markNotInterested(id) { this.run("UPDATE posts SET status='not_interested' WHERE id=? AND status='skipped'",id); }
  seen(id) { const post=this.get('SELECT status FROM posts WHERE id=?',id);return !!post && post.status!=='selected'; }
  author(handle, topicNames = []) {
    const profile = this.get('SELECT * FROM authors WHERE handle=?',handle);
    if (!profile) return null;
    const rows = this.all('SELECT * FROM memories WHERE author=? ORDER BY id DESC LIMIT 50',handle);
    const relevant = rows.sort((a,b) => {
      const score = r => JSON.parse(r.topics).filter(t => topicNames.includes(t)).length;
      return score(b)-score(a) || b.id-a.id;
    }).slice(0,5);
    return { ...profile, memories: relevant.map(r => ({ ...r, topics: JSON.parse(r.topics) })) };
  }
  learn(post, analysis, config) {
    return this.atomic(() => {
      if (this.get("SELECT id FROM posts WHERE id=? AND status='read'",post.id)) return false;
      this.run("UPDATE posts SET body=?, analysis=?, status='read' WHERE id=?",post.text,JSON.stringify(analysis),post.id);
      this.run('INSERT OR IGNORE INTO authors(handle,updated) VALUES(?,?)',post.author,now());
      const prior = this.get('SELECT * FROM authors WHERE handle=?',post.author);
      const quote = analysis.evidenceQuote && post.text.includes(analysis.evidenceQuote) ? analysis.evidenceQuote : '';
      const delta = quote ? clamp(analysis.affinityDelta,-0.1,0.1) : 0;
      const summary = quote ? analysis.authorNote.slice(0,600) : prior.summary;
      this.run('UPDATE authors SET summary=?, affinity=?, trust=?, encounters=encounters+1, updated=? WHERE handle=?',summary,clamp(prior.affinity+delta,-1,1),clamp(prior.trust+(quote ? analysis.trustDelta : 0),0,1),now(),post.author);
      this.run('INSERT OR IGNORE INTO memories(author,post_id,note,quote,topics,affinity_delta,confidence,created) VALUES(?,?,?,?,?,?,?,?)',post.author,post.id,quote ? analysis.authorNote : 'Прочитан пост; подтверждённой заметки об авторе нет.',quote,JSON.stringify(analysis.topics),delta,quote ? analysis.confidence : 0,now());
      for (const name of analysis.topics) {
        const t = this.get('SELECT * FROM topics WHERE name=?',name);
        if (!t) continue;
        const recent = this.get('SELECT COUNT(*) AS n FROM memories WHERE topics LIKE ? AND created>?',`%${name.replaceAll('%','')}%`,new Date(Date.now()-3600000).toISOString()).n;
        const satisfaction = analysis.value * 0.7 + analysis.curiosity * 0.3;
        const target = clamp(satisfaction - Math.max(0,recent-3)*0.025);
        const next = t.pinned ? t.weight : clamp(t.weight+config.reading.learningRate*(target-t.weight),0.05,0.98);
        this.run('UPDATE topics SET weight=?, exposures=exposures+1, updated=? WHERE name=?',next,now(),name);
        if (Math.abs(next-t.weight)>0.0001) this.run('INSERT INTO changes(topic,old,new,reason,post_id,created) VALUES(?,?,?,?,?,?)',name,t.weight,next,analysis.reason,post.id,now());
      }
      const discovery = analysis.newInterest;
      if (discovery && discovery.name && analysis.value >= 0.65 && quote && !this.get('SELECT name FROM topics WHERE name=?',discovery.name)) {
        this.run('INSERT OR IGNORE INTO candidates VALUES(?,?,?,?,?)',discovery.name,post.author,post.id,discovery.keyword,now());
        const n = this.get('SELECT COUNT(*) n, COUNT(DISTINCT author) authors FROM candidates WHERE name=?',discovery.name);
        if (n.n>=3 && n.authors>=2 && this.get('SELECT COUNT(*) n FROM topics').n<30) {
          this.run('INSERT INTO topics(name,weight,baseline,keywords,updated) VALUES(?,?,?,?,?)',discovery.name,0.4,0.4,JSON.stringify([discovery.keyword]),now());
          this.event(`Новый интерес: ${discovery.name}. Подтверждён несколькими постами разных авторов.`);
        }
      }
      return true;
    });
  }
  readCount() { return this.get("SELECT COUNT(*) n FROM posts WHERE status='read'").n; }
  action(kind,target,author,text) {
    const r = this.run("INSERT OR IGNORE INTO actions(kind,target,author,text,status,created) VALUES(?,?,?,?,'pending',?)",kind,target,author,text,now());
    return r.changes ? Number(r.lastInsertRowid) : null;
  }
  finishAction(id,status,detail) { this.run('UPDATE actions SET status=?,detail=? WHERE id=?',status,detail,id); }
  canAct(kind,author,config,at=Date.now()) {
    const a = config.actions;
    const allowed = {like:a.likes,reply:a.replies,follow:a.follows,post:a.posts,notInterested:a.notInterested};
    if (!allowed[kind]) return 'Действие выключено';
    if (this.get("SELECT id FROM actions WHERE status IN ('unknown','pending')")) return 'Есть действие без подтверждённого результата';
    if (kind!=='notInterested' && this.readCount()<a.warmupReads) return 'Знакомство с лентой';
    const since = new Date(at-86400000).toISOString();
    const limits = {like:a.maxLikesDay,reply:a.maxRepliesDay,follow:a.maxFollowsDay,post:a.maxPostsDay,notInterested:a.maxNotInterestedDay};
    const n = this.get("SELECT COUNT(*) n FROM actions WHERE kind=? AND created>? AND status IN ('success','pending','unknown')",kind,since).n;
    if(n>=limits[kind]) return 'Лимит за 24 часа';
    const last = kind==='notInterested'
      ? this.get("SELECT created FROM actions WHERE kind='notInterested' AND status IN ('success','pending','unknown') ORDER BY id DESC LIMIT 1")
      : this.get("SELECT created FROM actions WHERE kind!='notInterested' AND status IN ('success','pending','unknown') ORDER BY id DESC LIMIT 1");
    if(last && at-Date.parse(last.created)<(kind==='notInterested'?Math.max(600,a.minGapSeconds):a.minGapSeconds)*1000) return 'Пауза между действиями';
    if(kind==='reply' && this.get("SELECT id FROM actions WHERE kind='reply' AND author=? AND created>? AND status IN ('success','pending','unknown')",author,since)) return 'Автор уже получил ответ за последние 24 часа';
    return null;
  }
  snapshot() {
    return {
      counts: { seen:this.get('SELECT COUNT(*) n FROM posts').n, read:this.readCount(), authors:this.get('SELECT COUNT(*) n FROM authors').n, actions:this.get("SELECT COUNT(*) n FROM actions WHERE status='success'").n },
      topics:this.topics(), authors:this.all('SELECT * FROM authors ORDER BY updated DESC LIMIT 100'),
      posts:this.all('SELECT * FROM posts ORDER BY created DESC LIMIT 60').map(p=>({...p,analysis:p.analysis ? JSON.parse(p.analysis):null})),
      changes:this.all('SELECT * FROM changes ORDER BY id DESC LIMIT 50'),
      actions:this.all('SELECT * FROM actions ORDER BY id DESC LIMIT 80'), events:this.all('SELECT * FROM events ORDER BY id DESC LIMIT 80')
    };
  }
  close() { this.db.close(); }
}
