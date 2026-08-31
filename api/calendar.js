const NOTION = 'https://api.notion.com/v1';
const VERSION = '2025-09-03';

const BOARDS = [
  { creator: 'Brad',          key: 'BR', ds: '28b508e9-9dda-81ba-8d7f-000b84b83fbd' },
  { creator: 'Chris',         key: 'CH', ds: '2a1508e9-9dda-8125-bd63-000bb75578dd' },
  { creator: 'Lindsay',       key: 'LI', ds: '301508e9-9dda-811b-83c7-000b46be09b1' },
  { creator: 'Valeri',        key: 'VA', ds: 'f0dbec00-505d-4e16-8e51-b2fcfea21445' },
  { creator: 'Duncan',        key: 'DU', ds: '328508e9-9dda-8186-b4ca-000bd212e84b' },
  { creator: 'Dmytro',        key: 'DM', ds: '36b508e9-9dda-8004-a37f-000b460c8c46' },
  { creator: 'David Iya',     key: 'DI', ds: '898508e9-9dda-8383-ad90-070f01618f5a' },
  { creator: 'Nicole McCain', key: 'NM', ds: '25b449d2-35ba-4026-992e-39af9974b158' }
];

const DATE_PROP = 'POST DATE';

let cache = { at: 0, data: null };
const TTL = 20000;

function headers() {
  return {
    'Authorization': 'Bearer ' + process.env.NOTION_TOKEN,
    'Notion-Version': VERSION,
    'Content-Type': 'application/json'
  };
}

function findProp(props, wanted) {
  const lower = wanted.toLowerCase();
  for (const name of Object.keys(props)) {
    if (name.toLowerCase() === lower) return props[name];
  }
  return null;
}

function findByType(props, type) {
  for (const name of Object.keys(props)) {
    if (props[name] && props[name].type === type) return props[name];
  }
  return null;
}

function plain(rich) {
  if (!Array.isArray(rich)) return '';
  return rich.map(r => r.plain_text || '').join('').trim();
}

function readTitle(props) {
  const t = findByType(props, 'title');
  return t ? plain(t.title) : '';
}

function readStatus(props) {
  const p = findProp(props, 'Status');
  if (!p) return '';
  if (p.status && p.status.name) return p.status.name;
  if (p.select && p.select.name) return p.select.name;
  return '';
}

function readEditor(props) {
  const p = findProp(props, 'Editor');
  if (!p) return '';
  let raw = '';
  if (p.select && p.select.name) raw = p.select.name;
  else if (p.multi_select && p.multi_select.length) raw = p.multi_select[0].name;
  else if (p.people && p.people.length) raw = p.people[0].name || '';
  else if (p.rich_text) raw = plain(p.rich_text);
  return raw.trim().toUpperCase();
}

function readType(props) {
  const p = findProp(props, 'TYPE');
  if (!p) return '';
  if (p.select && p.select.name) return p.select.name;
  if (p.multi_select && p.multi_select.length) return p.multi_select[0].name;
  return '';
}

function readDate(props) {
  const p = findProp(props, DATE_PROP);
  if (!p || !p.date || !p.date.start) return null;
  return p.date.start.slice(0, 10);
}

function stageNumber(status) {
  const m = /^\s*(\d{1,2})/.exec(status || '');
  return m ? parseInt(m[1], 10) : null;
}

function isArchived(status) {
  return /^archiv/i.test((status || '').trim());
}

function leadTimeNeeded(stage) {
  if (stage === null) return 8;
  if (stage >= 10) return 0;
  if (stage === 9) return 1;
  if (stage === 8) return 2;
  if (stage === 7) return 3;
  if (stage === 6) return 5;
  return 8;
}

function riskOf(stage, status, dateStr, todayStr) {
  if (stage === 12 || /posted/i.test(status)) return 'posted';
  if (!dateStr) return 'unscheduled';
  const days = Math.round(
    (Date.parse(dateStr + 'T00:00:00Z') - Date.parse(todayStr + 'T00:00:00Z')) / 86400000
  );
  if (stage !== null && stage >= 10) {
    return days < 0 ? 'late' : 'ready';
  }
  const need = leadTimeNeeded(stage);
  if (days < need) return 'risk';
  if (days < need * 1.75) return 'tight';
  return 'ok';
}

async function queryBoard(board) {
  const out = [];
  let cursor = undefined;
  for (let page = 0; page < 8; page++) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(NOTION + '/data_sources/' + board.ds + '/query', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(board.creator + ' ' + res.status + ' ' + text.slice(0, 200));
    }
    const json = await res.json();
    for (const row of json.results || []) out.push(row);
    if (!json.has_more) break;
    cursor = json.next_cursor;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!process.env.NOTION_TOKEN) {
    return res.status(500).json({ error: 'NOTION_TOKEN is not set' });
  }

  const fresh = req.query && (req.query.fresh === '1' || req.query.fresh === 'true');
  if (!fresh && cache.data && Date.now() - cache.at < TTL) {
    res.setHeader('X-Cache', 'hit');
    return res.status(200).json(cache.data);
  }

  const today = new Date().toISOString().slice(0, 10);
  const videos = [];
  const errors = [];

  const results = await Promise.allSettled(
    BOARDS.map(async board => {
      const rows = await queryBoard(board);
      return { board, rows };
    })
  );

  for (const r of results) {
    if (r.status === 'rejected') {
      errors.push(String(r.reason && r.reason.message ? r.reason.message : r.reason));
      continue;
    }
    const { board, rows } = r.value;
    for (const row of rows) {
      const props = row.properties || {};
      const status = readStatus(props);
      if (isArchived(status)) continue;
      const title = readTitle(props);
      if (!title) continue;
      const stage = stageNumber(status);
      const date = readDate(props);
      videos.push({
        id: row.id,
        url: row.url || null,
        creator: board.creator,
        key: board.key,
        title,
        status,
        stage,
        date,
        editor: readEditor(props),
        type: readType(props),
        sponsor: /sponsor/i.test(readType(props)),
        risk: riskOf(stage, status, date, today)
      });
    }
  }

  const scheduled = videos.filter(v => v.date);
  const unscheduled = videos.filter(v => !v.date && (v.stage === null || v.stage < 12));

  const payload = {
    today,
    generatedAt: new Date().toISOString(),
    creators: BOARDS.map(b => ({ creator: b.creator, key: b.key })),
    editors: Array.from(new Set(videos.map(v => v.editor).filter(Boolean))).sort(),
    videos: scheduled,
    unscheduled,
    counts: {
      atRisk: scheduled.filter(v => v.risk === 'risk').length,
      late: scheduled.filter(v => v.risk === 'late').length,
      unscheduled: unscheduled.length
    },
    errors
  };

  cache = { at: Date.now(), data: payload };
  res.setHeader('X-Cache', 'miss');
  return res.status(200).json(payload);
}
