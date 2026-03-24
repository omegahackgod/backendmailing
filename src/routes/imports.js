// src/routes/imports.js
const router  = require('express').Router();
const multer  = require('multer');
const { parse } = require('csv-parse/sync');
const { prisma } = require('../lib/prisma');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.use(requireAuth);

// multer — memória (sem disco)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_, file, cb) => {
    if (file.originalname.match(/\.(csv|txt)$/i)) cb(null, true);
    else cb(new Error('Apenas CSV e TXT são aceitos'));
  },
});

// ── POST /api/imports ─────────────────────────
router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });

    const { estado } = req.body; // SC | PR | SP
    if (!['SC', 'PR', 'SP'].includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido. Use SC, PR ou SP.' });
    }

    const text    = req.file.buffer.toString('utf-8');
    const filename = req.file.originalname;
    const isTxt   = filename.toLowerCase().endsWith('.txt');

    const rawContacts = isTxt
      ? parseTXT(text, filename)
      : parseCSV(text, filename);

    if (!rawContacts.length) {
      return res.status(400).json({ error: 'Arquivo vazio ou formato não reconhecido' });
    }

    // Deduplicação: checa contra o banco E dentro do arquivo
    const normalized = rawContacts.map(c => ({
      ...c,
      estado,
      score: scoreContact(c),
      status: 'PENDENTE',
    }));

    // Detecta duplicatas dentro do lote
    const seenInBatch = new Map();
    normalized.forEach(c => {
      const key = normalizeKey(c.estado + c.nome + (c.telefone || ''));
      if (seenInBatch.has(key)) {
        c.isDuplicate = true;
        c.duplicateOf = seenInBatch.get(key);
      } else {
        seenInBatch.set(key, c.nome);
        c.isDuplicate = false;
      }
    });

    // Detecta duplicatas contra banco
    const existingPhones = await prisma.contact.findMany({
      where: {
        estado,
        telefone: { in: normalized.map(c => c.telefone).filter(Boolean) },
      },
      select: { telefone: true, nome: true },
    });
    const existingSet = new Set(existingPhones.map(c => normalizeKey(c.estado + c.nome + (c.telefone || ''))));

    normalized.forEach(c => {
      const key = normalizeKey(c.estado + c.nome + (c.telefone || ''));
      if (existingSet.has(key)) c.isDuplicate = true;
    });

    const valid  = normalized.filter(c => !c.isDuplicate).length;
    const dups   = normalized.filter(c => c.isDuplicate).length;

    // Salva importação e contatos
    const imp = await prisma.import.create({
      data: {
        filename,
        estado,
        totalRows: normalized.length,
        validRows: valid,
        dupRows: dups,
        userId: req.user.id,
        contacts: {
          createMany: {
            data: normalized.map(c => ({
              nome:       c.nome,
              tipo:       c.tipo || null,
              cidade:     c.cidade || null,
              estado:     c.estado,
              telefone:   c.telefone || null,
              email:      c.email || null,
              fonte:      c.fonte || null,
              score:      c.score,
              status:     'PENDENTE',
              obs:        c.obs || null,
              origem:     filename,
              isDuplicate: c.isDuplicate,
              duplicateOf: c.duplicateOf || null,
            })),
            skipDuplicates: false,
          },
        },
      },
    });

    res.json({
      ok: true,
      importId: imp.id,
      total: normalized.length,
      valid,
      duplicates: dups,
    });
  } catch (err) { next(err); }
});

// ── GET /api/imports ──────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const imports = await prisma.import.findMany({
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { name: true } }, _count: { select: { contacts: true } } },
    });
    res.json({ data: imports });
  } catch (err) { next(err); }
});

// ── DELETE /api/imports/:id ───────────────────
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    // cascade delete contacts first
    await prisma.contactUpdate.deleteMany({
      where: { contact: { importId: req.params.id } },
    });
    await prisma.contact.deleteMany({ where: { importId: req.params.id } });
    await prisma.import.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ══════════════════════════════════
//  PARSERS
// ══════════════════════════════════
function parseCSV(text, filename) {
  try {
    const records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
    return records.map(r => normalizeContact(r, filename)).filter(c => c.nome);
  } catch {
    // fallback manual
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
    return lines.slice(1).map(line => {
      const cols = splitCSVLine(line);
      const obj = {};
      headers.forEach((h, i) => obj[h] = (cols[i] || '').trim().replace(/^"|"$/g, ''));
      return normalizeContact(obj, filename);
    }).filter(c => c.nome);
  }
}

function parseTXT(text, filename) {
  return text.split(/\n\s*\n/).filter(b => b.trim()).map(block => {
    const obj = {};
    block.split('\n').forEach(line => {
      const m = line.match(/^([^:]+):\s*(.+)$/);
      if (m) obj[m[1].trim().toLowerCase()] = m[2].trim();
    });
    return normalizeContact(obj, filename);
  }).filter(c => c.nome);
}

function normalizeContact(obj, filename) {
  const get = (...keys) => {
    for (const k of keys) {
      for (const ok of Object.keys(obj)) {
        if (ok.toLowerCase().replace(/[^a-z]/g,'') === k.replace(/[^a-z]/g,'')) return obj[ok] || '';
      }
    }
    return '';
  };

  const email = cleanEmail(get('email', 'email'));
  const telefone = cleanPhone(get('telefone', 'phone', 'fone', 'tel', 'contato'));
  const nome = (get('nome', 'name') || '').trim();

  return {
    nome,
    tipo:     get('tipo', 'categoria', 'category') || null,
    cidade:   get('cidade', 'cidade_bairro', 'city', 'bairro') || null,
    telefone: telefone || null,
    email:    email || null,
    fonte:    get('fonte', 'source') || filename,
    obs:      get('observação', 'observacao', 'obs') || null,
  };
}

function splitCSVLine(line) {
  const r = []; let cur = '', inQ = false;
  for (const c of line) {
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { r.push(cur); cur = ''; }
    else cur += c;
  }
  r.push(cur);
  return r;
}

function cleanEmail(e) {
  if (!e) return '';
  e = e.trim().toLowerCase();
  if (['não disponível','nao disponivel','-','n/a'].includes(e)) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

function cleanPhone(p) {
  if (!p) return '';
  p = p.trim();
  if (['Não disponível','nao disponivel','-','n/a'].includes(p.toLowerCase())) return '';
  const digits = p.replace(/\D/g, '');
  return digits.length >= 8 ? p : '';
}

function normalizeKey(s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }

function scoreContact(c) {
  let s = 0;
  if (c.email)    s += 30;
  if (c.telefone) s += 25;
  if (c.nome && c.nome.length > 3) s += 15;
  if (c.cidade)   s += 10;
  if (c.tipo)     s += 10;
  if (c.obs)      s += 10;
  return Math.min(100, s);
}

module.exports = router;
