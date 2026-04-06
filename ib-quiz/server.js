const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const SCENARIOS_DIR = path.join(ROOT, 'scenarios');
const CONFIG_DIR = path.join(ROOT, 'config');
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

const TEAMS_FILE = path.join(CONFIG_DIR, 'teams.json');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');
const ANSWER_KEYS_DIR = path.join(CONFIG_DIR, 'answer-keys');

const teamProgress = {};
const sseClients = new Set();

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== null) {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function parseSimpleYaml(yamlText) {
  const root = {};
  const stack = [{ indent: -1, value: root }];

  const lines = yamlText.split('\n');
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = rawLine.match(/^\s*/)[0].length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].value;
    const keyValueMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!keyValueMatch) continue;

    const key = keyValueMatch[1].trim().replace(/^"(.*)"$/, '$1');
    const rawValue = keyValueMatch[2];

    if (rawValue === '') {
      current[key] = {};
      stack.push({ indent, value: current[key] });
      continue;
    }

    const unquotedValue = rawValue.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    current[key] = unquotedValue;
  }

  return root;
}

async function readTeamAnswerKey(teamId) {
  const yamlPath = path.join(ANSWER_KEYS_DIR, `team${teamId}.yaml`);
  const yamlRaw = await fs.readFile(yamlPath, 'utf-8');
  return parseSimpleYaml(yamlRaw);
}

function getAdminToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice(7).trim();
}

function adminAuth(req, res, next) {
  const token = getAdminToken(req);
  if (token !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Неавторизовано' });
  }
  return next();
}

app.get('/api/scenarios/:teamId', async (req, res) => {
  try {
    const raw = req.params.teamId;
    const prefix = raw === 'demo' ? 'demo' : `team${Number(raw)}`;

    if (raw !== 'demo') {
      const teamId = Number(raw);
      if (!Number.isInteger(teamId) || teamId < 1) {
        return res.status(400).json({ error: 'Некорректный teamId' });
      }
    }

    const [incident1, incident2] = await Promise.all([
      fs.readFile(path.join(SCENARIOS_DIR, `${prefix}-1.txt`), 'utf-8'),
      fs.readFile(path.join(SCENARIOS_DIR, `${prefix}-2.txt`), 'utf-8')
    ]);

    return res.json({
      incident1: incident1.trim(),
      incident2: incident2.trim()
    });
  } catch (error) {
    return res.status(404).json({ error: 'Сценарии не найдены' });
  }
});

app.post('/api/verify-pin', async (req, res) => {
  try {
    const { teamId, pin } = req.body || {};
    const config = await readJson(TEAMS_FILE, { teams: [] });
    const team = config.teams.find((item) => item.id === Number(teamId));
    const ok = Boolean(team && String(team.pin) === String(pin));
    return res.json({ ok });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Ошибка проверки PIN' });
  }
});

app.post('/api/submit', async (req, res) => {
  try {
    const { teamId, personData, personData1, personData2, answers1, answers2 } = req.body || {};
    const normalizedPersonData1 = personData1 || personData;
    const normalizedPersonData2 = personData2 || personData;
    if (!teamId || !normalizedPersonData1 || !normalizedPersonData2 || !answers1 || !answers2) {
      return res.status(400).json({ error: 'Недостаточно данных для отправки' });
    }

    const all = await readJson(SUBMISSIONS_FILE, []);
    all.push({
      timestamp: new Date().toISOString(),
      teamId: Number(teamId),
      personData1: normalizedPersonData1,
      personData2: normalizedPersonData2,
      answers1,
      answers2
    });

    await writeJson(SUBMISSIONS_FILE, all);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка сохранения ответа' });
  }
});

app.get('/api/submissions', adminAuth, async (_req, res) => {
  try {
    const all = await readJson(SUBMISSIONS_FILE, []);
    return res.json(all);
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка чтения отправок' });
  }
});

app.get('/api/answer-keys/:teamId', adminAuth, async (req, res) => {
  try {
    const teamId = Number(req.params.teamId);
    if (!Number.isInteger(teamId) || teamId < 1) {
      return res.status(400).json({ error: 'Некорректный teamId' });
    }

    const answerKey = await readTeamAnswerKey(teamId);
    return res.json(answerKey);
  } catch (error) {
    return res.status(404).json({ error: 'Файл ответов не найден' });
  }
});

app.delete('/api/submissions', adminAuth, async (_req, res) => {
  try {
    await writeJson(SUBMISSIONS_FILE, []);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка очистки отправок' });
  }
});

app.post('/api/progress', (req, res) => {
  const { teamId, filled, total } = req.body || {};
  const id = Number(teamId);
  if (!id || typeof filled !== 'number' || typeof total !== 'number') {
    return res.status(400).json({ error: 'Некорректные данные прогресса' });
  }
  teamProgress[id] = { filled, total, percent: total > 0 ? Math.round((filled / total) * 100) : 0, updatedAt: Date.now() };

  const payload = `data: ${JSON.stringify(teamProgress)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }

  return res.json({ ok: true });
});

app.get('/api/progress', (_req, res) => {
  return res.json(teamProgress);
});

app.get('/api/progress/stream', (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write(`data: ${JSON.stringify(teamProgress)}\n\n`);
  sseClients.add(res);
  _req.on('close', () => sseClients.delete(res));
});

app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/quiz', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'quiz.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));

app.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`IB Quiz server started on http://0.0.0.0:${PORT}`);
});
