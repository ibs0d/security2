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
    const teamId = Number(req.params.teamId);
    if (!Number.isInteger(teamId) || teamId < 1) {
      return res.status(400).json({ error: 'Некорректный teamId' });
    }

    const [incident1, incident2] = await Promise.all([
      fs.readFile(path.join(SCENARIOS_DIR, `team${teamId}-1.txt`), 'utf-8'),
      fs.readFile(path.join(SCENARIOS_DIR, `team${teamId}-2.txt`), 'utf-8')
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
    const { teamId, answers1, answers2 } = req.body || {};
    if (!teamId || !answers1 || !answers2) {
      return res.status(400).json({ error: 'Недостаточно данных для отправки' });
    }

    const all = await readJson(SUBMISSIONS_FILE, []);
    all.push({
      timestamp: new Date().toISOString(),
      teamId: Number(teamId),
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

app.delete('/api/submissions', adminAuth, async (_req, res) => {
  try {
    await writeJson(SUBMISSIONS_FILE, []);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка очистки отправок' });
  }
});

app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/quiz', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'quiz.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`IB Quiz server started on http://localhost:${PORT}`);
});
